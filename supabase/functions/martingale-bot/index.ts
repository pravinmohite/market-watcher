import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const LOT_SIZE = 65;
const DEFAULT_PROFIT_TARGET_PCT = 2.5;
const DEFAULT_STOP_LOSS_PCT = 1.5;
const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_DAILY_LOSS_LIMIT = 12000;
const ORDER_FILL_MAX_RETRIES = 3;
const ORDER_FILL_CHECK_INTERVAL_MS = 8000;
const ORDER_FILL_MAX_CHECKS = 3;
const PAUSE_DURATION_MS = 10 * 60 * 1000;
//const SIDEWAYS_PAUSE_DURATION_MS = 15 * 60 * 1000; // 15 min pause after sideways skip
//const SIDEWAYS_MIN_ROUND = 3; // Only gate entry from R3 onwards
//const SIDEWAYS_NIFTY_RANGE_THRESHOLD = 50; // Nifty range < 50pts in session = sideways (initial gate)
const SIDEWAYS_RECHECK_THRESHOLD = 30; // Nifty must move 30pts from pause spot to resume
const SIDEWAYS_PREMIUM_DECLINE_RATIO = 0.97; // Both premiums down >3% from R1 = decay

// --- Configuration Constants (NEW) ---
const SIDEWAYS_NIFTY_RANGE_THRESHOLD = 25;  // pts (strong decay)
const SIDEWAYS_NIFTY_RANGE_THRESHOLD_WEAK = 30;  // pts (mild decay)
const SIDEWAYS_PREMIUM_DECAY_STRONG = 0.94;
const SIDEWAYS_PREMIUM_DECAY_WEAK = 0.97;
const MIN_OPTION_PREMIUM = 80;   // ignore options cheaper than this
const RECENT_TRADES_WINDOW = 5;  // use last 5 trades for range
const SIDEWAYS_TICK_RANGE_WINDOW_MS = 5 * 60 * 1000; // prefer last 5m premium-tick spots
const SIDEWAYS_STRIKE_SHIFT_TOLERANCE = 100; // points allowed between anchor and current OTM strikes
const SIDEWAYS_PAUSE_DURATION_MS = 15 * 60 * 1000;
const SIDEWAYS_MIN_ROUND = 3;
const SIDEWAYS_PAUSE_DURATION_MIN = SIDEWAYS_PAUSE_DURATION_MS / 60000;

/** Mode 1 — one session/day, max R2, morning only (see strategy_mode bot_setting). */
const STRATEGY_MARTINGALE = 'martingale';
const STRATEGY_SNIPER = 'sniper';
const SNIPER_MAX_ROUNDS = 2;
const SNIPER_WINDOW_START_MIN = 9 * 60 + 35; // 9:35 IST
const SNIPER_WINDOW_END_MIN = 11 * 60 + 0; // 11:00 IST
const SNIPER_SESSION_LOSS_CAP_DEFAULT = 1200;
const SNIPER_DAILY_LOSS_LIMIT_DEFAULT = 3000;

function parsePositiveFloat(val: unknown, fallback: number): number {
  const n = typeof val === 'string' || typeof val === 'number' ? parseFloat(String(val)) : NaN;
  return !Number.isNaN(n) && n > 0 ? n : fallback;
}

async function loadBotSettingsMap(supabase: any): Promise<Record<string, string>> {
  const { data } = await supabase.from('bot_settings').select('key, value');
  const map: Record<string, string> = {};
  for (const row of data || []) {
    if (row?.key) map[row.key] = String(row.value ?? '');
  }
  return map;
}

async function getProfitTargetPct(supabase: any): Promise<number> {
  const map = await loadBotSettingsMap(supabase);
  return parsePositiveFloat(map.profit_target_pct, DEFAULT_PROFIT_TARGET_PCT);
}

async function getStopLossPct(supabase: any): Promise<number> {
  const map = await loadBotSettingsMap(supabase);
  return parsePositiveFloat(map.stop_loss_pct, DEFAULT_STOP_LOSS_PCT);
}

async function getSniperSessionLossCap(supabase: any): Promise<number> {
  const map = await loadBotSettingsMap(supabase);
  const n = parsePositiveFloat(map.sniper_session_loss_cap, SNIPER_SESSION_LOSS_CAP_DEFAULT);
  return Math.round(n);
}

async function getSniperDailyLossLimit(supabase: any): Promise<number> {
  const map = await loadBotSettingsMap(supabase);
  const sniper = parsePositiveFloat(map.sniper_daily_loss_limit, 0);
  if (sniper > 0) return Math.round(sniper);
  const shared = parsePositiveFloat(map.daily_loss_limit, SNIPER_DAILY_LOSS_LIMIT_DEFAULT);
  return Math.round(shared);
}

async function getBotConfigForStatus(supabase: any): Promise<Record<string, unknown>> {
  const map = await loadBotSettingsMap(supabase);
  const strategyMode = normalizeStrategyMode(map.strategy_mode);
  return {
    strategy_mode: strategyMode,
    trading_mode: map.trading_mode === 'actual' ? 'actual' : 'paper',
    max_rounds: Math.min(10, Math.max(1, parseInt(map.max_rounds || String(DEFAULT_MAX_ROUNDS), 10) || DEFAULT_MAX_ROUNDS)),
    profit_target_pct: parsePositiveFloat(map.profit_target_pct, DEFAULT_PROFIT_TARGET_PCT),
    stop_loss_pct: parsePositiveFloat(map.stop_loss_pct, DEFAULT_STOP_LOSS_PCT),
    daily_loss_limit: Math.round(parsePositiveFloat(map.daily_loss_limit, DEFAULT_DAILY_LOSS_LIMIT)),
    sniper_session_loss_cap: Math.round(parsePositiveFloat(map.sniper_session_loss_cap, SNIPER_SESSION_LOSS_CAP_DEFAULT)),
    sniper_daily_loss_limit: Math.round(
      parsePositiveFloat(map.sniper_daily_loss_limit, SNIPER_DAILY_LOSS_LIMIT_DEFAULT),
    ),
    sniper_window_ist: '9:35–11:00',
    sniper_max_rounds: SNIPER_MAX_ROUNDS,
  };
}

async function countSessionsTodayIst(supabase: any): Promise<number> {
  const todayUTC = istTodayUtcStart();
  const { count, error } = await supabase
    .from('martingale_sessions')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', todayUTC.toISOString());
  if (error) {
    console.error('countSessionsTodayIst:', error);
    return 0;
  }
  return count ?? 0;
}

function normalizeStrategyMode(raw: string | null | undefined): string {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === STRATEGY_SNIPER ? STRATEGY_SNIPER : STRATEGY_MARTINGALE;
}

async function getStrategyMode(supabase: any): Promise<string> {
  const { data } = await supabase.from('bot_settings').select('value').eq('key', 'strategy_mode').maybeSingle();
  return normalizeStrategyMode(data?.value);
}

function isSniperStrategy(mode: string): boolean {
  return normalizeStrategyMode(mode) === STRATEGY_SNIPER;
}

/** Entry tags that only martingale strategy may create. */
function isMartingaleOnlyEntryTag(tag: string): boolean {
  const t = String(tag ?? '');
  return (
    t === 'martingale_flip_after_loss_round' ||
    t === 'fresh_r1_after_take_profit_auto_chain' ||
    t === 'session_start_carry_direction_from_prior' ||
    t === 'session_start_first_trend_ce_pe' ||
    t.startsWith('martingale_')
  );
}

/** When bot_settings.strategy_mode is sniper, martingale must not run. */
async function rejectMartingaleWhenSniperSelected(supabase: any): Promise<string | null> {
  if (!isSniperStrategy(await getStrategyMode(supabase))) return null;
  return 'Sniper daily is selected — martingale is disabled. Only 9:35–11:00 IST, max R2.';
}

function sniperInTradingWindow(timeMin: number): boolean {
  return timeMin >= SNIPER_WINDOW_START_MIN && timeMin < SNIPER_WINDOW_END_MIN;
}

/** Martingale only: 9:25–11:15 and 14:30–15:25 IST (afternoon disabled on Tuesday expiry). */
function martingaleInTradingWindow(timeMin: number, dayOfWeek: number): boolean {
  const isExpiryDay = dayOfWeek === 2;
  const inW1 = timeMin >= 9 * 60 + 25 && timeMin <= 11 * 60 + 15;
  const inW2 = !isExpiryDay && timeMin >= 14 * 60 + 30 && timeMin <= 15 * 60 + 25;
  return inW1 || inW2;
}

function nextWindowHint(strategy: string, timeMin: number): string {
  if (isSniperStrategy(strategy)) {
    return timeMin < SNIPER_WINDOW_START_MIN ? '9:35 AM today' : 'tomorrow 9:35 AM';
  }
  if (timeMin < 9 * 60 + 25) return '9:25 AM today';
  if (timeMin < 14 * 60 + 30) return '2:30 PM today';
  return 'tomorrow 9:25 AM';
}

function istTodayUtcStart(): Date {
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const todayStart = new Date(nowIST);
  todayStart.setHours(0, 0, 0, 0);
  return new Date(todayStart.getTime() - 5.5 * 60 * 60 * 1000);
}

/** True only if a sniper session exists today (martingale sessions do not block sniper). */
async function sessionIsSniper(supabase: any, sessionId: string): Promise<boolean> {
  const { data: sess } = await supabase
    .from('martingale_sessions')
    .select('strategy_mode, max_rounds')
    .eq('id', sessionId)
    .maybeSingle();
  if (sess?.strategy_mode) {
    return normalizeStrategyMode(sess.strategy_mode) === STRATEGY_SNIPER;
  }
  const { data: r1 } = await supabase
    .from('martingale_trades')
    .select('entry_reason_tag')
    .eq('session_id', sessionId)
    .eq('round', 1)
    .limit(1)
    .maybeSingle();
  const tag = String(r1?.entry_reason_tag ?? '');
  if (tag.startsWith('sniper_')) return true;
  return Number(sess?.max_rounds) === SNIPER_MAX_ROUNDS && tag.length > 0;
}

async function countSniperSessionsTodayIst(supabase: any): Promise<number> {
  const todayUTC = istTodayUtcStart();
  const { data: sessions, error } = await supabase
    .from('martingale_sessions')
    .select('id, strategy_mode')
    .gte('created_at', todayUTC.toISOString());
  if (error) {
    console.error('countSniperSessionsTodayIst:', error);
    return 0;
  }
  let n = 0;
  for (const s of sessions || []) {
    if (normalizeStrategyMode(s.strategy_mode) === STRATEGY_SNIPER) {
      n++;
      continue;
    }
    if (await sessionIsSniper(supabase, s.id)) n++;
  }
  return n;
}

async function sniperHasSessionToday(supabase: any): Promise<boolean> {
  return (await countSniperSessionsTodayIst(supabase)) > 0;
}

/** When bot_settings is sniper, square off any active martingale session and clear martingale chains. */
async function haltMartingaleSessionsForSniperMode(
  supabase: any,
  supabaseUrl: string,
  anonKey: string,
): Promise<string | null> {
  const globalMode = await getStrategyMode(supabase);
  if (!isSniperStrategy(globalMode)) return null;

  const { data: activeList } = await supabase
    .from('martingale_sessions')
    .select('*')
    .eq('status', 'active');

  const halted: string[] = [];
  for (const sess of activeList || []) {
    if (await sessionIsSniper(supabase, sess.id)) continue;

    const { data: openTrade } = await supabase
      .from('martingale_trades')
      .select('*')
      .eq('session_id', sess.id)
      .eq('status', 'open')
      .maybeSingle();

    if (openTrade) {
      const { specificPrice: exitPrice, specificInstrumentKey: instrKey } = await fetchNiftyOptionChain(
        supabaseUrl,
        anonKey,
        openTrade.strike_price,
        openTrade.option_type,
        openTrade.nifty_spot,
        openTrade.entry_price,
      );
      const px = exitPrice !== null ? exitPrice : openTrade.entry_price;
      const pnl = (px - openTrade.entry_price) * openTrade.lots * LOT_SIZE;
      if (sess.trading_mode === 'actual') {
        const accessToken = await getUpstoxToken(supabase);
        if (accessToken && instrKey) {
          await placeUpstoxOrder(accessToken, {
            instrumentKey: instrKey,
            quantity: openTrade.lots * LOT_SIZE,
            transactionType: 'SELL',
            price: px,
          });
        }
      }
      const exitIso = new Date().toISOString();
      await supabase.from('martingale_trades').update(
        finalizeTradeClosePatch(openTrade, px, exitIso, pnl, 'sniper_mode_halt_martingale_session'),
      ).eq('id', openTrade.id);
      await supabase.from('martingale_sessions').update({
        status: 'stopped_sniper_mode',
        total_pnl: (Number(sess.total_pnl) || 0) + pnl,
        completed_at: exitIso,
      }).eq('id', sess.id);
    } else {
      await supabase.from('martingale_sessions').update({
        status: 'stopped_sniper_mode',
        completed_at: new Date().toISOString(),
      }).eq('id', sess.id);
    }
    halted.push(sess.id);
  }

  if (halted.length > 0) {
    await stopSniperBotForDay(supabase);
    return `Sniper mode: halted ${halted.length} martingale session(s) — only sniper daily runs.`;
  }
  return null;
}

/** Block worst bucket from sample: long CE when spot trend is up. */
function sniperLegBlocked(optionType: string, trend: string): boolean {
  return trend === 'up' && optionType === 'CE';
}

async function stopSniperBotForDay(supabase: any): Promise<void> {
  await supabase.from('bot_settings').upsert(
    { key: 'bot_running', value: 'false', updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
}

function isIstMarketDay(nowIST: Date, holidays: string[]): boolean {
  const day = nowIST.getDay();
  const ymd = `${nowIST.getFullYear()}-${String(nowIST.getMonth() + 1).padStart(2, '0')}-${String(nowIST.getDate()).padStart(2, '0')}`;
  return day !== 0 && day !== 6 && !holidays.includes(ymd);
}

const NSE_HOLIDAYS_SCHED: string[] = [
  '2025-02-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14', '2025-04-18', '2025-05-01', '2025-08-12', '2025-08-15', '2025-08-27', '2025-10-02', '2025-10-20', '2025-10-21', '2025-11-05', '2025-12-25',
  '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
];

/** Sniper: enable polling + auto-start first session of the day (cron or UI tick every ~15s). */
async function trySniperAutoStartIfNeeded(
  supabase: any,
  supabaseUrl: string,
  anonKey: string,
): Promise<string | null> {
  const strategy = await getStrategyMode(supabase);
  if (!isSniperStrategy(strategy)) return null;

  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const tickTime = nowIST.getHours() * 60 + nowIST.getMinutes();
  if (!isIstMarketDay(nowIST, NSE_HOLIDAYS_SCHED) || !sniperInTradingWindow(tickTime)) return null;

  const dailyPnl = await getDailyPnl(supabase);
  const dailyCap = await getSniperDailyLossLimit(supabase);
  if (dailyPnl <= -dailyCap) return 'Sniper: daily loss cap hit — no auto-start.';

  await supabase.from('bot_settings').upsert(
    { key: 'bot_running', value: 'true', updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );

  const { data: activeSession } = await supabase
    .from('martingale_sessions')
    .select('id')
    .eq('status', 'active')
    .maybeSingle();
  if (activeSession) return null;

  if (await sniperHasSessionToday(supabase)) {
    return 'Sniper: today\'s sniper session already used (martingale sessions earlier do not count).';
  }

  const { optionData: od } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
  const sidewaysPause = await isInSidewaysPause(
    supabase,
    '',
    od?.niftySpot ?? 0,
    supabaseUrl,
    anonKey,
    od?.otmCEPrice,
    od?.otmPEPrice,
    od?.otmCEStrike,
    od?.otmPEStrike,
  );
  if (sidewaysPause.paused) {
    return `Sniper auto-start skipped — sideways pause (${sidewaysPause.remainingMins} min).`;
  }

  const { data: settings } = await supabase.from('bot_settings').select('key, value');
  let savedMode = 'paper';
  if (settings) {
    for (const s of settings) {
      if (s.key === 'trading_mode') savedMode = s.value;
    }
  }

  const startRes = await fetch(`${supabaseUrl}/functions/v1/martingale-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
    body: JSON.stringify({
      action: 'start',
      trading_mode: savedMode,
      max_rounds: SNIPER_MAX_ROUNDS,
      strategy_mode: STRATEGY_SNIPER,
      skip_decay_check: true,
    }),
  });
  const startData = await startRes.json();
  if (startData.success) {
    await sendTelegram(`⏰ *Sniper Auto-Start*\n${startData.message || 'Session started in 9:35–11:00 window'}`);
    return `Sniper auto-started: ${startData.message || 'ok'}`;
  }
  return `Sniper auto-start failed: ${startData.message || JSON.stringify(startData)}`;
}

async function completeSniperSession(
  supabase: any,
  sessionId: string,
  status: string,
  sessionTotalPnl: number,
  currentRound?: number,
): Promise<void> {
  await supabase
    .from('martingale_sessions')
    .update({
      status,
      total_pnl: sessionTotalPnl,
      completed_at: new Date().toISOString(),
      ...(currentRound != null ? { current_round: currentRound } : {}),
    })
    .eq('id', sessionId);
  await stopSniperBotForDay(supabase);
}

type SidewaysGateEval = {
  gate_round: number;
  last_two_losses: boolean;
  nifty_range_pts: number;
  range_window_trades: number;
  thresholds: {
    strong_decay_ratio: number;
    weak_decay_ratio: number;
    strong_range_lt: number;
    weak_range_lt: number;
  };
  anchor_ce: number | null;
  anchor_pe: number | null;
  current_ce: number | null;
  current_pe: number | null;
  ce_ratio: number | null;
  pe_ratio: number | null;
  range_source: 'premium_ticks' | 'trade_spots' | 'none';
  anchor_ce_strike: number | null;
  anchor_pe_strike: number | null;
  current_ce_strike: number | null;
  current_pe_strike: number | null;
  strike_consistent: boolean;
  strong_double_decay: boolean;
  mild_double_decay: boolean;
  skip_decision: boolean;
};


async function getDailyPnl(supabase: any): Promise<number> {
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const todayStart = new Date(nowIST);
  todayStart.setHours(0, 0, 0, 0);
  const todayUTC = new Date(todayStart.getTime() - (5.5 * 60 * 60 * 1000));

  const { data: todaySessions } = await supabase
    .from('martingale_sessions')
    .select('id, total_pnl, status')
    .gte('created_at', todayUTC.toISOString())
    .neq('status', 'active');

  let dailyPnl = 0;
  if (todaySessions) {
    for (const s of todaySessions) {
      dailyPnl += Number(s.total_pnl) || 0;
    }
  }
  return dailyPnl;
}

async function getDailyLossLimit(supabase: any): Promise<number> {
  const { data } = await supabase
    .from('bot_settings')
    .select('value')
    .eq('key', 'daily_loss_limit')
    .maybeSingle();
  if (data?.value) {
    const val = parseInt(data.value);
    if (!isNaN(val) && val > 0) return val;
  }
  return DEFAULT_DAILY_LOSS_LIMIT;
}

interface OptionChainData {
  niftySpot: number;
  atmStrike: number;
  otmCEStrike: number;
  otmPEStrike: number;
  otmCEPrice: number;
  otmPEPrice: number;
  strikeDiff: number;
  source?: string;
  expiry?: string;
  otmCEInstrumentKey?: string;
  otmPEInstrumentKey?: string;
}

async function fetchNiftyOptionChain(supabaseUrl: string, anonKey: string, strike?: number, optionType?: string, entrySpot?: number, entryPrice?: number): Promise<{ optionData: OptionChainData | null; specificPrice: number | null; specificInstrumentKey: string | null }> {
  try {
    const body: any = { action: 'nifty-option-chain' };
    if (strike) body.strike = strike;
    if (optionType) body.optionType = optionType;
    if (entrySpot) body.entrySpot = entrySpot;
    if (entryPrice) body.entryPrice = entryPrice;

    const res = await fetch(`${supabaseUrl}/functions/v1/check-stock-alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}`, 'apikey': anonKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.error(`Proxy failed: ${res.status}`); await res.text(); return { optionData: null, specificPrice: null, specificInstrumentKey: null }; }
    const data = await res.json();
    if (!data.success) { console.error(`Proxy error: ${data.error}`); return { optionData: null, specificPrice: null, specificInstrumentKey: null }; }
    return {
      optionData: {
        niftySpot: data.niftySpot, atmStrike: data.atmStrike, otmCEStrike: data.otmCEStrike, otmPEStrike: data.otmPEStrike,
        otmCEPrice: data.otmCEPrice, otmPEPrice: data.otmPEPrice, strikeDiff: data.strikeDiff,
        source: data.source, expiry: data.expiry,
        otmCEInstrumentKey: data.otmCEInstrumentKey, otmPEInstrumentKey: data.otmPEInstrumentKey,
      },
      specificPrice: data.specificPrice,
      specificInstrumentKey: data.specificInstrumentKey || null,
    };
  } catch (error) { console.error("Option chain error:", error); return { optionData: null, specificPrice: null, specificInstrumentKey: null }; }
}

/** Minimum closed trades per segment before treating stats as actionable in daily reports */
const ANALYSIS_MIN_SEGMENT = 5;
const ANALYSIS_MIN_GLOBAL = 8;

/** Throttle DB writes: at most one snapshot per open trade per interval (UI/cron tick pacing ~15s). */
const PREMIUM_TICK_MIN_INTERVAL_MS = 15_000;

async function recordPremiumTickIfDue(
  supabase: any,
  params: {
    sessionId: string;
    tradeId: string;
    niftySpot: number;
    otmCEStrike: number;
    otmPEStrike: number;
    otmCEPremium: number;
    otmPEPremium: number;
    activeOptionType: string;
    activeStrike: number;
    activePremium: number;
    tickSource: string;
  },
): Promise<void> {
  const cutoffIso = new Date(Date.now() - PREMIUM_TICK_MIN_INTERVAL_MS).toISOString();
  const { data: recent } = await supabase
    .from('martingale_premium_ticks')
    .select('id')
    .eq('trade_id', params.tradeId)
    .gte('recorded_at', cutoffIso)
    .limit(1)
    .maybeSingle();

  if (recent) return;

  const { error } = await supabase.from('martingale_premium_ticks').insert({
    session_id: params.sessionId,
    trade_id: params.tradeId,
    nifty_spot: params.niftySpot,
    otm_ce_strike: params.otmCEStrike,
    otm_pe_strike: params.otmPEStrike,
    otm_ce_premium: params.otmCEPremium,
    otm_pe_premium: params.otmPEPremium,
    active_option_type: params.activeOptionType,
    active_strike: params.activeStrike,
    active_premium: params.activePremium,
    tick_source: params.tickSource,
  });
  if (error) console.error('martingale_premium_ticks:', error);
}

function getSessionBucketIST(d: Date): string {
  const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const m = ist.getHours() * 60 + ist.getMinutes();
  if (m < 9 * 60 + 15) return 'pre_open';
  if (m < 10 * 60 + 30) return 'open_morning';
  if (m < 11 * 60 + 20) return 'late_morning';
  if (m < 14 * 60 + 30) return 'midday_gap';
  if (m < 15 * 60 + 20) return 'afternoon';
  return 'close';
}

async function getStreakBeforeEntry(supabase: any, beforeIso: string): Promise<{ streak_wins_before: number; streak_losses_before: number }> {
  const { data } = await supabase
    .from('martingale_trades')
    .select('pnl')
    .eq('status', 'closed')
    .not('exit_time', 'is', null)
    .lt('exit_time', beforeIso)
    .order('exit_time', { ascending: false })
    .limit(120);

  if (!data?.length) return { streak_wins_before: 0, streak_losses_before: 0 };

  const first = Number(data[0].pnl) || 0;
  if (first === 0) return { streak_wins_before: 0, streak_losses_before: 0 };

  const wins = first > 0;
  let n = 0;
  for (const t of data) {
    const p = Number(t.pnl) || 0;
    if (wins && p > 0) n++;
    else if (!wins && p < 0) n++;
    else break;
  }
  return wins
    ? { streak_wins_before: n, streak_losses_before: 0 }
    : { streak_wins_before: 0, streak_losses_before: n };
}

async function fetchSessionSpotTrail(supabase: any, sessionId: string): Promise<number[]> {
  const { data } = await supabase
    .from('martingale_trades')
    .select('nifty_spot')
    .eq('session_id', sessionId)
    .order('entry_time', { ascending: true });
  return (data || []).map((t: any) => Number(t.nifty_spot)).filter((s: number) => s > 0);
}

function computeNiftyRangePts(spots: number[], currentSpot: number): number | null {
  if (spots.length === 0) return null;
  const all = [...spots, currentSpot].filter((s) => s > 0);
  if (!all.length) return null;
  return Math.max(...all) - Math.min(...all);
}

function classifyTrendVsAtm(spot: number, atmStrike: number): 'up' | 'down' | 'sideways' {
  const rel = atmStrike ? (spot - atmStrike) / atmStrike : 0;
  if (Math.abs(rel) < 0.00035) return 'sideways';
  return rel > 0 ? 'up' : 'down';
}

function buildEntryMarketSnapshot(
  niftySpot: number,
  atmStrike: number,
  priorSessionSpots: number[],
): {
  trend: 'up' | 'down' | 'sideways';
  nifty_range_session_pts: number | null;
  atr_proxy_pts: number | null;
  spot_vs_atm_pts: number;
  session_bucket_ist: string;
  rsi_14: null;
  ema_vwap_relation: string;
  volume_spike: null;
} {
  return {
    trend: classifyTrendVsAtm(niftySpot, atmStrike),
    nifty_range_session_pts: computeNiftyRangePts(priorSessionSpots, niftySpot),
    atr_proxy_pts: computeNiftyRangePts(priorSessionSpots, niftySpot),
    spot_vs_atm_pts: Number((niftySpot - atmStrike).toFixed(2)),
    session_bucket_ist: getSessionBucketIST(new Date()),
    rsi_14: null,
    ema_vwap_relation: 'unknown',
    volume_spike: null,
  };
}

async function insertMartingaleOpenTrade(
  supabase: any,
  p: {
    session_id: string;
    round: number;
    option_type: string;
    strike_price: number;
    lots: number;
    entry_price: number;
    nifty_spot: number;
    atm_strike: number;
    symbol?: string;
    entry_reason_tag: string;
    sideways_gate_eval?: SidewaysGateEval;
  },
): Promise<{ error: any | null }> {
  if (isMartingaleOnlyEntryTag(p.entry_reason_tag)) {
    const blockMsg = await rejectMartingaleWhenSniperSelected(supabase);
    if (blockMsg) {
      console.error('insertMartingaleOpenTrade blocked:', blockMsg, p.entry_reason_tag);
      return { error: new Error(blockMsg) };
    }
  }

  const entryTimeIso = new Date().toISOString();
  const profitTargetPct = await getProfitTargetPct(supabase);
  const stopLossPct = await getStopLossPct(supabase);
  const streak = await getStreakBeforeEntry(supabase, entryTimeIso);
  const priorSpots = await fetchSessionSpotTrail(supabase, p.session_id);
  const market = buildEntryMarketSnapshot(p.nifty_spot, p.atm_strike, priorSpots);
  const symbol = p.symbol || 'NIFTY';
  const positionQty = p.lots * LOT_SIZE;

  const trade_log = {
    schema_version: 1,
    entry: {
      timestamp: entryTimeIso,
      symbol,
      trade_side: `${p.option_type}` as string,
      strike_price: p.strike_price,
      martingale_step: p.round,
      target_pct_snapshot: profitTargetPct,
      stop_loss_pct_snapshot: stopLossPct,
      target_pct_ui: `%+${profitTargetPct} TP / -${stopLossPct}% SL on premium`,
      market,
      entry_reason_rule_tag: p.entry_reason_tag,
      sideways_gate_eval: p.sideways_gate_eval ?? null,
      notes: 'RSI/VWAP not wired to live feed yet (null/unknown placeholders).',
    },
  };

  const { error } = await supabase.from('martingale_trades').insert({
    session_id: p.session_id,
    round: p.round,
    option_type: p.option_type,
    strike_price: p.strike_price,
    lots: p.lots,
    entry_price: p.entry_price,
    status: 'open',
    nifty_spot: p.nifty_spot,
    symbol,
    target_pct: profitTargetPct,
    stop_loss_pct: stopLossPct,
    position_qty: positionQty,
    streak_wins_before: streak.streak_wins_before,
    streak_losses_before: streak.streak_losses_before,
    trade_log,
  });
  return { error };
}

function finalizeTradeClosePatch(
  openTrade: any,
  exitPrice: number,
  exitTimeIso: string,
  pnlAmount: number,
  closeReason: string,
): Record<string, unknown> {
  const entryPx = Number(openTrade.entry_price) || 0;
  const pnlPctPremium = entryPx > 0 ? ((exitPrice - entryPx) / entryPx) * 100 : 0;
  const trade_result = pnlAmount > 0 ? 'win' : pnlAmount < 0 ? 'loss' : 'breakeven';
  const prevLog =
    typeof openTrade.trade_log === 'object' && openTrade.trade_log != null ? { ...openTrade.trade_log } : {};

  return {
    status: 'closed',
    exit_price: exitPrice,
    exit_time: exitTimeIso,
    pnl: pnlAmount,
    trade_result,
    pnl_pct: Number(pnlPctPremium.toFixed(4)),
    trade_log: {
      ...prevLog,
      exit: {
        timestamp: exitTimeIso,
        exit_price: exitPrice,
        close_reason: closeReason,
        pnl_inr: pnlAmount,
        pnl_pct_on_premium: Number(pnlPctPremium.toFixed(4)),
        trade_result,
      },
    },
  };
}

function istTradingDayUtcRange(ymd: string): { startIso: string; endIso: string } {
  return {
    startIso: `${ymd}T00:00:00.000+05:30`,
    endIso: `${ymd}T23:59:59.999+05:30`,
  };
}

/** IST calendar helpers (India has no DST; use Asia/Kolkata for labels). */
function istMidnightMs(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00+05:30`);
}

function istYmdFromMs(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms));
}

function weekdayMon0Sun6Ist(ms: number): number {
  const label = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(new Date(ms));
  const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return map[label] ?? 0;
}

/** Monday YYYY-MM-DD (IST week) containing `anchorYmd`. */
function mondayYmdContainingIst(anchorYmd: string): string {
  const ms = istMidnightMs(anchorYmd);
  const dow = weekdayMon0Sun6Ist(ms);
  return istYmdFromMs(ms - dow * 86400000);
}

/** Inclusive IST week Mon–Sun timestamps for Postgres filters. */
function istWeekInclusiveRange(mondayYmd: string): { week_start: string; week_end: string; startIso: string; endIso: string } {
  const monMs = istMidnightMs(mondayYmd);
  const sunMs = monMs + 6 * 86400000;
  const weekEnd = istYmdFromMs(sunMs);
  return {
    week_start: mondayYmd,
    week_end: weekEnd,
    startIso: `${mondayYmd}T00:00:00.000+05:30`,
    endIso: `${weekEnd}T23:59:59.999+05:30`,
  };
}

function previousCompletedWeekMondayYmd(): string {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const ymd = `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
  const thisMonday = mondayYmdContainingIst(ymd);
  return istYmdFromMs(istMidnightMs(thisMonday) - 7 * 86400000);
}

const ANALYSIS_WEEK_MIN_TRADES = 15;

function buildWeeklyExpertReview(args: {
  n: number;
  winRatePct: number;
  maxDd: number;
  distinctIstTradingDays: number;
  avgWin: number;
  avgLoss: number;
  byWeekday: Record<string, { wins: number; losses: number; pnl: number }>;
  byTrend: Record<string, { wins: number; losses: number; pnl: number }>;
  pnlByRound: Record<string, number>;
  premiumTickCount: number;
}): string[] {
  const lines: string[] = [];

  if (args.distinctIstTradingDays < 3) {
    lines.push(
      `Only ${args.distinctIstTradingDays} distinct day(s) with exits this week — after 2–3 days of full logging, re-run weekly analysis; avoid changing live parameters from a thin week.`,
    );
  }
  if (args.n < 8) {
    lines.push(
      `${args.n} closed trades in the window — directional stats are noisy; targeting ≥${ANALYSIS_WEEK_MIN_TRADES} weekly exits improves confidence before optimizing for profit.`,
    );
  } else if (args.n < ANALYSIS_WEEK_MIN_TRADES) {
    lines.push(`Sample size ${args.n} is usable for direction but still below ideal (${ANALYSIS_WEEK_MIN_TRADES}); confirm next week before aggressive rule changes.`);
  }

  if (args.avgWin > 0 && args.avgLoss < 0) {
    const lossMag = Math.abs(args.avgLoss);
    if (lossMag > args.avgWin * 1.45) {
      lines.push(
        'Average loser is materially larger than average winner — typical for leveraged martingale. Favor tightening max rounds / daily loss cap over adding size until loss distribution compresses.',
      );
    }
  }

  let worstWd: { k: string; wr: number; n: number } | null = null;
  for (const [k, seg] of Object.entries(args.byWeekday)) {
    const tot = seg.wins + seg.losses;
    if (tot < 4) continue;
    const wr = (100 * seg.wins) / tot;
    if (!worstWd || wr < worstWd.wr) worstWd = { k, wr, n: tot };
  }
  if (worstWd && worstWd.wr < 43) {
    lines.push(
      `Weakest weekday cluster: ${worstWd.k} (~${worstWd.wr.toFixed(0)}% win / ${worstWd.n} trades). If this repeats next week, test skipping bot auto-starts on that weekday profile.`,
    );
  }

  const sid = args.byTrend['sideways'];
  if (sid) {
    const tot = sid.wins + sid.losses;
    if (tot >= 6 && (100 * sid.wins) / tot < 44) {
      lines.push(
        'Entries tagged sideways trend underperform versus other buckets — aligns with premium decay in chop; your R3+ sideways gate may deserve more weight, not less.',
      );
    }
  }

  const roundKeys = Object.keys(args.pnlByRound).map((k) => Number(k)).filter((x) => !Number.isNaN(x)).sort((a, b) => b - a);
  if (roundKeys.length && roundKeys[0] >= 4) {
    const deep = roundKeys.filter((r) => r >= 4);
    let agg = 0;
    for (const r of deep) agg += args.pnlByRound[String(r)] ?? 0;
    if (agg < -2500 && deep.length > 0) {
      lines.push(
        'Deep martingale rounds (R4+) contribute disproportionate drag — explicitly cap rounds or require stronger directional filter before increasing depth.',
      );
    }
  }

  if (args.premiumTickCount >= 30) {
    lines.push(
      `Rich premium-tick tape (${args.premiumTickCount} snapshots) — in Analytics → Ticks, watch simultaneous CE/PE bleed vs one leg holding bid into spot moves before loss clusters.`,
    );
  } else if (args.premiumTickCount < 8 && args.n >= 5) {
    lines.push('Few CE/PE tick snapshots versus trade count — keep UI/cron ticking during open positions so weekly review can corroborate decay vs breakout narratives.');
  }

  if (args.winRatePct < 47 && args.n >= 12) {
    lines.push(
      subWeekWinRateReminder(args.winRatePct),
    );
  }

  lines.push(
    'Options caveat: buying OTM carries negative theta — high win-rate targets alone can hide bleed from gap/martingale bursts; prioritize survival (drawdown, round depth) over squeezing extra target %.',
  );

  return lines;
}

function subWeekWinRateReminder(wr: number): string {
  return `Week win rate ~${wr.toFixed(1)}% on sufficient sample — revisit take-profit tightness vs stop only after 2 comparable weeks; do not widen martingale blindly to chase positive expectancy.`;
}

async function persistDailyAnalysisReport(supabase: any, tradingDayYmd: string, report: Record<string, unknown>) {
  await supabase.from('martingale_daily_reports').upsert(
    { trading_day: tradingDayYmd, report },
    { onConflict: 'trading_day' },
  );
}

async function computeMartingaleDailyAnalysis(
  supabase: any,
  tradingDayYmd: string,
): Promise<Record<string, unknown>> {
  const { startIso, endIso } = istTradingDayUtcRange(tradingDayYmd);
  const { data: trades, error } = await supabase
    .from('martingale_trades')
    .select('id, round, option_type, pnl, entry_price, exit_price, exit_time, trade_result, trade_log, pnl_pct')
    .eq('status', 'closed')
    .gte('exit_time', startIso)
    .lte('exit_time', endIso)
    .order('exit_time', { ascending: true });

  if (error) throw error;

  const rows = trades || [];
  const closedWithPnl = rows.filter((t: any) => t.pnl != null && t.exit_time);
  const n = closedWithPnl.length;

  const wins = closedWithPnl.filter((t: any) => Number(t.pnl) > 0);
  const losses = closedWithPnl.filter((t: any) => Number(t.pnl) < 0);
  const winRatePct = n > 0 ? (100 * wins.length) / n : 0;

  const avgWin = wins.length ? wins.reduce((s: number, t: any) => s + Number(t.pnl), 0) / wins.length : 0;

  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  let runLoss = 0;
  let maxLossStreak = 0;
  for (const t of closedWithPnl) {
    const p = Number(t.pnl);
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
    if (p < 0) {
      runLoss++;
      if (runLoss > maxLossStreak) maxLossStreak = runLoss;
    } else {
      runLoss = 0;
    }
  }

  const pnlByRound: Record<string, number> = {};
  for (const t of closedWithPnl) {
    const r = String(t.round ?? '?');
    pnlByRound[r] = (pnlByRound[r] ?? 0) + Number(t.pnl);
  }

  function segmentCounts(keyFn: (t: any) => string): Record<string, { wins: number; losses: number; pnl: number }> {
    const m: Record<string, { wins: number; losses: number; pnl: number }> = {};
    for (const t of closedWithPnl) {
      const key = keyFn(t) || 'unknown';
      if (!m[key]) m[key] = { wins: 0, losses: 0, pnl: 0 };
      const p = Number(t.pnl);
      if (p > 0) m[key].wins++;
      else if (p < 0) m[key].losses++;
      m[key].pnl += p;
    }
    return m;
  }

  function winRate(seg: { wins: number; losses: number }) {
    const tot = seg.wins + seg.losses;
    return tot > 0 ? (100 * seg.wins) / tot : null;
  }

  const bySessionBucket = segmentCounts((t: any) => {
    const b = (t.trade_log as any)?.entry?.market?.session_bucket_ist;
    return typeof b === 'string' ? b : 'unknown';
  });

  const byTrend = segmentCounts((t: any) => {
    const tr = (t.trade_log as any)?.entry?.market?.trend;
    return typeof tr === 'string' ? tr : 'unknown';
  });

  const byRoundSeg = segmentCounts((t: any) => `R${t.round ?? '?'}`);

  const volatilityBuckets = segmentCounts((t: any) => {
    const r = (t.trade_log as any)?.entry?.market?.atr_proxy_pts;
    if (r == null || Number.isNaN(Number(r))) return 'unknown_vol';
    const v = Number(r);
    if (v < 30) return 'low_range_lt30';
    if (v < 60) return 'mid_range_30_60';
    return 'high_range_gte60';
  });

  /** Segments meeting win-rate floor with enough samples */
  const outperformingBuckets: string[] = [];
  const underperformingBuckets: string[] = [];
  for (const [k, seg] of Object.entries(bySessionBucket)) {
    const tot = seg.wins + seg.losses;
    if (tot < ANALYSIS_MIN_SEGMENT) continue;
    const wr = winRate(seg)!;
    if (wr >= 55) outperformingBuckets.push(`${k}:${wr.toFixed(1)}% (${tot} trades)`);
    if (wr < 45) underperformingBuckets.push(`${k}:${wr.toFixed(1)}% (${tot} trades)`);
  }

  type RiskTier = 'high' | 'medium' | 'low';
  const roundRiskMap: Record<string, { tier: RiskTier; pnl: number; count: number; note: string }> = {};

  function tierFor(_roundKey: string, pnlAgg: number, count: number): RiskTier {
    if (pnlAgg < -50_000 && count >= 3) return 'high';
    if (pnlAgg < -20_000 && count >= 2) return 'medium';
    if (Math.abs(pnlAgg) >= 5000 || count >= 4) return 'medium';
    return 'low';
  }

  const roundKeys = new Set<number>();
  for (const t of closedWithPnl) roundKeys.add(Number(t.round) || 0);
  const sortedRounds = [...roundKeys].sort((a, b) => a - b);

  const riskWarnings: string[] = [];
  for (const rk of sortedRounds) {
    const key = `R${rk}`;
    const agg = closedWithPnl
      .filter((t: any) => Number(t.round) === rk)
      .reduce((s: number, t: any) => s + Number(t.pnl), 0);
    const ct = closedWithPnl.filter((t: any) => Number(t.round) === rk).length;
    const tier = tierFor(key, agg, ct);
    roundRiskMap[key] = {
      tier,
      pnl: agg,
      count: ct,
      note: tier !== 'low' ? 'Monitor exposure on this martingale depth' : 'Within normal exploratory risk',
    };
    const lossRate = ct > 0 ? (100 * closedWithPnl.filter((t: any) => Number(t.round) === rk && Number(t.pnl) < 0).length) / ct : 0;
    if (rk >= 3 && ct >= 3 && lossRate >= 66) {
      riskWarnings.push(
        `${key}: ${lossRate.toFixed(0)}% losses over ${ct} exits — evaluate capping martingale depth or widening skips.`,
      );
    }
  }

  const segmentsForReport = Object.fromEntries(
    Object.entries({ bySessionBucket, byTrend, byRound: byRoundSeg, volatilityBuckets }).map(([nm, mm]) => {
      const condensed: Record<string, unknown> = {};
      for (const [k, seg] of Object.entries(mm)) {
        const tot = seg.wins + seg.losses;
        condensed[k] = {
          trades: tot,
          win_rate_pct: tot ? winRate(seg) : null,
          net_pnl: Number(seg.pnl.toFixed(0)),
          sufficient_sample: tot >= ANALYSIS_MIN_SEGMENT,
        };
      }
      return [nm, condensed];
    }),
  );

  const suggestions: string[] = [];
  if (n < ANALYSIS_MIN_GLOBAL) {
    suggestions.push(`Only ${n} closed trades on ${tradingDayYmd}: wait for ≥${ANALYSIS_MIN_GLOBAL} samples before tuning thresholds aggressively.`);
  } else if (sortedRounds.length && roundRiskMap[`R${Math.max(...sortedRounds)}`]?.tier === 'high') {
    suggestions.push('Deepest martingale step aggregates large negative PnL — consider hard-capping rounds at 3 or tightening sideways gate.');
  }

  const lateMorning = bySessionBucket['late_morning'];
  if (lateMorning && lateMorning.wins + lateMorning.losses >= ANALYSIS_MIN_SEGMENT && (winRate(lateMorning)! < 42)) {
    suggestions.push(`Session bucket late_morning under ${winRate(lateMorning)!.toFixed(0)}% win rate (${lateMorning.wins + lateMorning.losses} trades) — consider paper-testing a narrower entry window before live changes.`);
  }

  const lowVol = volatilityBuckets.low_range_lt30;
  if (
    lowVol &&
    lowVol.wins + lowVol.losses >= ANALYSIS_MIN_SEGMENT &&
    winRate(lowVol)! > 58
  ) {
    suggestions.push('Low intra-session range bucket shows higher win rate — validate on more days before using as a standalone filter.');
  }

  const insights: string[] = [`Win rate ${winRatePct.toFixed(1)}% over ${n} exits (median sample rule: segments need ≥${ANALYSIS_MIN_SEGMENT} trades).`];
  insights.push(`Max drawdown ₹${Math.round(maxDd)} (mark-to-trade cumulative on closed legs).`);

  const { data: pauseDayRowsRaw, error: pauseDayErr } = await supabase
    .from('martingale_pause_events')
    .select('*')
    .eq('trading_day_ist', tradingDayYmd)
    .order('recorded_at', { ascending: true });
  const pauseDayRows = !pauseDayErr && pauseDayRowsRaw ? pauseDayRowsRaw : [];
  if (pauseDayErr) console.error('martingale_pause_events daily analysis:', pauseDayErr);
  const pauseSummaryDaily = summarizePauseGateEvents(pauseDayRows);
  if (pauseSummaryDaily.count > 0) {
    insights.push(
      `${pauseSummaryDaily.count} sideways/decay pause(s): avg gate Nifty range ${pauseSummaryDaily.avg_nifty_range_pts ?? '—'} pts; ` +
        `premium drop vs anchors avg CE ${pauseSummaryDaily.avg_ce_drop_pct ?? '—'}% / PE ${pauseSummaryDaily.avg_pe_drop_pct ?? '—'}% ` +
        '(see pause_gate_events).',
    );
  }

  const globalWinPass = winRatePct >= 55 && n >= ANALYSIS_MIN_GLOBAL;

  const methodologyDaily = [
    'Do not change live risk constants from ≤2 sessions of data.',
    'RSI/VWAP placeholders are null until wired from a candles feed.',
    `Analysis minimums: segment=${ANALYSIS_MIN_SEGMENT}, global=${ANALYSIS_MIN_GLOBAL} trades.`,
  ];
  if (pauseSummaryDaily.count > 0) {
    methodologyDaily.push(
      'pause_gate_events / pause_gate_summary are derived from martingale_pause_events rows for this IST calendar day.',
    );
  }

  return {
    trading_day: tradingDayYmd,
    summary: {
      trade_count_closed: n,
      wins: wins.length,
      losses: losses.length,
      breakevens: closedWithPnl.length - wins.length - losses.length,
      win_rate_pct: Number(winRatePct.toFixed(2)),
      avg_win_inr: Number(avgWin.toFixed(2)),
      avg_loss_inr: losses.length
        ? Number((losses.reduce((s: number, t: any) => s + Number(t.pnl), 0) / losses.length).toFixed(2))
        : 0,
      max_drawdown_inr: Number(maxDd.toFixed(2)),
      max_losing_streak: maxLossStreak,
      pnl_by_martingale_step: pnlByRound,
      round_risk: roundRiskMap,
    },
    segmented: segmentsForReport,
    outperforming_buckets: outperformingBuckets,
    underperforming_buckets: underperformingBuckets,
    insights,
    suggested_actions: suggestions,
    risk_warnings:
      riskWarnings.length > 0
        ? riskWarnings
        : n >= ANALYSIS_MIN_GLOBAL && !globalWinPass
          ? ['Win rate or sample strength does not justify increasing size or widening martingale — favor stability.',]
          : [],
    pause_gate_events: pauseDayRows.map(compactPauseEventForReport),
    pause_gate_summary: pauseSummaryDaily,
    methodology_notes: methodologyDaily,
  };
}

async function persistWeeklyAnalysisReport(
  supabase: any,
  weekStart: string,
  weekEnd: string,
  report: Record<string, unknown>,
) {
  await supabase.from('martingale_weekly_reports').upsert(
    { week_start: weekStart, week_end: weekEnd, report },
    { onConflict: 'week_start' },
  );
}

async function computeMartingaleWeeklyAnalysis(
  supabase: any,
  mondayYmdInput: string,
): Promise<Record<string, unknown>> {
  const weekMon = mondayYmdContainingIst(mondayYmdInput);
  const { week_start, week_end, startIso, endIso } = istWeekInclusiveRange(weekMon);

  const { data: trades, error } = await supabase
    .from('martingale_trades')
    .select('id, round, option_type, pnl, exit_time, trade_log')
    .eq('status', 'closed')
    .gte('exit_time', startIso)
    .lte('exit_time', endIso)
    .order('exit_time', { ascending: true });
  if (error) throw error;

  const closedWithPnl = (trades || []).filter((t: any) => t.pnl != null && t.exit_time);
  const n = closedWithPnl.length;
  const wins = closedWithPnl.filter((t: any) => Number(t.pnl) > 0);
  const losses = closedWithPnl.filter((t: any) => Number(t.pnl) < 0);
  const winRatePct = n > 0 ? (100 * wins.length) / n : 0;
  const avgWin = wins.length ? wins.reduce((s: number, t: any) => s + Number(t.pnl), 0) / wins.length : 0;
  const avgLoss = losses.length
    ? losses.reduce((s: number, t: any) => s + Number(t.pnl), 0) / losses.length
    : 0;

  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  let runLoss = 0;
  let maxLossStreak = 0;
  const istDays = new Set<string>();
  for (const t of closedWithPnl) {
    const p = Number(t.pnl);
    cum += p;
    if (cum > peak) peak = cum;
    maxDd = Math.max(maxDd, peak - cum);
    if (p < 0) {
      runLoss++;
      maxLossStreak = Math.max(maxLossStreak, runLoss);
    } else runLoss = 0;
    istDays.add(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(t.exit_time as string)),
    );
  }

  const pnlByRound: Record<string, number> = {};
  for (const t of closedWithPnl) {
    const r = String(t.round ?? '?');
    pnlByRound[r] = (pnlByRound[r] ?? 0) + Number(t.pnl);
  }

  function segmentCounts(keyFn: (t: any) => string): Record<string, { wins: number; losses: number; pnl: number }> {
    const m: Record<string, { wins: number; losses: number; pnl: number }> = {};
    for (const t of closedWithPnl) {
      const key = keyFn(t) || 'unknown';
      if (!m[key]) m[key] = { wins: 0, losses: 0, pnl: 0 };
      const p = Number(t.pnl);
      if (p > 0) m[key].wins++;
      else if (p < 0) m[key].losses++;
      m[key].pnl += p;
    }
    return m;
  }

  function winRate(seg: { wins: number; losses: number }) {
    const tot = seg.wins + seg.losses;
    return tot > 0 ? (100 * seg.wins) / tot : null;
  }

  const byWeekday = segmentCounts((t: any) =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(new Date(t.exit_time)),
  );
  const bySessionBucket = segmentCounts((t: any) => {
    const b = (t.trade_log as any)?.entry?.market?.session_bucket_ist;
    return typeof b === 'string' ? b : 'unknown';
  });
  const byTrend = segmentCounts((t: any) => {
    const tr = (t.trade_log as any)?.entry?.market?.trend;
    return typeof tr === 'string' ? tr : 'unknown';
  });
  const byRoundSeg = segmentCounts((t: any) => `R${t.round ?? '?'}`);
  const volatilityBuckets = segmentCounts((t: any) => {
    const r = (t.trade_log as any)?.entry?.market?.atr_proxy_pts;
    if (r == null || Number.isNaN(Number(r))) return 'unknown_vol';
    const v = Number(r);
    if (v < 30) return 'low_range_lt30';
    if (v < 60) return 'mid_range_30_60';
    return 'high_range_gte60';
  });

  let premiumTickCount = 0;
  const { count: tickCnt, error: tickErr } = await supabase
    .from('martingale_premium_ticks')
    .select('*', { count: 'exact', head: true })
    .gte('recorded_at', startIso)
    .lte('recorded_at', endIso);
  if (!tickErr && typeof tickCnt === 'number') premiumTickCount = tickCnt;

  const { data: pauseWeekRowsRaw, error: pauseWeekErr } = await supabase
    .from('martingale_pause_events')
    .select('*')
    .gte('recorded_at', startIso)
    .lte('recorded_at', endIso)
    .order('recorded_at', { ascending: true });
  const pauseWeekRows = !pauseWeekErr && pauseWeekRowsRaw ? pauseWeekRowsRaw : [];
  if (pauseWeekErr) console.error('martingale_pause_events weekly analysis:', pauseWeekErr);
  const pauseWeekSummary = summarizePauseGateEvents(pauseWeekRows);
  const pauseExpertLines: string[] = [];
  if (pauseWeekSummary.count > 0) {
    pauseExpertLines.push(
      `Sideways/decay pauses (${pauseWeekSummary.count}×): avg intra-gate Nifty range ~${pauseWeekSummary.avg_nifty_range_pts ?? '—'} pts; ` +
        `CE / PE premium drop vs anchors avg ${pauseWeekSummary.avg_ce_drop_pct ?? '—'}% / ${pauseWeekSummary.avg_pe_drop_pct ?? '—'}% ` +
        `(max CE ${pauseWeekSummary.max_ce_drop_pct ?? '—'}% / PE ${pauseWeekSummary.max_pe_drop_pct ?? '—'}%). See pause_gate_events.`,
    );
  }

  const expert_review = [
    ...buildWeeklyExpertReview({
      n,
      winRatePct,
      maxDd,
      distinctIstTradingDays: istDays.size,
      avgWin,
      avgLoss,
      byWeekday,
      byTrend,
      pnlByRound,
      premiumTickCount,
    }),
    ...pauseExpertLines,
  ];

  const segmentsCondensed = Object.fromEntries(
    Object.entries({ byWeekday, bySessionBucket, byTrend, byRound: byRoundSeg, volatilityBuckets }).map(([nm, mm]) => {
      const condensed: Record<string, unknown> = {};
      for (const [k, seg] of Object.entries(mm)) {
        const tot = seg.wins + seg.losses;
        condensed[k] = {
          trades: tot,
          win_rate_pct: tot ? winRate(seg) : null,
          net_pnl: Number(seg.pnl.toFixed(0)),
          sufficient_sample: tot >= ANALYSIS_MIN_SEGMENT,
        };
      }
      return [nm, condensed];
    }),
  );

  const netWeekPnl = closedWithPnl.reduce((s: number, t: any) => s + Number(t.pnl), 0);

  return {
    period: { ist_week_start: week_start, ist_week_end: week_end },
    summary: {
      trade_count_closed: n,
      distinct_trading_days: istDays.size,
      wins: wins.length,
      losses: losses.length,
      win_rate_pct: Number(winRatePct.toFixed(2)),
      net_pnl_inr: Number(netWeekPnl.toFixed(2)),
      avg_win_inr: Number(avgWin.toFixed(2)),
      avg_loss_inr: Number(avgLoss.toFixed(2)),
      max_drawdown_inr: Number(maxDd.toFixed(2)),
      max_losing_streak: maxLossStreak,
      pnl_by_martingale_step: pnlByRound,
      premium_tick_snapshots: premiumTickCount,
    },
    segmented: segmentsCondensed,
    expert_review,
    pause_gate_events: pauseWeekRows.map(compactPauseEventForReport),
    pause_gate_summary: pauseWeekSummary,
    methodology_notes: [
      'Weekly roll-up aggregates closes by IST exit timestamp across Mon–Sun; align your trading week to this boundary.',
      'After 2–3 days of detailed logs, revisit expert_review weekly; corroborate with premium tick tab before rule changes.',
      `Target ≥${ANALYSIS_WEEK_MIN_TRADES} weekly exits before aggressive optimization; segments still use min ${ANALYSIS_MIN_SEGMENT}.`,
      ...(pauseWeekSummary.count > 0
        ? [
            'pause_gate_* fields join martingale_pause_events by recorded_at within this IST week window (covers post-close rechecks).',
          ]
        : []),
      'Education only — not financial advice.',
    ],
  };
}

async function getUpstoxToken(supabase: any): Promise<string | null> {
  const { data: token } = await supabase
    .from('upstox_tokens')
    .select('access_token')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return token?.access_token || null;
}

async function placeUpstoxOrder(accessToken: string, params: {
  instrumentKey: string;
  quantity: number;
  transactionType: 'BUY' | 'SELL';
  price: number;
  orderType?: 'LIMIT' | 'MARKET';
}): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    const effectiveOrderType = params.orderType || (params.transactionType === 'SELL' ? 'MARKET' : 'LIMIT');
    const orderBody = {
      quantity: params.quantity,
      product: 'I',
      validity: 'DAY',
      price: effectiveOrderType === 'MARKET' ? 0 : params.price,
      instrument_token: params.instrumentKey,
      order_type: effectiveOrderType,
      transaction_type: params.transactionType,
      disclosed_quantity: 0,
      trigger_price: 0,
      is_amo: false,
    };

    console.log(`Placing Upstox order: ${JSON.stringify(orderBody)}`);

    const res = await fetch('https://api-hft.upstox.com/v2/order/place', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(orderBody),
    });

    const data = await res.json();
    if (!res.ok || data.status !== 'success') {
      console.error(`Upstox order failed: ${JSON.stringify(data)}`);
      return { success: false, error: data?.errors?.[0]?.message || data?.message || `Order failed (${res.status})` };
    }

    console.log(`Upstox order placed: ${data.data?.order_id}`);
    return { success: true, orderId: data.data?.order_id };
  } catch (error) {
    console.error('Upstox order error:', error);
    return { success: false, error: (error as Error).message };
  }
}

async function checkUpstoxOrderStatus(accessToken: string, orderId: string): Promise<{ status: string; filled: boolean; averagePrice?: number }> {
  try {
    const res = await fetch(`https://api-hft.upstox.com/v2/order/details?order_id=${orderId}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    const data = await res.json();
    if (data.status === 'success' && data.data) {
      const orderStatus = data.data.status?.toLowerCase() || '';
      const filled = orderStatus === 'complete' || orderStatus === 'traded';
      return { status: orderStatus, filled, averagePrice: data.data.average_price };
    }
    console.error(`Order status check failed: ${JSON.stringify(data)}`);
    return { status: 'unknown', filled: false };
  } catch (error) {
    console.error('Order status check error:', error);
    return { status: 'error', filled: false };
  }
}

async function cancelUpstoxOrder(accessToken: string, orderId: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api-hft.upstox.com/v2/order/cancel?order_id=${orderId}`, {
      method: 'DELETE',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    const data = await res.json();
    console.log(`Cancel order ${orderId}: ${JSON.stringify(data)}`);
    return data.status === 'success';
  } catch (error) {
    console.error('Cancel order error:', error);
    return false;
  }
}

async function placeBuyWithRetry(
  supabase: any,
  accessToken: string,
  params: { instrumentKey: string; quantity: number; price: number },
): Promise<{ success: boolean; filledPrice: number; error?: string }> {
  for (let attempt = 1; attempt <= ORDER_FILL_MAX_RETRIES; attempt++) {
    console.log(`BUY attempt ${attempt}/${ORDER_FILL_MAX_RETRIES} @ ₹${params.price}`);

    const buyResult = await placeUpstoxOrder(accessToken, {
      instrumentKey: params.instrumentKey,
      quantity: params.quantity,
      transactionType: 'BUY',
      price: params.price,
    });

    if (!buyResult.success || !buyResult.orderId) {
      console.error(`BUY attempt ${attempt} failed: ${buyResult.error}`);
      if (attempt === ORDER_FILL_MAX_RETRIES) {
        return { success: false, filledPrice: 0, error: `All ${ORDER_FILL_MAX_RETRIES} order attempts failed: ${buyResult.error}` };
      }
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    let filled = false;
    let filledPrice = params.price;
    for (let check = 0; check < ORDER_FILL_MAX_CHECKS; check++) {
      await new Promise(r => setTimeout(r, ORDER_FILL_CHECK_INTERVAL_MS));
      const status = await checkUpstoxOrderStatus(accessToken, buyResult.orderId);
      console.log(`Order ${buyResult.orderId} check ${check + 1}: ${status.status}`);
      if (status.filled) {
        filled = true;
        filledPrice = status.averagePrice || params.price;
        break;
      }
      if (['rejected', 'cancelled', 'canceled'].includes(status.status)) {
        console.log(`Order ${buyResult.orderId} was ${status.status}`);
        break;
      }
    }

    if (filled) {
      console.log(`BUY filled on attempt ${attempt} @ ₹${filledPrice}`);
      return { success: true, filledPrice };
    }

    console.log(`Order not filled after ${ORDER_FILL_MAX_CHECKS} checks, cancelling...`);
    await cancelUpstoxOrder(accessToken, buyResult.orderId);
    await new Promise(r => setTimeout(r, 2000));
  }

  return { success: false, filledPrice: 0, error: `Order not filled after ${ORDER_FILL_MAX_RETRIES} attempts` };
}

async function pauseBotWithNotification(supabase: any, sessionId: string, reason: string) {
  const pausedUntil = new Date(Date.now() + PAUSE_DURATION_MS).toISOString();
  
  await supabase.from('martingale_sessions').update({
    status: 'paused',
    last_tick_at: new Date().toISOString(),
  }).eq('id', sessionId);

  await supabase.from('bot_settings').upsert({
    key: 'pause_until',
    value: pausedUntil,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });

  await supabase.from('bot_settings').upsert({
    key: 'pause_reason',
    value: reason,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });

  const msg = `⏸️ *Bot Paused for 10 minutes*\n\n${reason}\n\nWill auto-resume at ${new Date(pausedUntil).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
  await sendTelegram(msg);
  console.log(`Bot paused until ${pausedUntil}: ${reason}`);
}

async function sendTelegram(text: string) {
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID');
  if (botToken && chatId) {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  }
}

// // ========== BETWEEN-ROUND SIDEWAYS GATE ==========
// // Instead of detecting decay mid-trade (the -2% stop handles that),
// // this gates ENTRY into R3+ by checking:
// // 1) Were the last 2 rounds both losses?
// // 2) Is Nifty range-bound (< threshold pts in recent history)?
// // 3) Both OTM CE & PE premiums down vs session-start chain snapshot (double decay)
// // If (1) and (2) OR (1) and (3) → skip entry, end session, reset to R1, pause 15 min.

// /** Resolve CE/PE premium anchors for double-decay: prefer columns set at session start; else earliest trade per side (legacy sessions). */
// async function getSessionPremiumAnchors(
//   supabase: any,
//   sessionId: string,
//   allSessionTrades: any[] | null,
// ): Promise<{ anchorCE: number | null; anchorPE: number | null }> {
//   const { data: sessRow } = await supabase
//     .from('martingale_sessions')
//     .select('anchor_otm_ce_premium, anchor_otm_pe_premium')
//     .eq('id', sessionId)
//     .maybeSingle();

//   let anchorCE = sessRow?.anchor_otm_ce_premium != null ? Number(sessRow.anchor_otm_ce_premium) : null;
//   let anchorPE = sessRow?.anchor_otm_pe_premium != null ? Number(sessRow.anchor_otm_pe_premium) : null;

//   if (anchorCE != null && (Number.isNaN(anchorCE) || anchorCE <= 0)) anchorCE = null;
//   if (anchorPE != null && (Number.isNaN(anchorPE) || anchorPE <= 0)) anchorPE = null;

//   // const needCE = anchorCE == null;
//   // const needPE = anchorPE == null;
//   // if ((needCE || needPE) && allSessionTrades && allSessionTrades.length > 0) {
//   //   const sorted = [...allSessionTrades].sort(
//   //     (a, b) => new Date(a.entry_time).getTime() - new Date(b.entry_time).getTime(),
//   //   );
//   //   if (needCE) {
//   //     const firstCE = sorted.find((t: any) => t.option_type === 'CE');
//   //     const v = firstCE ? Number(firstCE.entry_price) : NaN;
//   //     if (!Number.isNaN(v) && v > 0) anchorCE = v;
//   //   }
//   //   if (needPE) {
//   //     const firstPE = sorted.find((t: any) => t.option_type === 'PE');
//   //     const v = firstPE ? Number(firstPE.entry_price) : NaN;
//   //     if (!Number.isNaN(v) && v > 0) anchorPE = v;
//   //   }
//   // }

//   return { anchorCE, anchorPE };
// }

// --- 1. Premium Anchor Retrieval ---
async function getSessionPremiumAnchors(
  supabase: any,
  sessionId: string,
  allSessionTrades: any[] | null,
): Promise<{ anchorCE: number | null; anchorPE: number | null }> {
  const { data: sessRow } = await supabase
    .from('martingale_sessions')
    .select('anchor_otm_ce_premium, anchor_otm_pe_premium')
    .eq('id', sessionId)
    .maybeSingle();

  let anchorCE = sessRow?.anchor_otm_ce_premium != null 
                 ? Number(sessRow.anchor_otm_ce_premium) : null;
  let anchorPE = sessRow?.anchor_otm_pe_premium != null 
                 ? Number(sessRow.anchor_otm_pe_premium) : null;

  if (anchorCE !== null && (Number.isNaN(anchorCE) || anchorCE <= 0)) anchorCE = null;
  if (anchorPE !== null && (Number.isNaN(anchorPE) || anchorPE <= 0)) anchorPE = null;

  // REMOVED: No trade-based fallback. Anchors must come from DB (set at session start).
  return { anchorCE, anchorPE };
}

async function getSessionAnchorStrikes(
  supabase: any,
  sessionId: string,
): Promise<{ anchorCEStrike: number | null; anchorPEStrike: number | null }> {
  const { data: firstTick } = await supabase
    .from('martingale_premium_ticks')
    .select('otm_ce_strike, otm_pe_strike, recorded_at')
    .eq('session_id', sessionId)
    .order('recorded_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const anchorCEStrike =
    firstTick?.otm_ce_strike != null && !Number.isNaN(Number(firstTick.otm_ce_strike))
      ? Number(firstTick.otm_ce_strike)
      : null;
  const anchorPEStrike =
    firstTick?.otm_pe_strike != null && !Number.isNaN(Number(firstTick.otm_pe_strike))
      ? Number(firstTick.otm_pe_strike)
      : null;
  return { anchorCEStrike, anchorPEStrike };
}



// async function shouldSkipNextRound(
//   supabase: any, 
//   sessionId: string, 
//   nextRound: number,
//   niftySpot: number,
//   supabaseUrl: string,
//   anonKey: string,
//   currentCEPrice?: number,
//   currentPEPrice?: number,
// ): Promise<{ skip: boolean; reason: string }> {
//   // R1 and R2 — always allow, early losses are normal
//   if (nextRound < SIDEWAYS_MIN_ROUND) {
//     return { skip: false, reason: `R${nextRound}: allowed (< R${SIDEWAYS_MIN_ROUND})` };
//   }

//   // Check if last 2 rounds in this session were both losses
//   const { data: recentTrades } = await supabase
//     .from('martingale_trades')
//     .select('round, pnl, status, nifty_spot')
//     .eq('session_id', sessionId)
//     .eq('status', 'closed')
//     .order('round', { ascending: false })
//     .limit(2);

//   if (!recentTrades || recentTrades.length < 2) {
//     return { skip: false, reason: 'Not enough trade history to evaluate' };
//   }

//   const lastTwoLosses = recentTrades.every((t: any) => (t.pnl || 0) < 0);
//   if (!lastTwoLosses) {
//     return { skip: false, reason: `R${nextRound}: last 2 rounds not both losses — proceed` };
//   }

//   // Both were losses — now check combined signals (decay AND low range together)

//   // Signal 1: Nifty range (market movement during session)
//   const { data: allSessionTrades } = await supabase
//     .from('martingale_trades')
//     .select('nifty_spot, entry_price, option_type, round, entry_time')
//     .eq('session_id', sessionId)
//     .order('entry_time', { ascending: true });

//   let niftyRange = 0;
//   if (allSessionTrades && allSessionTrades.length > 0) {
//     const spots = allSessionTrades
//       .map((t: any) => Number(t.nifty_spot))
//       .filter((s: number) => s > 0);
//     if (spots.length > 0) {
//       // UPDATED: Use only recent trades for range
//       const RECENT_WINDOW = 5; // take last 5 data points (configurable)
//       const recentSpots = spots.slice(-RECENT_WINDOW);
//       recentSpots.push(niftySpot);
//     //  spots.push(niftySpot);
//     //  niftyRange = Math.max(...spots) - Math.min(...spots);
//       niftyRange = Math.max(...recentSpots) - Math.min(...recentSpots);
//     }
//   }

//   // Signal 2: Both OTM premiums decaying vs same-session anchors
//   // Two tiers: STRONG (~6% decay) and MILD (~3% decay)
//   const STRONG_DECAY = 0.94; // ~6% decay
//   const WEAK_DECAY = 0.97;   // ~3% decay
//   const MIN_PREMIUM = 80;    // NEW (ignore very cheap options)
//   let strongDoubleDecay = false;
//   let mildDoubleDecay = false;
//   let decayDetail = '';

//   if (currentCEPrice && currentPEPrice && currentCEPrice > 0 && currentPEPrice > 0) {
//     const { anchorCE, anchorPE } = await getSessionPremiumAnchors(supabase, sessionId, allSessionTrades);
//     if (anchorCE != null && anchorPE != null && anchorCE > 0 && anchorPE > 0) {
//       if (anchorCE > MIN_PREMIUM && anchorPE > MIN_PREMIUM) {
//         const ceRatio = currentCEPrice / anchorCE;
//         const peRatio = currentPEPrice / anchorPE;
//         strongDoubleDecay = ceRatio < STRONG_DECAY && peRatio < STRONG_DECAY;
//         mildDoubleDecay   = ceRatio < WEAK_DECAY   && peRatio < WEAK_DECAY;
//         decayDetail = `CE: ₹${anchorCE.toFixed(0)}→₹${currentCEPrice.toFixed(0)} (${((1 - ceRatio) * 100).toFixed(1)}% down), PE: ₹${anchorPE.toFixed(0)}→₹${currentPEPrice.toFixed(0)} (${((1 - peRatio) * 100).toFixed(1)}% down)`;
//       }
//     }
//   }

//   // HARD BLOCK: strong decay + very dead market
//   if (strongDoubleDecay && niftyRange < 25) {
//     return {
//       skip: true,
//       reason: `R${nextRound}: Strong double decay + very low range (${niftyRange.toFixed(0)}pts). Dead market. ${decayDetail}`,
//     };
//   }

//   // SOFT BLOCK: mild decay + low movement
//   if (mildDoubleDecay && niftyRange < 30) {
//     return {
//       skip: true,
//       reason: `R${nextRound}: Mild double decay + low range (${niftyRange.toFixed(0)}pts). Avoid trap. ${decayDetail}`,
//     };
//   }

//   // FALLBACK SAFETY: no premium data available AND market is extremely dead
//   if ((!currentCEPrice || !currentPEPrice) && niftyRange < 15) {
//     return {
//       skip: true,
//       reason: `R${nextRound}: No premium data + extreme low range (${niftyRange.toFixed(0)}pts). Safety skip.`,
//     };
//   }

//   // FINAL ALLOW
//   return {
//     skip: false,
//     reason: `R${nextRound}: Allowed — movement present (range ${niftyRange.toFixed(0)}pts) or decay not strong`,
//   };
// }

// Modified to re-check after pause expiry


// // --- Configuration Constants (NEW) ---
// const SIDEWAYS_NIFTY_RANGE_THRESHOLD = 25;  // pts (strong decay)
// const SIDEWAYS_NIFTY_RANGE_THRESHOLD_WEAK = 30;  // pts (mild decay)
// const SIDEWAYS_PREMIUM_DECAY_STRONG = 0.94;
// const SIDEWAYS_PREMIUM_DECAY_WEAK = 0.97;
// const MIN_OPTION_PREMIUM = 80;   // ignore options cheaper than this
// const RECENT_TRADES_WINDOW = 5;  // use last 5 trades for range
// const SIDEWAYS_PAUSE_DURATION_MS = 15 * 60 * 1000;
// const SIDEWAYS_MIN_ROUND = 3;
// const SIDEWAYS_PAUSE_DURATION_MIN = SIDEWAYS_PAUSE_DURATION_MS / 60000;

// --- Helper Function (NEW) ---
function calculateRange(spots: number[], currentSpot: number, window: number): number {
  // Takes last `window` spots plus the current spot to compute range
  const recent = spots.slice(-window);
  recent.push(currentSpot);
  return Math.max(...recent) - Math.min(...recent);
}


// --- 2. Sideways Skip Logic ---
async function shouldSkipNextRound(
  supabase: any,
  sessionId: string,
  nextRound: number,
  niftySpot: number,
  supabaseUrl: string,
  anonKey: string,
  currentCEPrice?: number,
  currentPEPrice?: number,
  currentCEStrike?: number,
  currentPEStrike?: number,
  minRoundGate: number = SIDEWAYS_MIN_ROUND,
): Promise<{ skip: boolean; reason: string; eval: SidewaysGateEval }> {
  if (nextRound < minRoundGate) {
    return {
      skip: false,
      reason: `R${nextRound}: allowed (<R${minRoundGate})`,
      eval: {
        gate_round: nextRound,
        last_two_losses: false,
        nifty_range_pts: 0,
        range_window_trades: RECENT_TRADES_WINDOW,
        thresholds: {
          strong_decay_ratio: SIDEWAYS_PREMIUM_DECAY_STRONG,
          weak_decay_ratio: SIDEWAYS_PREMIUM_DECAY_WEAK,
          strong_range_lt: SIDEWAYS_NIFTY_RANGE_THRESHOLD,
          weak_range_lt: SIDEWAYS_NIFTY_RANGE_THRESHOLD_WEAK,
        },
        anchor_ce: null,
        anchor_pe: null,
        current_ce: currentCEPrice ?? null,
        current_pe: currentPEPrice ?? null,
        ce_ratio: null,
        pe_ratio: null,
        range_source: 'none',
        anchor_ce_strike: null,
        anchor_pe_strike: null,
        current_ce_strike: currentCEStrike ?? null,
        current_pe_strike: currentPEStrike ?? null,
        strike_consistent: false,
        strong_double_decay: false,
        mild_double_decay: false,
        skip_decision: false,
      },
    };
  }

  const { data: recentTrades } = await supabase
    .from('martingale_trades')
    .select('round, pnl')
    .eq('session_id', sessionId)
    .eq('status', 'closed')
    .order('round', { ascending: false })
    .limit(2);
  if (!recentTrades || recentTrades.length < 2) {
    return {
      skip: false,
      reason: 'Not enough history',
      eval: {
        gate_round: nextRound,
        last_two_losses: false,
        nifty_range_pts: 0,
        range_window_trades: RECENT_TRADES_WINDOW,
        thresholds: {
          strong_decay_ratio: SIDEWAYS_PREMIUM_DECAY_STRONG,
          weak_decay_ratio: SIDEWAYS_PREMIUM_DECAY_WEAK,
          strong_range_lt: SIDEWAYS_NIFTY_RANGE_THRESHOLD,
          weak_range_lt: SIDEWAYS_NIFTY_RANGE_THRESHOLD_WEAK,
        },
        anchor_ce: null,
        anchor_pe: null,
        current_ce: currentCEPrice ?? null,
        current_pe: currentPEPrice ?? null,
        ce_ratio: null,
        pe_ratio: null,
        range_source: 'none',
        anchor_ce_strike: null,
        anchor_pe_strike: null,
        current_ce_strike: currentCEStrike ?? null,
        current_pe_strike: currentPEStrike ?? null,
        strike_consistent: false,
        strong_double_decay: false,
        mild_double_decay: false,
        skip_decision: false,
      },
    };
  }
  const lastTwoLosses = recentTrades.every((t: any) => (t.pnl || 0) < 0);
  if (!lastTwoLosses) {
    return {
      skip: false,
      reason: `R${nextRound}: last 2 not both losses`,
      eval: {
        gate_round: nextRound,
        last_two_losses: false,
        nifty_range_pts: 0,
        range_window_trades: RECENT_TRADES_WINDOW,
        thresholds: {
          strong_decay_ratio: SIDEWAYS_PREMIUM_DECAY_STRONG,
          weak_decay_ratio: SIDEWAYS_PREMIUM_DECAY_WEAK,
          strong_range_lt: SIDEWAYS_NIFTY_RANGE_THRESHOLD,
          weak_range_lt: SIDEWAYS_NIFTY_RANGE_THRESHOLD_WEAK,
        },
        anchor_ce: null,
        anchor_pe: null,
        current_ce: currentCEPrice ?? null,
        current_pe: currentPEPrice ?? null,
        ce_ratio: null,
        pe_ratio: null,
        range_source: 'none',
        anchor_ce_strike: null,
        anchor_pe_strike: null,
        current_ce_strike: currentCEStrike ?? null,
        current_pe_strike: currentPEStrike ?? null,
        strike_consistent: false,
        strong_double_decay: false,
        mild_double_decay: false,
        skip_decision: false,
      },
    };
  }

  // Prefer high-resolution spot range from premium ticks (last N minutes), fallback to trade-entry spots.
  const { data: allSessionTrades } = await supabase
    .from('martingale_trades')
    .select('nifty_spot, entry_time')
    .eq('session_id', sessionId)
    .order('entry_time', { ascending: true });
  const rangeCutoffIso = new Date(Date.now() - SIDEWAYS_TICK_RANGE_WINDOW_MS).toISOString();
  const { data: recentTicks } = await supabase
    .from('martingale_premium_ticks')
    .select('nifty_spot')
    .eq('session_id', sessionId)
    .gte('recorded_at', rangeCutoffIso)
    .order('recorded_at', { ascending: true });

  let niftyRange = 0;
  let rangeSource: SidewaysGateEval['range_source'] = 'none';
  if (recentTicks && recentTicks.length >= 2) {
    const tickSpots = recentTicks.map((t: any) => Number(t.nifty_spot)).filter((s: number) => s > 0);
    if (tickSpots.length >= 2) {
      niftyRange = calculateRange(tickSpots, niftySpot, Math.max(tickSpots.length, 2));
      rangeSource = 'premium_ticks';
    }
  }
  if (rangeSource === 'none' && allSessionTrades && allSessionTrades.length > 0) {
    const spots = allSessionTrades.map((t: any) => Number(t.nifty_spot)).filter((s: number) => s > 0);
    if (spots.length > 0) {
      niftyRange = calculateRange(spots, niftySpot, RECENT_TRADES_WINDOW);
      rangeSource = 'trade_spots';
    }
  }

  // Check premium decay vs anchors
  let strongDoubleDecay = false, mildDoubleDecay = false;
  let decayDetail = '';
  const cePx = currentCEPrice ?? 0;
  const pePx = currentPEPrice ?? 0;
  let ceRatio: number | null = null;
  let peRatio: number | null = null;
  let anchorCEForEval: number | null = null;
  let anchorPEForEval: number | null = null;
  let anchorCEStrike: number | null = null;
  let anchorPEStrike: number | null = null;
  let strikeConsistent = false;
  if (cePx > 0 && pePx > 0) {
    const { anchorCE, anchorPE } = await getSessionPremiumAnchors(supabase, sessionId, allSessionTrades);
    const anchorStrikes = await getSessionAnchorStrikes(supabase, sessionId);
    anchorCEStrike = anchorStrikes.anchorCEStrike;
    anchorPEStrike = anchorStrikes.anchorPEStrike;
    const ceStrikeAligned =
      anchorCEStrike != null && currentCEStrike != null
        ? Math.abs(currentCEStrike - anchorCEStrike) <= SIDEWAYS_STRIKE_SHIFT_TOLERANCE
        : false;
    const peStrikeAligned =
      anchorPEStrike != null && currentPEStrike != null
        ? Math.abs(currentPEStrike - anchorPEStrike) <= SIDEWAYS_STRIKE_SHIFT_TOLERANCE
        : false;
    strikeConsistent = ceStrikeAligned && peStrikeAligned;
    anchorCEForEval = anchorCE;
    anchorPEForEval = anchorPE;
    if (
      strikeConsistent &&
      anchorCE &&
      anchorPE &&
      anchorCE > MIN_OPTION_PREMIUM &&
      anchorPE > MIN_OPTION_PREMIUM
    ) {
      ceRatio = cePx / anchorCE;
      peRatio = pePx / anchorPE;
      strongDoubleDecay = (ceRatio < SIDEWAYS_PREMIUM_DECAY_STRONG && peRatio < SIDEWAYS_PREMIUM_DECAY_STRONG);
      mildDoubleDecay   = (ceRatio < SIDEWAYS_PREMIUM_DECAY_WEAK   && peRatio < SIDEWAYS_PREMIUM_DECAY_WEAK);
      decayDetail = `CE ₹${anchorCE.toFixed(0)}→₹${cePx.toFixed(0)} (${((1-ceRatio)*100).toFixed(1)}%), ` +
                    `PE ₹${anchorPE.toFixed(0)}→₹${pePx.toFixed(0)} (${((1-peRatio)*100).toFixed(1)}%)`;
    }
  }

  const evalSnapshot: SidewaysGateEval = {
    gate_round: nextRound,
    last_two_losses: true,
    nifty_range_pts: Number(niftyRange.toFixed(2)),
    range_window_trades: RECENT_TRADES_WINDOW,
    thresholds: {
      strong_decay_ratio: SIDEWAYS_PREMIUM_DECAY_STRONG,
      weak_decay_ratio: SIDEWAYS_PREMIUM_DECAY_WEAK,
      strong_range_lt: SIDEWAYS_NIFTY_RANGE_THRESHOLD,
      weak_range_lt: SIDEWAYS_NIFTY_RANGE_THRESHOLD_WEAK,
    },
    anchor_ce: anchorCEForEval,
    anchor_pe: anchorPEForEval,
    current_ce: cePx > 0 ? cePx : null,
    current_pe: pePx > 0 ? pePx : null,
    ce_ratio: ceRatio != null ? Number(ceRatio.toFixed(4)) : null,
    pe_ratio: peRatio != null ? Number(peRatio.toFixed(4)) : null,
    range_source: rangeSource,
    anchor_ce_strike: anchorCEStrike,
    anchor_pe_strike: anchorPEStrike,
    current_ce_strike: currentCEStrike ?? null,
    current_pe_strike: currentPEStrike ?? null,
    strike_consistent: strikeConsistent,
    strong_double_decay: strongDoubleDecay,
    mild_double_decay: mildDoubleDecay,
    skip_decision: false,
  };

  // HARD block: strong decay + range under threshold
  if (strongDoubleDecay && niftyRange < SIDEWAYS_NIFTY_RANGE_THRESHOLD) {
    evalSnapshot.skip_decision = true;
    return {
      skip: true,
      reason: `R${nextRound}: Strong decay + low range (${niftyRange.toFixed(0)} pts). ${decayDetail}`,
      eval: evalSnapshot,
    };
  }
  // Deep martingale hardening: from R4 onward, block on either strong decay OR very low range.
  if (nextRound >= 4 && (strongDoubleDecay || niftyRange < SIDEWAYS_NIFTY_RANGE_THRESHOLD)) {
    evalSnapshot.skip_decision = true;
    return {
      skip: true,
      reason: `R${nextRound}: Deep-round block (${strongDoubleDecay ? 'strong decay' : 'very low range'}) with range ${niftyRange.toFixed(0)} pts.`,
      eval: evalSnapshot,
    };
  }
  // SOFT block: mild decay + range under threshold_weaker
  if (mildDoubleDecay && niftyRange < SIDEWAYS_NIFTY_RANGE_THRESHOLD_WEAK) {
    evalSnapshot.skip_decision = true;
    return {
      skip: true,
      reason: `R${nextRound}: Mild decay + low range (${niftyRange.toFixed(0)} pts). ${decayDetail}`,
      eval: evalSnapshot,
    };
  }
  // Safety: extreme scenario
  if ((!cePx || !pePx) && niftyRange < 15) {
    evalSnapshot.skip_decision = true;
    return {
      skip: true,
      reason: `R${nextRound}: No price data + very low range (${niftyRange.toFixed(0)} pts).`,
      eval: evalSnapshot,
    };
  }

  return {
    skip: false,
    reason: `R${nextRound}: Market moving (${niftyRange.toFixed(0)} pts) or decay not strong`,
    eval: evalSnapshot,
  };
}


async function isInSidewaysPause(
  supabase: any,
  sessionId?: string,
  niftySpot?: number,
  supabaseUrl?: string,
  anonKey?: string,
  currentCEPrice?: number,
  currentPEPrice?: number,
  currentCEStrike?: number,
  currentPEStrike?: number,
): Promise<{ paused: boolean; remainingMins: number }> {
  const { data } = await supabase
    .from('bot_settings')
    .select('value')
    .eq('key', 'sideways_pause_until')
    .maybeSingle();

  if (!data?.value) {
    return { paused: false, remainingMins: 0 };
  }
  const pauseUntil = new Date(data.value).getTime();

  // Still in pause period
  if (Date.now() < pauseUntil) {
    const remainingMins = Math.ceil((pauseUntil - Date.now()) / 60000);
    return { paused: true, remainingMins };
  }

  // Pause expired — recheck conditions (R3-equivalent gate; needs session trades so sessionId matters)
  const nextRound = 3;
  const recheckGate = await shouldSkipNextRound(
    supabase,
    sessionId ?? '',
    nextRound,
    niftySpot ?? 0,
    supabaseUrl ?? '',
    anonKey ?? '',
    currentCEPrice,
    currentPEPrice,
    currentCEStrike,
    currentPEStrike,
  );

  if (recheckGate.skip) {
    const extendReason =
      typeof recheckGate.reason === 'string' && recheckGate.reason.trim().length > 0
        ? `${recheckGate.reason} — extended after pause expiry (gate recheck).`
        : 'Sideways gate still triggered after pause — extended 15 min (recheck at R3).';
    const pauseUntilIso = await setSidewaysPause(supabase, extendReason);
    insertMartingalePauseEventFireAndForget(
      supabase,
      pauseEventRowFromSidewaysEval({
        sessionId: sanitizeSessionIdForPause(sessionId),
        pauseUntilIso,
        reason: extendReason,
        niftySpot: niftySpot ?? 0,
        gateEval: recheckGate.eval,
        pauseKind: 'sideways_gate_reextend',
      }),
    );
    return { paused: true, remainingMins: Math.ceil(SIDEWAYS_PAUSE_DURATION_MS / 60000) };
  }

  await supabase.from('bot_settings').delete().eq('key', 'sideways_pause_until');
  await supabase.from('bot_settings').delete().eq('key', 'sideways_pause_reason');
  return { paused: false, remainingMins: 0 };
}


// // Check if currently in a sideways pause period
// async function isInSidewaysPause(supabase: any): Promise<{ paused: boolean; remainingMins: number }> {
//   const { data } = await supabase
//     .from('bot_settings')
//     .select('value')
//     .eq('key', 'sideways_pause_until')
//     .maybeSingle();

//   if (!data?.value) return { paused: false, remainingMins: 0 };

//   const pauseUntil = new Date(data.value).getTime();

//    // Still in pause period
//    if (Date.now() < pauseUntil) {
//     const remainingMins = Math.ceil((pauseUntil - Date.now()) / 60000);
//     return { paused: true, remainingMins };
//   }
  


//   if (Date.now() >= pauseUntil) {
//     await supabase.from('bot_settings').delete().eq('key', 'sideways_pause_until');
//     return { paused: false, remainingMins: 0 };
//   }

//   const remainingMins = Math.ceil((pauseUntil - Date.now()) / 60000);
//   return { paused: true, remainingMins };
// }


//old code
// async function setSidewaysPause(supabase: any): Promise<string> {
//   const pauseUntil = new Date(Date.now() + SIDEWAYS_PAUSE_DURATION_MS).toISOString();
//   await supabase.from('bot_settings').upsert({
//     key: 'sideways_pause_until',
//     value: pauseUntil,
//     updated_at: new Date().toISOString(),
//   }, { onConflict: 'key' });
//   return pauseUntil;
// }

function sanitizeSessionIdForPause(id?: string): string | null {
  if (!id || typeof id !== 'string') return null;
  const t = id.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(t)) return null;
  return t;
}

function tradingDayIstNowYmd(ms: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(ms));
}

/** Row for martingale_pause_events from full R3+ gate evaluation (between rounds). */
function pauseEventRowFromSidewaysEval(args: {
  sessionId: string | null;
  pauseUntilIso: string;
  reason: string;
  niftySpot: number;
  gateEval: SidewaysGateEval;
  pauseKind?: string;
}): Record<string, unknown> {
  const ev = args.gateEval;
  const ceRatio = ev.ce_ratio;
  const peRatio = ev.pe_ratio;
  const ceDrop =
    ceRatio != null && Number.isFinite(ceRatio) && ceRatio > 0 && ceRatio <= 2
      ? Number(((1 - Number(ceRatio)) * 100).toFixed(2))
      : null;
  const peDrop =
    peRatio != null && Number.isFinite(peRatio) && peRatio > 0 && peRatio <= 2
      ? Number(((1 - Number(peRatio)) * 100).toFixed(2))
      : null;

  return {
    pause_until: args.pauseUntilIso,
    pause_kind: args.pauseKind || 'sideways_gate',
    session_id: args.sessionId,
    reason: String(args.reason).slice(0, 1200),
    nifty_spot: args.niftySpot,
    nifty_range_pts: ev.nifty_range_pts ?? null,
    range_source: ev.range_source ?? null,
    anchor_ce_premium: ev.anchor_ce ?? null,
    anchor_pe_premium: ev.anchor_pe ?? null,
    otm_ce_at_pause: ev.current_ce ?? null,
    otm_pe_at_pause: ev.current_pe ?? null,
    otm_ce_strike: ev.current_ce_strike ?? null,
    otm_pe_strike: ev.current_pe_strike ?? null,
    ce_drop_pct: ceDrop,
    pe_drop_pct: peDrop,
    gate_round: ev.gate_round ?? null,
    gate_eval: ev as unknown as Record<string, unknown>,
    trading_day_ist: tradingDayIstNowYmd(),
  };
}

/** Row when pause extended from post-pause recheck (Nifty delta or double-decay retest). */
function pauseEventRowRecheck(args: {
  pauseUntilIso: string;
  reason: string;
  niftySpot: number;
  pauseKind: string;
  niftyRangePts?: number | null;
  rangeSource: string;
  gateEval: Record<string, unknown>;
  anchorCE?: number | null;
  anchorPE?: number | null;
  currentCE?: number | null;
  currentPE?: number | null;
  ceDropPct?: number | null;
  peDropPct?: number | null;
}): Record<string, unknown> {
  return {
    pause_until: args.pauseUntilIso,
    pause_kind: args.pauseKind,
    session_id: null,
    reason: String(args.reason).slice(0, 1200),
    nifty_spot: args.niftySpot,
    nifty_range_pts: args.niftyRangePts === undefined ? null : args.niftyRangePts,
    range_source: args.rangeSource,
    anchor_ce_premium: args.anchorCE ?? null,
    anchor_pe_premium: args.anchorPE ?? null,
    otm_ce_at_pause: args.currentCE ?? null,
    otm_pe_at_pause: args.currentPE ?? null,
    ce_drop_pct: args.ceDropPct ?? null,
    pe_drop_pct: args.peDropPct ?? null,
    gate_round: null,
    gate_eval: args.gateEval,
    trading_day_ist: tradingDayIstNowYmd(),
  };
}

function insertMartingalePauseEventFireAndForget(supabase: any, row: Record<string, unknown>): void {
  void supabase.from('martingale_pause_events').insert(row).then(({ error }: { error: Error | null }) => {
    if (error) console.error('martingale_pause_events insert:', error);
  });
}

function compactPauseEventForReport(r: any): Record<string, unknown> {
  return {
    ist: new Date(r.recorded_at as string).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    kind: r.pause_kind,
    nifty_spot: r.nifty_spot,
    nifty_range_pts: r.nifty_range_pts,
    range_src: r.range_source,
    anchor_ce: r.anchor_ce_premium,
    anchor_pe: r.anchor_pe_premium,
    otm_ce: r.otm_ce_at_pause,
    otm_pe: r.otm_pe_at_pause,
    ce_drop_pct: r.ce_drop_pct,
    pe_drop_pct: r.pe_drop_pct,
    gate_r: r.gate_round,
    reason: typeof r.reason === 'string' ? r.reason.slice(0, 300) : '',
  };
}

function summarizePauseGateEvents(rows: any[]): Record<string, unknown> {
  if (!rows.length) {
    return {
      count: 0,
      by_kind: {},
      avg_nifty_range_pts: null,
      avg_ce_drop_pct: null,
      avg_pe_drop_pct: null,
      max_ce_drop_pct: null,
      max_pe_drop_pct: null,
    };
  }
  const byKind: Record<string, number> = {};
  for (const r of rows) {
    const k = String(r.pause_kind || 'unknown');
    byKind[k] = (byKind[k] || 0) + 1;
  }
  const num = (xs: (number | null | undefined)[]) =>
    xs.filter((x): x is number => x != null && !Number.isNaN(Number(x))).map(Number);
  const ranges = num(rows.map((r) => r.nifty_range_pts));
  const ce = num(rows.map((r) => r.ce_drop_pct));
  const pe = num(rows.map((r) => r.pe_drop_pct));
  const avg = (a: number[]) => (a.length ? Number((a.reduce((s, x) => s + x, 0) / a.length).toFixed(2)) : null);
  return {
    count: rows.length,
    by_kind: byKind,
    avg_nifty_range_pts: avg(ranges),
    avg_ce_drop_pct: avg(ce),
    avg_pe_drop_pct: avg(pe),
    max_ce_drop_pct: ce.length ? Number(Math.max(...ce).toFixed(2)) : null,
    max_pe_drop_pct: pe.length ? Number(Math.max(...pe).toFixed(2)) : null,
  };
}

async function setSidewaysPause(supabase: any, pauseReason?: string): Promise<string> {
  const pauseUntil = new Date(Date.now() + SIDEWAYS_PAUSE_DURATION_MS).toISOString();
  await supabase.from('bot_settings').upsert({
    key: 'sideways_pause_until',
    value: pauseUntil,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
  if (pauseReason != null && String(pauseReason).trim()) {
    await supabase.from('bot_settings').upsert({
      key: 'sideways_pause_reason',
      value: pauseReason.trim().slice(0, 900),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  }
  return pauseUntil;
}


// Sideways/decay pause window (`sideways_pause_until`) status for UI
async function getDecayStatus(supabase: any): Promise<any> {
  const { data: rows } = await supabase.from('bot_settings').select('key, value').in('key', [
    'sideways_pause_until',
    'sideways_pause_reason',
  ]);

  const until = rows?.find((r: any) => r.key === 'sideways_pause_until')?.value as string | undefined;
  const reasonStored =
    typeof rows?.find((r: any) => r.key === 'sideways_pause_reason')?.value === 'string'
      ? (rows!.find((r: any) => r.key === 'sideways_pause_reason')!.value as string)
      : undefined;

  if (!until) return { active: false };

  const pauseUntilMs = new Date(until).getTime();
  const isActive = Date.now() < pauseUntilMs;

  const defaultDetail =
    'Between-round gate: low Nifty range and/or CE+PE decay vs session anchors. Next start should be fresh R1 after pause.';

  return {
    active: isActive,
    pause_until: until,
    remaining_mins: isActive ? Math.ceil((pauseUntilMs - Date.now()) / 60000) : undefined,
    pause_kind: 'sideways_gate',
    title: 'Paused — sideways / range / decay gate',
    detail: reasonStored?.trim() || defaultDetail,
  };
}

async function continueSessionFromLastLoss(
  supabase: any,
  supabaseUrl: string,
  anonKey: string,
  session: any,
  lastLossTrade: any,
  tradingMode: string,
): Promise<{ success: boolean; action?: string; message?: string; telegramText?: string }> {
  const martingaleBlock = await rejectMartingaleWhenSniperSelected(supabase);
  const sessionIsSniperMode = await sessionIsSniper(supabase, session.id);
  if (martingaleBlock && !sessionIsSniperMode) {
    return { success: true, message: martingaleBlock };
  }

  const isActual = tradingMode === 'actual';
  const modeLabel = isActual ? '🔴' : '📝';
  const globalMode = await getStrategyMode(supabase);
  const sessionMode = session.strategy_mode
    ? normalizeStrategyMode(session.strategy_mode)
    : globalMode;
  const sniper = isSniperStrategy(globalMode) || isSniperStrategy(sessionMode);
  if (isSniperStrategy(globalMode) && !isSniperStrategy(sessionMode)) {
    return { success: true, message: 'Sniper mode: martingale session cannot continue — start a new sniper session.' };
  }
  if (sniper) {
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const tMin = nowIST.getHours() * 60 + nowIST.getMinutes();
    if (!sniperInTradingWindow(tMin)) {
      return { success: true, message: 'Sniper: no recovery outside 9:35–11:00 IST.' };
    }
  }
  const lastLossRound = Number(lastLossTrade?.round) || Number(session.current_round) || 1;
  const maxRounds = sniper ? SNIPER_MAX_ROUNDS : (Number(session.max_rounds) || DEFAULT_MAX_ROUNDS);

  const { data: existingOpenTrade } = await supabase
    .from('martingale_trades')
    .select('id, round')
    .eq('session_id', session.id)
    .eq('status', 'open')
    .maybeSingle();

  if (existingOpenTrade) {
    return {
      success: true,
      message: `Round ${existingOpenTrade.round} is already open for this session`,
    };
  }

  const { data: closedTrades } = await supabase
    .from('martingale_trades')
    .select('pnl')
    .eq('session_id', session.id)
    .eq('status', 'closed');

  const sessionTotalPnl = (closedTrades || []).reduce(
    (sum: number, trade: any) => sum + (Number(trade.pnl) || 0),
    0,
  );

  const newRound = lastLossRound + 1;
  if (newRound > maxRounds) {
    const action = sniper
      ? `${modeLabel} 🎯 Sniper day done — R${maxRounds} loss. Session P&L: ₹${sessionTotalPnl.toFixed(0)}. No more trades today.`
      : `${modeLabel} ⛔ MAX ROUNDS (${maxRounds}) reached. Session P&L: ₹${sessionTotalPnl.toFixed(0)}. Bot stopped — manual restart required.`;

    if (sniper) {
      await completeSniperSession(supabase, session.id, 'sniper_max_rounds', sessionTotalPnl, lastLossRound);
    } else {
      await supabase.from('martingale_sessions').update({
        status: 'max_rounds_reached',
        total_pnl: sessionTotalPnl,
        completed_at: new Date().toISOString(),
        current_round: lastLossRound,
      }).eq('id', session.id);
    }

    return {
      success: true,
      action,
      telegramText: `📊 *${sniper ? 'Sniper' : 'Martingale'} Bot*\n\n${action}`,
    };
  }

  const { optionData } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
  if (!optionData) {
    return { success: false, message: `Could not fetch new option data for round ${newRound}` };
  }

  const entryTrend = classifyTrendVsAtm(optionData.niftySpot, optionData.atmStrike);

  if (sniper && newRound === 2) {
    if (entryTrend !== 'sideways') {
      const action = `${modeLabel} 🎯 Sniper: R2 skipped — trend is "${entryTrend}" (need sideways after R1 loss). Session P&L: ₹${sessionTotalPnl.toFixed(0)}. Done for today.`;
      await completeSniperSession(supabase, session.id, 'sniper_r2_trend_block', sessionTotalPnl, lastLossRound);
      return { success: true, action, telegramText: `📊 *Sniper Bot*\n\n${action}` };
    }
  }

  const gateMinRound = sniper ? 2 : SIDEWAYS_MIN_ROUND;
  const sidewaysCheck = await shouldSkipNextRound(
    supabase,
    session.id,
    newRound,
    optionData.niftySpot,
    supabaseUrl,
    anonKey,
    optionData.otmCEPrice,
    optionData.otmPEPrice,
    optionData.otmCEStrike,
    optionData.otmPEStrike,
    gateMinRound,
  );

  if (sidewaysCheck.skip) {
    if (sniper) {
      const action = `${modeLabel} 🎯 Sniper: gate blocked R${newRound} (${sidewaysCheck.reason}). Session P&L: ₹${sessionTotalPnl.toFixed(0)}. Done for today.`;
      await completeSniperSession(supabase, session.id, 'sniper_gate_skip', sessionTotalPnl, newRound - 1);
      return { success: true, action, telegramText: `📊 *Sniper Bot*\n\n${action}` };
    }

    await supabase.from('martingale_sessions').update({
      status: 'sideways_skipped',
      total_pnl: sessionTotalPnl,
      completed_at: new Date().toISOString(),
      current_round: newRound - 1,
    }).eq('id', session.id);

    const pauseUntil = await setSidewaysPause(supabase, sidewaysCheck.reason);
    insertMartingalePauseEventFireAndForget(
      supabase,
      pauseEventRowFromSidewaysEval({
        sessionId: sanitizeSessionIdForPause(session.id),
        pauseUntilIso: pauseUntil,
        reason: sidewaysCheck.reason,
        niftySpot: optionData.niftySpot,
        gateEval: sidewaysCheck.eval,
        pauseKind: 'sideways_gate_between_rounds',
      }),
    );
    // Store Nifty spot at pause time for recheck comparison
    await supabase.from('bot_settings').upsert({
      key: 'sideways_pause_nifty_spot', value: String(optionData.niftySpot), updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
    const action = `⚠️ Sideways skip at R${newRound}. ${sidewaysCheck.reason}. Paused 15 min → fresh R1.`;

    return {
      success: true,
      action,
      telegramText: `${modeLabel} ⚠️ *Sideways Trap Detected at R${newRound}*\n\n${sidewaysCheck.reason}\n\n⏸️ Session ended. Pausing 15 min until ${new Date(pauseUntil).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.\nNext start will be fresh R1 with base lots.`,
    };
  }

  const newOptionType = lastLossTrade.option_type === 'CE' ? 'PE' : 'CE';
  if (sniper && sniperLegBlocked(newOptionType, entryTrend)) {
    const action = `${modeLabel} 🎯 Sniper: blocked ${newOptionType} in uptrend. Session P&L: ₹${sessionTotalPnl.toFixed(0)}. Done for today.`;
    await completeSniperSession(supabase, session.id, 'sniper_up_ce_block', sessionTotalPnl, lastLossRound);
    return { success: true, action, telegramText: `📊 *Sniper Bot*\n\n${action}` };
  }

  const newLots = sniper && newRound === 2 ? 2 : Math.pow(2, newRound - 1);
  const newStrike = newOptionType === 'CE' ? optionData.otmCEStrike : optionData.otmPEStrike;
  const newPrice = newOptionType === 'CE' ? optionData.otmCEPrice : optionData.otmPEPrice;
  const newInstrKey = newOptionType === 'CE' ? optionData.otmCEInstrumentKey : optionData.otmPEInstrumentKey;

  if (newPrice <= 0) {
    return { success: false, message: `Cannot enter round ${newRound}: option price is ₹0` };
  }

  let actualRoundPrice = newPrice;
  if (isActual) {
    const accessToken = await getUpstoxToken(supabase);
    if (accessToken && newInstrKey) {
      const buyResult = await placeBuyWithRetry(supabase, accessToken, {
        instrumentKey: newInstrKey,
        quantity: newLots * LOT_SIZE,
        price: newPrice,
      });

      if (!buyResult.success) {
        await pauseBotWithNotification(
          supabase,
          session.id,
          `Round ${newRound} BUY for ${newLots} lots ${newStrike} ${newOptionType} @ ₹${newPrice} failed after 3 attempts.`,
        );

        await supabase.from('martingale_sessions').update({
          current_round: newRound,
          total_pnl: sessionTotalPnl,
        }).eq('id', session.id);

        return {
          success: false,
          message: `Round ${newRound} order not filled after 3 attempts. Bot paused for 10 minutes.`,
        };
      }

      actualRoundPrice = buyResult.filledPrice;
    } else {
      return { success: false, message: 'Cannot place buy order: missing Upstox token or instrument key' };
    }
  }

  await supabase.from('martingale_sessions').update({
    status: 'active',
    current_round: newRound,
    total_pnl: sessionTotalPnl,
  }).eq('id', session.id);

  const { error: insErr } = await insertMartingaleOpenTrade(supabase, {
    session_id: session.id,
    round: newRound,
    option_type: newOptionType,
    strike_price: newStrike,
    lots: newLots,
    entry_price: actualRoundPrice,
    nifty_spot: optionData.niftySpot,
    atm_strike: optionData.atmStrike,
    entry_reason_tag: sniper ? 'sniper_r2_after_r1_loss_sideways' : 'martingale_flip_after_loss_round',
    sideways_gate_eval: sidewaysCheck.eval,
  });
  if (insErr) {
    console.error('insertMartingaleOpenTrade:', insErr);
  }

  const action = sniper
    ? `${modeLabel} 🎯 Sniper R${newRound}: ${newLots} lots ${newStrike} ${newOptionType} @ ₹${actualRoundPrice.toFixed(2)} (sideways recovery)`
    : `${modeLabel} 🔄 Round ${newRound}: Resumed from last loss. Flipped to ${newLots} lots ${newStrike} ${newOptionType} @ ₹${actualRoundPrice.toFixed(2)}`;
  return {
    success: true,
    action,
    telegramText: `📊 *Martingale Bot*\n\n${action}`,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let body: any = {};
    try { body = await req.json(); } catch {}
    const action = body.action || 'tick';

    if (action === 'status') {
      let activeSession = null;
      const { data: activeData } = await supabase
        .from('martingale_sessions')
        .select('*')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      activeSession = activeData;

      if (!activeSession) {
        const { data: pausedData } = await supabase
          .from('martingale_sessions')
          .select('*')
          .eq('status', 'paused')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        activeSession = pausedData;
      }

      let activeTrade = null;
      if (activeSession) {
        const { data } = await supabase
          .from('martingale_trades')
          .select('*')
          .eq('session_id', activeSession.id)
          .eq('status', 'open')
          .maybeSingle();
        activeTrade = data;
      }

      let currentPrice = null;
      let currentPnlPercent = null;
      let optionData: OptionChainData | null = null;

      if (activeTrade) {
        const result = await fetchNiftyOptionChain(supabaseUrl, anonKey, activeTrade.strike_price, activeTrade.option_type, activeTrade.nifty_spot, activeTrade.entry_price);
        optionData = result.optionData;
        currentPrice = result.specificPrice;
        if (currentPrice !== null) {
          currentPnlPercent = ((currentPrice - activeTrade.entry_price) / activeTrade.entry_price) * 100;
        }
      } else {
        const result = await fetchNiftyOptionChain(supabaseUrl, anonKey);
        optionData = result.optionData;
      }

      const { data: recentSessions } = await supabase
        .from('martingale_sessions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10000);

      let allTrades: any[] = [];
      let offset = 0;
      const pageSize = 5000;
      while (true) {
        const { data: trades } = await supabase
          .from('martingale_trades')
          .select('*')
          .order('entry_time', { ascending: false })
          .range(offset, offset + pageSize - 1);
        if (!trades || trades.length === 0) break;
        allTrades = allTrades.concat(trades);
        if (trades.length < pageSize) break;
        offset += pageSize;
      }

      const dailyPnl = await getDailyPnl(supabase);
      const dailyLossLimit = await getDailyLossLimit(supabase);
      const decayStatus = await getDecayStatus(supabase);
      let decayStatusForClient = decayStatus;
      if (decayStatusForClient.active && optionData?.otmCEPrice != null && optionData?.otmPEPrice != null) {
        decayStatusForClient = {
          ...decayStatusForClient,
          ce_current: optionData.otmCEPrice,
          pe_current: optionData.otmPEPrice,
        };
      }

      // Get pause info for UI — check both order-fill pause and sideways pause
      let pauseInfo: {
        paused: boolean;
        pause_until?: string;
        reason?: string;
        pause_kind?: 'order_fill' | 'sideways_gate';
      } = { paused: false };
      if (activeSession?.status === 'paused') {
        const { data: pauseData } = await supabase.from('bot_settings').select('key, value').in('key', ['pause_until', 'pause_reason']);
        if (pauseData) {
          const pauseUntil = pauseData.find((d: any) => d.key === 'pause_until')?.value;
          const pauseReason = pauseData.find((d: any) => d.key === 'pause_reason')?.value;
          pauseInfo = {
            paused: true,
            pause_until: pauseUntil,
            reason: pauseReason || 'Order fill failed after retries',
            pause_kind: 'order_fill',
          };
        }
      }
      // Also check sideways pause (no active session but bot is paused between sessions)
      if (!pauseInfo.paused && !activeSession) {
        const { optionData: statusOd } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
        const sidewaysPauseCheck = await isInSidewaysPause(
          supabase,
          activeSession?.id ?? '',
          statusOd?.niftySpot ?? 0,
          supabaseUrl,
          anonKey,
          statusOd?.otmCEPrice,
          statusOd?.otmPEPrice,
          statusOd?.otmCEStrike,
          statusOd?.otmPEStrike,
        );
        if (sidewaysPauseCheck.paused) {
          const freshDecay = await getDecayStatus(supabase);
          let freshForClient = freshDecay;
          if (
            freshDecay.active &&
            statusOd?.otmCEPrice != null &&
            statusOd?.otmPEPrice != null
          ) {
            freshForClient = {
              ...freshDecay,
              ce_current: statusOd.otmCEPrice,
              pe_current: statusOd.otmPEPrice,
            };
          }
          decayStatusForClient = freshForClient;
          pauseInfo = {
            paused: true,
            pause_until: freshDecay.pause_until,
            reason: freshDecay.detail || freshDecay.title,
            pause_kind: 'sideways_gate',
          };
        }
      }

      const { data: botRunningData } = await supabase.from('bot_settings').select('value').eq('key', 'bot_running').maybeSingle();
      const botRunning = botRunningData?.value === 'true';
      const strategyMode = await getStrategyMode(supabase);
      const botConfig = await getBotConfigForStatus(supabase);
      const sessionsToday = isSniperStrategy(strategyMode)
        ? await countSniperSessionsTodayIst(supabase)
        : await countSessionsTodayIst(supabase);
      const nowIstStatus = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const statusTimeMin = nowIstStatus.getHours() * 60 + nowIstStatus.getMinutes();
      const sniperInWindow = sniperInTradingWindow(statusTimeMin);

      // If bot is running but outside trading windows, don't show pause indicator
      // Only show pause indicators during trading windows

      return new Response(JSON.stringify({
        success: true,
        active_session: activeSession,
        active_trade: activeTrade,
        current_price: currentPrice,
        current_pnl_percent: currentPnlPercent,
        option_data: optionData,
        recent_sessions: recentSessions || [],
        all_trades: allTrades,
        daily_pnl: dailyPnl,
        daily_loss_limit: isSniperStrategy(strategyMode)
          ? await getSniperDailyLossLimit(supabase)
          : dailyLossLimit,
        decay_status: decayStatusForClient,
        pause_info: pauseInfo,
        bot_running: botRunning,
        strategy_mode: strategyMode,
        bot_config: botConfig,
        sniper_status: isSniperStrategy(strategyMode)
          ? {
              sessions_today: sessionsToday,
              in_trading_window: sniperInWindow,
              window_ist: '9:35–11:00',
            }
          : null,
        sniper_config: isSniperStrategy(strategyMode)
          ? {
              max_rounds: SNIPER_MAX_ROUNDS,
              window_ist: '9:35–11:00',
              session_loss_cap_inr: botConfig.sniper_session_loss_cap,
              daily_loss_cap_inr: botConfig.sniper_daily_loss_limit,
            }
          : null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'stop') {
      // Stop ALL active sessions (handles race condition duplicates)
      const { data: activeSessions } = await supabase
        .from('martingale_sessions')
        .select('*')
        .eq('status', 'active');

      if (activeSessions && activeSessions.length > 0) {
        for (const activeSession of activeSessions) {
          const { data: openTrade } = await supabase
            .from('martingale_trades')
            .select('*')
            .eq('session_id', activeSession.id)
            .eq('status', 'open')
            .maybeSingle();

          if (openTrade) {
            let exitPrice = openTrade.entry_price;
            const result = await fetchNiftyOptionChain(supabaseUrl, anonKey, openTrade.strike_price, openTrade.option_type, openTrade.nifty_spot, openTrade.entry_price);
            if (result.specificPrice !== null) exitPrice = result.specificPrice;
            const pnl = (exitPrice - openTrade.entry_price) * openTrade.lots * LOT_SIZE;

            if (activeSession.trading_mode === 'actual') {
              const accessToken = await getUpstoxToken(supabase);
              if (accessToken && result.specificInstrumentKey) {
                const sellResult = await placeUpstoxOrder(accessToken, {
                  instrumentKey: result.specificInstrumentKey,
                  quantity: openTrade.lots * LOT_SIZE,
                  transactionType: 'SELL',
                  price: exitPrice,
                });
                if (!sellResult.success) {
                  console.error(`Stop sell order failed: ${sellResult.error}`);
                }
              }
            }

            const exitIso = new Date().toISOString();
            await supabase.from('martingale_trades').update(
              finalizeTradeClosePatch(openTrade, exitPrice, exitIso, pnl, 'manual_stop'),
            ).eq('id', openTrade.id);

            await supabase.from('martingale_sessions').update({
              status: 'stopped', total_pnl: activeSession.total_pnl + pnl, completed_at: new Date().toISOString(),
            }).eq('id', activeSession.id);
          } else {
            await supabase.from('martingale_sessions').update({
              status: 'stopped', completed_at: new Date().toISOString(),
            }).eq('id', activeSession.id);
          }
        }
      }

      // Also stop any paused sessions
      await supabase.from('martingale_sessions').update({
        status: 'stopped', completed_at: new Date().toISOString(),
      }).eq('status', 'paused');

      // Clear sideways pause on manual stop
      await supabase.from('bot_settings').delete().eq('key', 'sideways_pause_until');
      await supabase.from('bot_settings').delete().eq('key', 'sideways_pause_reason');

      if (!body.keep_running) {
        await supabase.from('bot_settings').delete().eq('key', 'bot_running');
      }

      return new Response(JSON.stringify({ success: true, message: 'Bot stopped' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'force_stop_all') {
      // Bulk stop all active/paused sessions without P&L calculation (for cleanup)
      const { data: openForce } = await supabase.from('martingale_trades').select('*').eq('status', 'open');
      const exitIsoF = new Date().toISOString();
      for (const t of openForce || []) {
        const ep = Number(t.entry_price) || 0;
        await supabase.from('martingale_trades').update(
          finalizeTradeClosePatch(t, ep, exitIsoF, 0, 'force_stop_all'),
        ).eq('id', t.id);
      }
      await supabase.from('martingale_sessions').update({ status: 'stopped', completed_at: new Date().toISOString() }).eq('status', 'active');
      await supabase.from('martingale_sessions').update({ status: 'stopped', completed_at: new Date().toISOString() }).eq('status', 'paused');
      await supabase.from('bot_settings').delete().eq('key', 'sideways_pause_until');
      await supabase.from('bot_settings').delete().eq('key', 'sideways_pause_reason');
      await supabase.from('bot_settings').delete().eq('key', 'pause_until');
      await supabase.from('bot_settings').delete().eq('key', 'bot_running');
      return new Response(JSON.stringify({ success: true, message: 'Force stopped all sessions' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'daily_analysis') {
      let ymd = typeof body.trading_day === 'string' ? body.trading_day.trim() : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
        const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        if (!body.use_today) ist.setDate(ist.getDate() - 1);
        ymd = `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, '0')}-${String(ist.getDate()).padStart(2, '0')}`;
      }
      const report = await computeMartingaleDailyAnalysis(supabase, ymd);
      if (body.persist !== false) {
        await persistDailyAnalysisReport(supabase, ymd, report as Record<string, unknown>);
      }
      return new Response(JSON.stringify({ success: true, trading_day: ymd, report }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'weekly_analysis') {
      let mon = typeof body.week_start === 'string' ? body.week_start.trim() : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(mon)) {
        mon = previousCompletedWeekMondayYmd();
      } else {
        mon = mondayYmdContainingIst(mon);
      }
      const report = await computeMartingaleWeeklyAnalysis(supabase, mon);
      const period = report.period as { ist_week_start: string; ist_week_end: string };
      if (body.persist !== false) {
        await persistWeeklyAnalysisReport(supabase, period.ist_week_start, period.ist_week_end, report as Record<string, unknown>);
      }
      return new Response(
        JSON.stringify({
          success: true,
          week_start: period.ist_week_start,
          week_end: period.ist_week_end,
          report,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (action === 'start') {
      const tradingMode = body.trading_mode || 'paper';
      const skipDecayCheck = body.skip_decay_check === true; // Allow manual override

      const strategyBeforeStart = await getStrategyMode(supabase);
      const requestedStrategy = body.strategy_mode
        ? normalizeStrategyMode(body.strategy_mode)
        : null;

      if (
        isSniperStrategy(strategyBeforeStart) &&
        requestedStrategy === STRATEGY_MARTINGALE
      ) {
        return new Response(JSON.stringify({
          success: false,
          message:
            'Sniper daily is selected in bot settings. Martingale cannot start. Switch strategy to Martingale in the config panel first.',
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (requestedStrategy === STRATEGY_SNIPER || requestedStrategy === STRATEGY_MARTINGALE) {
        await supabase.from('bot_settings').upsert(
          { key: 'strategy_mode', value: requestedStrategy, updated_at: new Date().toISOString() },
          { onConflict: 'key' },
        );
      }

      const strategyMode = await getStrategyMode(supabase);
      const sniper = isSniperStrategy(strategyMode);

      let maxRounds = Math.min(Math.max(parseInt(body.max_rounds) || DEFAULT_MAX_ROUNDS, 1), 10);
      if (sniper) maxRounds = SNIPER_MAX_ROUNDS;

      const nowIST_start = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const startHour = nowIST_start.getHours();
      const startMinute = nowIST_start.getMinutes();
      const startTime = startHour * 60 + startMinute;
      const mktOpen = 9 * 60 + 15;
      const mktClose = 15 * 60 + 30;

      if (sniper) {
        if (!sniperInTradingWindow(startTime)) {
          return new Response(JSON.stringify({
            success: false,
            message: `Sniper mode: trade only 9:35–11:00 IST. Now ${startHour}:${String(startMinute).padStart(2, '0')} IST.`,
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (await sniperHasSessionToday(supabase)) {
          return new Response(JSON.stringify({
            success: false,
            message: 'Sniper mode: one session per day already used. Try again tomorrow.',
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      } else if (startTime < mktOpen || startTime > mktClose) {
        return new Response(JSON.stringify({ success: false, message: `Cannot start outside market hours (9:15 AM - 3:30 PM IST). Current time: ${startHour}:${String(startMinute).padStart(2, '0')} IST` }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: existing } = await supabase
        .from('martingale_sessions')
        .select('id')
        .eq('status', 'active')
        .maybeSingle();

      if (existing) {
        return new Response(JSON.stringify({ success: false, message: 'Bot already running' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Throttle guard: reject if a session was created in the last 30 seconds (prevents race conditions from concurrent ticks)
      const throttleCutoff = new Date(Date.now() - 30000).toISOString();
      const { data: recentSession } = await supabase
        .from('martingale_sessions')
        .select('id')
        .gte('created_at', throttleCutoff)
        .limit(1)
        .maybeSingle();

      if (recentSession) {
        return new Response(JSON.stringify({ success: false, message: 'Session created recently, throttling duplicate start' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { optionData } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
      if (!optionData) {
        return new Response(JSON.stringify({ success: false, message: 'Could not fetch option chain data' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Check for sideways pause before starting (uses chain for spot/strikes on gate recheck)
      if (!skipDecayCheck) {
        const sidewaysPause = await isInSidewaysPause(
          supabase,
          '',
          optionData.niftySpot,
          supabaseUrl,
          anonKey,
          optionData.otmCEPrice,
          optionData.otmPEPrice,
          optionData.otmCEStrike,
          optionData.otmPEStrike,
        );
        if (sidewaysPause.paused) {
          return new Response(JSON.stringify({ 
            success: false, 
            message: `⚠️ Sideways market detected — paused for ${sidewaysPause.remainingMins} min. Will auto-restart as fresh R1.`,
            decay_paused: true,
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      if (tradingMode === 'actual') {
        const accessToken = await getUpstoxToken(supabase);
        if (!accessToken) {
          return new Response(JSON.stringify({ success: false, message: 'Cannot start actual trading: Upstox not connected. Please login to Upstox first.' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      let entryOptionType = 'CE';
      let hadPriorSession = false;

      if (sniper) {
        if (optionData.niftySpot < optionData.atmStrike) {
          entryOptionType = 'PE';
        } else if (optionData.niftySpot > optionData.atmStrike) {
          entryOptionType = 'CE';
        } else {
          entryOptionType = 'PE';
        }
        const startTrend = classifyTrendVsAtm(optionData.niftySpot, optionData.atmStrike);
        if (sniperLegBlocked(entryOptionType, startTrend)) {
          entryOptionType = entryOptionType === 'CE' ? 'PE' : 'CE';
        }
        if (sniperLegBlocked(entryOptionType, startTrend)) {
          return new Response(JSON.stringify({
            success: false,
            message: 'Sniper mode: skip today — only up+CE would be available (blocked).',
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        console.log(`Sniper R1 start: spot=${optionData.niftySpot}, atm=${optionData.atmStrike}, trend=${startTrend}, leg=${entryOptionType}`);
      } else {
        const { data: lastSession } = await supabase
          .from('martingale_sessions')
          .select('id, status')
          .neq('status', 'active')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        hadPriorSession = !!lastSession;
        if (lastSession) {
          const { data: lastTrade } = await supabase
            .from('martingale_trades')
            .select('option_type, pnl')
            .eq('session_id', lastSession.id)
            .order('entry_time', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (lastTrade) {
            if (lastTrade.pnl !== null && lastTrade.pnl > 0) {
              entryOptionType = lastTrade.option_type;
            } else {
              entryOptionType = lastTrade.option_type === 'CE' ? 'PE' : 'CE';
            }
            console.log(`Direction from last session: lastTrade=${lastTrade.option_type}, pnl=${lastTrade.pnl}, chosen=${entryOptionType}`);
          }
        } else {
          if (optionData.niftySpot < optionData.atmStrike) {
            entryOptionType = 'PE';
          }
          console.log(`First session, trend-based: spot=${optionData.niftySpot}, atm=${optionData.atmStrike}, chosen=${entryOptionType}`);
        }
      }

      const entryStrike = entryOptionType === 'CE' ? optionData.otmCEStrike : optionData.otmPEStrike;
      const entryPrice = entryOptionType === 'CE' ? optionData.otmCEPrice : optionData.otmPEPrice;
      const entryInstrumentKey = entryOptionType === 'CE' ? optionData.otmCEInstrumentKey : optionData.otmPEInstrumentKey;

      if (entryPrice <= 0) {
        return new Response(JSON.stringify({ success: false, message: `Cannot start: ${entryOptionType} option price is ₹0. Source: ${optionData.source || 'unknown'}` }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      let actualEntryPrice = entryPrice;
      if (tradingMode === 'actual') {
        const accessToken = await getUpstoxToken(supabase);
        if (!accessToken || !entryInstrumentKey) {
          return new Response(JSON.stringify({ success: false, message: 'Cannot place order: missing Upstox token or instrument key' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const buyResult = await placeBuyWithRetry(supabase, accessToken, {
          instrumentKey: entryInstrumentKey,
          quantity: 1 * LOT_SIZE,
          price: entryPrice,
        });
        if (!buyResult.success) {
          const { data: pausedSession } = await supabase
            .from('martingale_sessions')
            .insert({
              status: 'paused',
              current_round: 1,
              max_rounds: maxRounds,
              trading_mode: tradingMode,
              strategy_mode: strategyMode,
            })
            .select().single();
          if (pausedSession) {
            await pauseBotWithNotification(supabase, pausedSession.id, 
              `BUY order for ${entryStrike} ${entryOptionType} @ ₹${entryPrice} failed to fill after 3 attempts.`);
          }
          return new Response(JSON.stringify({ success: false, message: `Order not filled after 3 attempts. Bot paused for 10 minutes. ${buyResult.error}` }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        actualEntryPrice = buyResult.filledPrice;
      }

      // Double-check for active session right before insert (race condition guard)
      const { data: existingRecheck } = await supabase
        .from('martingale_sessions')
        .select('id')
        .eq('status', 'active')
        .maybeSingle();
      if (existingRecheck) {
        return new Response(JSON.stringify({ success: false, message: 'Bot already running (race guard)' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Also check if a session was created very recently (within last 30s) to prevent rapid duplicates
      const recentCutoff = new Date(Date.now() - 30000).toISOString();
      const { data: recentSession2 } = await supabase
        .from('martingale_sessions')
        .select('id')
        .gte('created_at', recentCutoff)
        .limit(1)
        .maybeSingle();
      if (recentSession2) {
        return new Response(JSON.stringify({ success: false, message: 'Session created recently, skipping duplicate start' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const anchorCe =
        typeof optionData.otmCEPrice === 'number' && optionData.otmCEPrice > 0 ? optionData.otmCEPrice : null;
      const anchorPe =
        typeof optionData.otmPEPrice === 'number' && optionData.otmPEPrice > 0 ? optionData.otmPEPrice : null;

      const { data: session, error: sessErr } = await supabase
        .from('martingale_sessions')
        .insert({
          status: 'active',
          current_round: 1,
          max_rounds: maxRounds,
          trading_mode: tradingMode,
          strategy_mode: strategyMode,
          anchor_otm_ce_premium: anchorCe,
          anchor_otm_pe_premium: anchorPe,
        })
        .select()
        .single();
      if (sessErr) throw sessErr;

      const startTag = sniper
        ? 'sniper_r1_session_start'
        : hadPriorSession
          ? 'session_start_carry_direction_from_prior'
          : 'session_start_first_trend_ce_pe';
      const { error: tradeErr } = await insertMartingaleOpenTrade(supabase, {
        session_id: session.id,
        round: 1,
        option_type: entryOptionType,
        strike_price: entryStrike,
        lots: 1,
        entry_price: actualEntryPrice,
        nifty_spot: optionData.niftySpot,
        atm_strike: optionData.atmStrike,
        entry_reason_tag: startTag,
      });
      if (tradeErr) throw tradeErr;

      await supabase.from('bot_settings').upsert({ key: 'bot_running', value: 'true', updated_at: new Date().toISOString() }, { onConflict: 'key' });

      const modeLabel = tradingMode === 'actual' ? '🔴 ACTUAL' : '📝 Paper';
      const stratLabel = sniper ? 'Sniper' : 'Martingale';
      return new Response(JSON.stringify({
        success: true,
        message: `${modeLabel} ${stratLabel} started — 1 lot ${entryStrike} ${entryOptionType} @ ₹${entryPrice}${sniper ? ' (max R2, 9:35–11:00)' : ''}`,
        session,
        strategy_mode: strategyMode,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // action === 'tick' or 'cron-tick'
    const isCronTick = action === 'cron-tick';
    const source = body.source || (isCronTick ? 'cron' : 'ui');
    const tickCount = isCronTick ? 4 : 1;
    const tickResults: string[] = [];

    const tickGlobalStrategy = await getStrategyMode(supabase);
    if (isSniperStrategy(tickGlobalStrategy)) {
      await haltMartingaleSessionsForSniperMode(supabase, supabaseUrl, anonKey);
    }

    // ========== AUTO-SCHEDULE LOGIC (only on cron-tick) ==========
    if (isCronTick) {
      const nowIST_sched = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const schedHour = nowIST_sched.getHours();
      const schedMinute = nowIST_sched.getMinutes();
      const schedTime = schedHour * 60 + schedMinute;
      const schedDay = nowIST_sched.getDay();

      // Year-specific NSE holidays (YYYY-MM-DD format)
      const NSE_HOLIDAYS: string[] = [
        // 2025
        '2025-02-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14', '2025-04-18', '2025-05-01', '2025-08-12', '2025-08-15', '2025-08-27', '2025-10-02', '2025-10-20', '2025-10-21', '2025-11-05', '2025-12-25',
        // 2026
        '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
      ];

      const schedYMD = `${nowIST_sched.getFullYear()}-${String(nowIST_sched.getMonth() + 1).padStart(2, '0')}-${String(nowIST_sched.getDate()).padStart(2, '0')}`;
      const isMarketDay = schedDay !== 0 && schedDay !== 6 && !NSE_HOLIDAYS.includes(schedYMD);
      const isExpiryDay = schedDay === 2;

      const schedStrategy = await getStrategyMode(supabase);
      const schedSniper = isSniperStrategy(schedStrategy);

      const MARTINGALE_AUTO_START_1 = 9 * 60 + 25;
      const MARTINGALE_AUTO_STOP_1 = 11 * 60 + 15;
      const MARTINGALE_AUTO_START_2 = 14 * 60 + 30;
      const SNIPER_AUTO_STOP = SNIPER_WINDOW_END_MIN; // 11:00 IST

      const { data: existingSession } = await supabase
        .from('martingale_sessions')
        .select('id, status')
        .eq('status', 'active')
        .maybeSingle();

      const dailyPnlSched = await getDailyPnl(supabase);
      const dailyLossLimitSched = schedSniper
        ? await getSniperDailyLossLimit(supabase)
        : await getDailyLossLimit(supabase);
      const isDailyLossHit = dailyPnlSched <= -dailyLossLimitSched;

      const inSniperSchedWindow = sniperInTradingWindow(schedTime);

      if (schedSniper) {
        await haltMartingaleSessionsForSniperMode(supabase, supabaseUrl, anonKey);
      }

      if (schedSniper && isMarketDay && inSniperSchedWindow && !isDailyLossHit) {
        const sniperStartMsg = await trySniperAutoStartIfNeeded(supabase, supabaseUrl, anonKey);
        if (sniperStartMsg) tickResults.push(sniperStartMsg);
      } else if (
        !schedSniper &&
        isMarketDay &&
        !isDailyLossHit &&
        ((schedTime >= MARTINGALE_AUTO_START_1 && schedTime < MARTINGALE_AUTO_START_1 + 1) ||
          (!isExpiryDay && schedTime >= MARTINGALE_AUTO_START_2 && schedTime < MARTINGALE_AUTO_START_2 + 1))
      ) {
        if (!existingSession) {
          const { optionData: cronOd } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
          const sidewaysPause = await isInSidewaysPause(
            supabase,
            '',
            cronOd?.niftySpot ?? 0,
            supabaseUrl,
            anonKey,
            cronOd?.otmCEPrice,
            cronOd?.otmPEPrice,
            cronOd?.otmCEStrike,
            cronOd?.otmPEStrike,
          );
          let shouldStart = true;
          if (sidewaysPause.paused) {
            shouldStart = false;
            tickResults.push(`⚠️ Sideways pause active. Skipping auto-start. ${sidewaysPause.remainingMins} min remaining.`);
          }
          if (shouldStart) {
            const { data: settings } = await supabase.from('bot_settings').select('key, value');
            let savedMode = 'paper';
            let savedMaxRounds = DEFAULT_MAX_ROUNDS;
            if (settings) {
              for (const s of settings) {
                if (s.key === 'trading_mode') savedMode = s.value;
                if (s.key === 'max_rounds') savedMaxRounds = Math.min(Math.max(parseInt(s.value) || DEFAULT_MAX_ROUNDS, 1), 10);
              }
            }
            const startRes = await fetch(`${supabaseUrl}/functions/v1/martingale-bot`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
              body: JSON.stringify({
                action: 'start',
                trading_mode: savedMode,
                max_rounds: savedMaxRounds,
                skip_decay_check: true,
              }),
            });
            const startData = await startRes.json();
            const timeLabel = schedTime >= MARTINGALE_AUTO_START_2 ? '2:30 PM' : '9:25 AM';
            tickResults.push(`⏰ Auto-start (${timeLabel}): ${startData.message || 'started'}`);
            await sendTelegram(`⏰ *Auto-Start (${timeLabel})*\n${startData.message || 'Bot started automatically'}`);
          }
        }
      }

      // --- Auto-stop at end of morning window ---
      if (schedSniper) {
        if (schedTime >= SNIPER_AUTO_STOP && schedTime < SNIPER_AUTO_STOP + 1) {
          if (existingSession) {
            const stopRes = await fetch(`${supabaseUrl}/functions/v1/martingale-bot`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
              body: JSON.stringify({ action: 'stop' }),
            });
            const stopData = await stopRes.json();
            tickResults.push(`⏰ Sniper auto-stop (11:00 AM): ${stopData.message || 'stopped'}`);
            await sendTelegram(`⏰ *Sniper Auto-Stop (11:00)*\nMorning window ended — bot stopped.`);
          } else {
            await stopSniperBotForDay(supabase);
            tickResults.push('⏰ Sniper: 11:00 AM — bot_running cleared for the day.');
          }
        }
      } else if (schedTime >= MARTINGALE_AUTO_STOP_1 && schedTime < MARTINGALE_AUTO_STOP_1 + 1) {
        if (existingSession) {
          const stopRes = await fetch(`${supabaseUrl}/functions/v1/martingale-bot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
            body: JSON.stringify({ action: 'stop', keep_running: true }),
          });
          const stopData = await stopRes.json();
          tickResults.push(`⏰ Auto-stop (11:15 AM): ${stopData.message || 'stopped'}`);
          await sendTelegram(`⏰ *Auto-Stop (11:15 AM)*\nBot squared off and stopped automatically`);
          return new Response(JSON.stringify({
            success: true, ticks: tickResults.length, actions: tickResults,
            action: tickResults[tickResults.length - 1],
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }
    }
    // ========== END AUTO-SCHEDULE ==========

    for (let tickIdx = 0; tickIdx < tickCount; tickIdx++) {
      if (tickIdx > 0) {
        await new Promise(resolve => setTimeout(resolve, 15000));
      }

      const tickResult = await runSingleTick(supabase, supabaseUrl, anonKey, source);
      tickResults.push(tickResult.action || tickResult.message || 'tick done');
    }

    return new Response(JSON.stringify({
      success: true,
      ticks: tickResults.length,
      actions: tickResults,
      action: tickResults[tickResults.length - 1],
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error("Martingale bot error:", error);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// Single tick logic
async function runSingleTick(supabase: any, supabaseUrl: string, anonKey: string, source: string): Promise<any> {
    const nowIST_tick = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const tickDay = nowIST_tick.getDay();
    const tickYMD = `${nowIST_tick.getFullYear()}-${String(nowIST_tick.getMonth() + 1).padStart(2, '0')}-${String(nowIST_tick.getDate()).padStart(2, '0')}`;

    // NSE holidays - must match the list in auto-schedule
    const NSE_HOLIDAYS_TICK: string[] = [
      '2025-02-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14', '2025-04-18', '2025-05-01', '2025-08-12', '2025-08-15', '2025-08-27', '2025-10-02', '2025-10-20', '2025-10-21', '2025-11-05', '2025-12-25',
      '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
    ];

    const isMarketDayTick = tickDay !== 0 && tickDay !== 6 && !NSE_HOLIDAYS_TICK.includes(tickYMD);

    if (!isMarketDayTick) {
      return { action: `⛔ Market closed today (${tickYMD}, day=${tickDay}). Skipping tick.` };
    }

    await haltMartingaleSessionsForSniperMode(supabase, supabaseUrl, anonKey);

    const tickHour = nowIST_tick.getHours();
    const tickMinute = nowIST_tick.getMinutes();
    const tickTime = tickHour * 60 + tickMinute;
    const tickStrategyMode = await getStrategyMode(supabase);
    const tickSniper = isSniperStrategy(tickStrategyMode);

    if (tickSniper) {
      const sniperAutoMsg = await trySniperAutoStartIfNeeded(supabase, supabaseUrl, anonKey);
      if (sniperAutoMsg?.startsWith('Sniper auto-started:')) {
        return { success: true, action: sniperAutoMsg };
      }
    }

    const inTradingWindow = tickSniper
      ? sniperInTradingWindow(tickTime)
      : martingaleInTradingWindow(tickTime, tickDay);

    if (!inTradingWindow) {
      if (tickSniper) {
        await stopSniperBotForDay(supabase);
      }
      // If there are active sessions outside windows, square them ALL off
      const { data: activeOutsideList } = await supabase
        .from('martingale_sessions')
        .select('*')
        .eq('status', 'active');
      
      if (activeOutsideList && activeOutsideList.length > 0) {
        for (const activeOutside of activeOutsideList) {
          const { data: openTradeOutside } = await supabase
            .from('martingale_trades')
            .select('*')
            .eq('session_id', activeOutside.id)
            .eq('status', 'open')
            .maybeSingle();
          
          if (openTradeOutside) {
            const { specificPrice: sqPrice, specificInstrumentKey: sqInstrKey } = await fetchNiftyOptionChain(
              supabaseUrl, anonKey, openTradeOutside.strike_price, openTradeOutside.option_type, openTradeOutside.nifty_spot, openTradeOutside.entry_price
            );
            const exitPrice = sqPrice !== null ? sqPrice : openTradeOutside.entry_price;
            const sqPnl = (exitPrice - openTradeOutside.entry_price) * openTradeOutside.lots * LOT_SIZE;

            if (activeOutside.trading_mode === 'actual') {
              const accessToken = await getUpstoxToken(supabase);
              if (accessToken && sqInstrKey) {
                await placeUpstoxOrder(accessToken, {
                  instrumentKey: sqInstrKey,
                  quantity: openTradeOutside.lots * LOT_SIZE,
                  transactionType: 'SELL',
                  price: exitPrice,
                });
              }
            }

            const exitIsoW = new Date().toISOString();
            await supabase.from('martingale_trades').update(
              finalizeTradeClosePatch(openTradeOutside, exitPrice, exitIsoW, sqPnl, 'window_close_midday_or_gap'),
            ).eq('id', openTradeOutside.id);

            await supabase.from('martingale_sessions').update({
              status: 'squared_off', total_pnl: activeOutside.total_pnl + sqPnl, completed_at: new Date().toISOString(),
            }).eq('id', activeOutside.id);

            const modeLabel = activeOutside.trading_mode === 'actual' ? '🔴' : '📝';
            const windowLabel = tickSniper ? '11:00 AM' : (tickTime > 11 * 60 + 15 && tickTime < 14 * 60 + 30 ? '11:15 AM' : '3:25 PM');
            await sendTelegram(`${modeLabel} ⏰ *Window Closed (${windowLabel})*\nSquared off ${openTradeOutside.option_type} ${openTradeOutside.strike_price} @ ₹${exitPrice} (P&L: ₹${sqPnl.toFixed(0)})`);
          } else {
            await supabase.from('martingale_sessions').update({
              status: 'squared_off', completed_at: new Date().toISOString(),
            }).eq('id', activeOutside.id);
          }
        }
      }

      const stratLabel = tickSniper ? 'Sniper' : 'Martingale';
      return {
        success: true,
        message: `${stratLabel}: outside trading window (${tickHour}:${String(tickMinute).padStart(2, '0')} IST). Next: ${nextWindowHint(tickStrategyMode, tickTime)}.`,
      };
    }

    // Check for paused session — auto-resume after 10 minutes
    const { data: pausedSession } = await supabase
      .from('martingale_sessions')
      .select('*')
      .eq('status', 'paused')
      .maybeSingle();

    if (pausedSession) {
      const { data: pauseData } = await supabase
        .from('bot_settings')
        .select('value')
        .eq('key', 'pause_until')
        .maybeSingle();

      if (pauseData?.value) {
        const pauseUntil = new Date(pauseData.value).getTime();
        if (Date.now() < pauseUntil) {
          const remainMins = Math.ceil((pauseUntil - Date.now()) / 60000);
          return { success: true, message: `Bot paused. Resuming in ~${remainMins} min.` };
        }
      }

      // Pause period over — resume
      await supabase.from('martingale_sessions').update({
        status: 'pause_expired', completed_at: new Date().toISOString(),
      }).eq('id', pausedSession.id);

      await supabase.from('bot_settings').delete().eq('key', 'pause_until');

      const { data: settings } = await supabase.from('bot_settings').select('key, value');
      let savedMode = pausedSession.trading_mode || 'paper';
      let savedMaxRounds = pausedSession.max_rounds || DEFAULT_MAX_ROUNDS;
      if (settings) {
        for (const s of settings) {
          if (s.key === 'trading_mode') savedMode = s.value;
          if (s.key === 'max_rounds') savedMaxRounds = Math.min(Math.max(parseInt(s.value) || DEFAULT_MAX_ROUNDS, 1), 10);
        }
      }

      const pauseStrat = await getStrategyMode(supabase);
      const pauseSniper = isSniperStrategy(pauseStrat);
      if (pauseSniper && !sniperInTradingWindow(tickTime)) {
        return { success: true, message: 'Sniper: cannot resume — outside 9:35–11:00 window.' };
      }
      const startRes = await fetch(`${supabaseUrl}/functions/v1/martingale-bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
        body: JSON.stringify({
          action: 'start',
          trading_mode: savedMode,
          max_rounds: pauseSniper ? SNIPER_MAX_ROUNDS : savedMaxRounds,
          strategy_mode: pauseStrat,
        }),
      });
      const startData = await startRes.json();
      await sendTelegram(`▶️ *Bot Resumed after 10-min pause*\n${startData.message || 'Restarted'}`);
      return { success: true, action: `▶️ Resumed after pause: ${startData.message || 'restarted'}` };
    }

    // Check for decay pause — when no active session, periodically recheck decay
    const { data: activeCheck } = await supabase
      .from('martingale_sessions')
      .select('id')
      .eq('status', 'active')
      .maybeSingle();

    if (!activeCheck) {
      // Check sideways_pause_until key BEFORE isInSidewaysPause clears it
      const { data: rawPauseData } = await supabase
        .from('bot_settings')
        .select('value')
        .eq('key', 'sideways_pause_until')
        .maybeSingle();
      
      const hadSidewaysPause = !!rawPauseData?.value;
      const { optionData: tickDecayOd } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
      const sidewaysPause = await isInSidewaysPause(
        supabase,
        '',
        tickDecayOd?.niftySpot ?? 0,
        supabaseUrl,
        anonKey,
        tickDecayOd?.otmCEPrice,
        tickDecayOd?.otmPEPrice,
        tickDecayOd?.otmCEStrike,
        tickDecayOd?.otmPEStrike,
      );

      if (sidewaysPause.paused) {
        return { success: true, message: `⚠️ Sideways pause: ${sidewaysPause.remainingMins} min remaining. Will restart as fresh R1.` };
      }

      // Only auto-restart if a sideways pause key existed and just expired (was cleared by isInSidewaysPause)
      if (hadSidewaysPause && !sidewaysPause.paused) {
        const resumeStrat = await getStrategyMode(supabase);
        const resumeSniper = isSniperStrategy(resumeStrat);
        const inMorningWindow = resumeSniper
          ? sniperInTradingWindow(tickTime)
          : tickTime >= (9 * 60 + 25) && tickTime <= (11 * 60 + 15);
        const inAfternoonWindow = !resumeSniper && tickDay !== 2 && tickTime >= (14 * 60 + 30) && tickTime <= (15 * 60 + 25);
        if (inMorningWindow || inAfternoonWindow) {
          const dailyPnl = await getDailyPnl(supabase);
          const dailyLimit = resumeSniper ? await getSniperDailyLossLimit(supabase) : await getDailyLossLimit(supabase);
          if (dailyPnl <= -dailyLimit) {
            return { success: true, message: `Daily loss limit breached (₹${dailyPnl.toFixed(0)}). Not auto-restarting after sideways pause.` };
          }

          // RECHECK: Fetch fresh market data and verify sideways conditions have cleared
          const { optionData } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
          if (optionData && optionData.niftySpot > 0) {
            // Get the Nifty spot stored when the pause was first triggered
            const { data: pauseSpotData } = await supabase.from('bot_settings').select('value').eq('key', 'sideways_pause_nifty_spot').maybeSingle();
            const pauseSpot = pauseSpotData ? parseFloat(pauseSpotData.value) : 0;

            // Check Nifty range: if spot hasn't moved enough from pause time, still sideways
            if (pauseSpot > 0) {
              const niftyRange = Math.abs(optionData.niftySpot - pauseSpot);
              if (niftyRange < SIDEWAYS_RECHECK_THRESHOLD) {
                // Update stored spot to current for next recheck cycle
                await supabase.from('bot_settings').upsert({
                  key: 'sideways_pause_nifty_spot', value: String(optionData.niftySpot), updated_at: new Date().toISOString(),
                }, { onConflict: 'key' });
                const extendReason = `Sideways recheck: Nifty moved only ${niftyRange.toFixed(0)} pts (need ${SIDEWAYS_RECHECK_THRESHOLD} pts). Spot ${optionData.niftySpot} vs pause spot ${pauseSpot.toFixed(0)}.`;
                const newPauseUntil = await setSidewaysPause(supabase, extendReason);
                insertMartingalePauseEventFireAndForget(
                  supabase,
                  pauseEventRowRecheck({
                    pauseUntilIso: newPauseUntil,
                    reason: extendReason,
                    niftySpot: optionData.niftySpot,
                    pauseKind: 'sideways_recheck_nifty_delta',
                    niftyRangePts: niftyRange,
                    rangeSource: 'pause_spot_delta',
                    gateEval: {
                      pause_spot: pauseSpot,
                      current_spot: optionData.niftySpot,
                      recheck_threshold_pts: SIDEWAYS_RECHECK_THRESHOLD,
                    },
                    currentCE: optionData.otmCEPrice,
                    currentPE: optionData.otmPEPrice,
                  }),
                );
                await sendTelegram(`⚠️ *Sideways recheck failed*\nNifty moved only ${niftyRange.toFixed(0)}pts (need ${SIDEWAYS_RECHECK_THRESHOLD}pts). Spot: ${optionData.niftySpot} vs pause: ${pauseSpot.toFixed(0)}\nRe-pausing 15 min until ${new Date(newPauseUntil).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
                return { success: true, message: `⚠️ Sideways recheck: Nifty range ${niftyRange.toFixed(0)}pts < ${SIDEWAYS_RECHECK_THRESHOLD}pts. Re-paused 15 min.` };
              }
            }

            // RECHECK double decay: even if Nifty moved enough, check if both OTM premiums are still decaying
            const currentCE = optionData.otmCEPrice;
            const currentPE = optionData.otmPEPrice;
            if (currentCE > 0 && currentPE > 0) {
              // Find most recent completed session for premium anchors
              const { data: lastSession } = await supabase
                .from('martingale_sessions')
                .select('id')
                .eq('status', 'completed')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

              if (lastSession) {
                const { data: lastSessionTrades } = await supabase
                  .from('martingale_trades')
                  .select('nifty_spot, entry_price, option_type, round, entry_time')
                  .eq('session_id', lastSession.id)
                  .order('entry_time', { ascending: true });

                const { anchorCE, anchorPE } = await getSessionPremiumAnchors(supabase, lastSession.id, lastSessionTrades);

                if (anchorCE != null && anchorPE != null && anchorCE > 0 && anchorPE > 0) {
                  const ceRatio = currentCE / anchorCE;
                  const peRatio = currentPE / anchorPE;
                  const stillDoubleDecay = ceRatio < SIDEWAYS_PREMIUM_DECLINE_RATIO && peRatio < SIDEWAYS_PREMIUM_DECLINE_RATIO;

                  if (stillDoubleDecay) {
                    // Update stored spot to current for next recheck cycle
                    await supabase.from('bot_settings').upsert({
                      key: 'sideways_pause_nifty_spot', value: String(optionData.niftySpot), updated_at: new Date().toISOString(),
                    }, { onConflict: 'key' });
                    const ceDecay = ((1 - ceRatio) * 100).toFixed(1);
                    const peDecay = ((1 - peRatio) * 100).toFixed(1);
                    const extendReason = `Post-pause recheck: both OTM premiums still decaying vs anchors (CE ${ceDecay}% down, PE ${peDecay}% down).`;
                    const newPauseUntil = await setSidewaysPause(supabase, extendReason);
                    insertMartingalePauseEventFireAndForget(
                      supabase,
                      pauseEventRowRecheck({
                        pauseUntilIso: newPauseUntil,
                        reason: extendReason,
                        niftySpot: optionData.niftySpot,
                        pauseKind: 'sideways_recheck_double_decay',
                        niftyRangePts: null,
                        rangeSource: 'post_pause_anchor_premium',
                        gateEval: {
                          anchor_session_id: lastSession.id,
                          ce_ratio: Number(ceRatio.toFixed(4)),
                          pe_ratio: Number(peRatio.toFixed(4)),
                          decay_ratio_gate: SIDEWAYS_PREMIUM_DECLINE_RATIO,
                        },
                        anchorCE,
                        anchorPE,
                        currentCE,
                        currentPE,
                        ceDropPct: Number(((1 - ceRatio) * 100).toFixed(2)),
                        peDropPct: Number(((1 - peRatio) * 100).toFixed(2)),
                      }),
                    );
                    await sendTelegram(`⚠️ *Double decay still active*\nNifty moved but both premiums still decaying.\nCE: ₹${anchorCE.toFixed(0)}→₹${currentCE.toFixed(0)} (${ceDecay}% down)\nPE: ₹${anchorPE.toFixed(0)}→₹${currentPE.toFixed(0)} (${peDecay}% down)\nRe-pausing 15 min until ${new Date(newPauseUntil).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
                    return { success: true, message: `⚠️ Double decay recheck: both premiums still decaying (CE ${ceDecay}%, PE ${peDecay}%). Re-paused 15 min.` };
                  }
                }
              }
            }

            // Clean up pause spot
            await supabase.from('bot_settings').delete().eq('key', 'sideways_pause_nifty_spot');
          }

          // Market has moved — proceed with auto-start
          const { data: settings } = await supabase.from('bot_settings').select('key, value');
          let savedMode = 'paper';
          let savedMaxRounds = DEFAULT_MAX_ROUNDS;
          if (settings) {
            for (const s of settings) {
              if (s.key === 'trading_mode') savedMode = s.value;
              if (s.key === 'max_rounds') savedMaxRounds = Math.min(Math.max(parseInt(s.value) || DEFAULT_MAX_ROUNDS, 1), 10);
            }
          }

          if (resumeSniper) savedMaxRounds = SNIPER_MAX_ROUNDS;
          const startRes = await fetch(`${supabaseUrl}/functions/v1/martingale-bot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
            body: JSON.stringify({
              action: 'start',
              trading_mode: savedMode,
              max_rounds: savedMaxRounds,
              strategy_mode: resumeStrat,
            }),
          });
          const startData = await startRes.json();
          await sendTelegram(`▶️ *Bot Resumed after sideways pause*\nMarket movement confirmed — restarting as fresh R1`);
          return { success: true, action: `▶️ Resumed after sideways pause: ${startData.message || 'restarted'}` };
        }
      }

      // Auto-restart if bot_running flag is set and within trading windows
      const { data: botRunningFlag } = await supabase.from('bot_settings').select('value').eq('key', 'bot_running').maybeSingle();
      if (botRunningFlag?.value === 'true') {
        // Guard: skip auto-restart if a session was created in the last 60 seconds
        const recentCutoff = new Date(Date.now() - 60000).toISOString();
        const { data: recentSess } = await supabase
          .from('martingale_sessions')
          .select('id')
          .gte('created_at', recentCutoff)
          .limit(1)
          .maybeSingle();
        if (recentSess) {
          return { success: true, message: 'Session created recently, skipping auto-restart' };
        }

        const autoStrat = await getStrategyMode(supabase);
        const autoSniper = isSniperStrategy(autoStrat);
        const inMorningWindow = autoSniper
          ? sniperInTradingWindow(tickTime)
          : tickTime >= (9 * 60 + 25) && tickTime <= (11 * 60 + 15);
        const inAfternoonWindow = !autoSniper && !isExpiryDayTick && tickTime >= (14 * 60 + 30) && tickTime <= (15 * 60 + 25);
        const canAutoStartToday = !autoSniper || !(await sniperHasSessionToday(supabase));
        if ((inMorningWindow || inAfternoonWindow) && canAutoStartToday) {
          const dailyPnl = await getDailyPnl(supabase);
          const dailyLimit = autoSniper ? await getSniperDailyLossLimit(supabase) : await getDailyLossLimit(supabase);
          if (dailyPnl > -dailyLimit) {
            const { data: settings } = await supabase.from('bot_settings').select('key, value');
            let savedMode = 'paper';
            let savedMaxRounds = DEFAULT_MAX_ROUNDS;
            if (settings) {
              for (const s of settings) {
                if (s.key === 'trading_mode') savedMode = s.value;
                if (s.key === 'max_rounds') savedMaxRounds = Math.min(Math.max(parseInt(s.value) || DEFAULT_MAX_ROUNDS, 1), 10);
              }
            }
            if (autoSniper) savedMaxRounds = SNIPER_MAX_ROUNDS;
            const startRes = await fetch(`${supabaseUrl}/functions/v1/martingale-bot`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
              body: JSON.stringify({
                action: 'start',
                trading_mode: savedMode,
                max_rounds: savedMaxRounds,
                strategy_mode: autoStrat,
              }),
            });
            const startData = await startRes.json();
            return { success: true, action: `▶️ Auto-restarted: ${startData.message || 'new session'}` };
          } else {
            return { success: true, message: `⚠️ Bot watching — daily loss limit hit` };
          }
        } else if (autoSniper && !canAutoStartToday) {
          return { success: true, message: '⏸️ Sniper: today\'s session already used' };
        } else {
          return { success: true, message: `⏸️ Bot watching — outside trading window` };
        }
      }

      return { success: true, message: 'No active session' };
    }

    // Get ALL active sessions, keep latest, close duplicates
    const { data: allActiveSessions } = await supabase
      .from('martingale_sessions')
      .select('*')
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    let activeSession: any = null;
    if (allActiveSessions && allActiveSessions.length > 0) {
      activeSession = allActiveSessions[0]; // Keep the latest
      // Close any duplicates
      if (allActiveSessions.length > 1) {
        console.log(`⚠️ Found ${allActiveSessions.length} active sessions — cleaning up duplicates`);
        for (let i = 1; i < allActiveSessions.length; i++) {
          const dup = allActiveSessions[i];
          // Close any open trades on the duplicate
          const { data: dupTrades } = await supabase
            .from('martingale_trades')
            .select('*')
            .eq('session_id', dup.id)
            .eq('status', 'open');
          if (dupTrades) {
            const exitIsoDup = new Date().toISOString();
            for (const t of dupTrades) {
              const ep = Number(t.entry_price) || 0;
              await supabase.from('martingale_trades').update(
                finalizeTradeClosePatch(t, ep, exitIsoDup, 0, 'duplicate_session_cleanup'),
              ).eq('id', t.id);
            }
          }
          await supabase.from('martingale_sessions').update({
            status: 'completed', completed_at: new Date().toISOString(),
          }).eq('id', dup.id);
        }
      }
    }

    if (!activeSession) {
      return { success: true, message: 'No active session' };
    }

    // Deduplication
    if (activeSession.last_tick_at) {
      const lastTickTime = new Date(activeSession.last_tick_at).getTime();
      const now = Date.now();
      const secondsSinceLastTick = (now - lastTickTime) / 1000;
      if (secondsSinceLastTick < 10) {
        return { success: true, message: `Skipped: last tick was ${secondsSinceLastTick.toFixed(0)}s ago (source: ${source})` };
      }
    }

    await supabase.from('martingale_sessions').update({
      last_tick_at: new Date().toISOString(),
    }).eq('id', activeSession.id);

    const tradingMode = activeSession.trading_mode || 'paper';
    const isActual = tradingMode === 'actual';
    const strategyMode = await getStrategyMode(supabase);
    const sniper = isSniperStrategy(strategyMode) || (await sessionIsSniper(supabase, activeSession.id));

    if (isSniperStrategy(strategyMode) && !await sessionIsSniper(supabase, activeSession.id)) {
      return { success: true, message: 'Sniper mode: active martingale session halted on this tick.' };
    }

    if (sniper) {
      await supabase
        .from('martingale_sessions')
        .update({ max_rounds: SNIPER_MAX_ROUNDS, strategy_mode: STRATEGY_SNIPER })
        .eq('id', activeSession.id);
    }

    const { data: openTrade } = await supabase
      .from('martingale_trades')
      .select('*')
      .eq('session_id', activeSession.id)
      .eq('status', 'open')
      .maybeSingle();

    if (sniper && openTrade && Number(openTrade.round) > SNIPER_MAX_ROUNDS) {
      await completeSniperSession(
        supabase,
        activeSession.id,
        'sniper_halt_excess_round',
        Number(activeSession.total_pnl) || 0,
        openTrade.round,
      );
      return {
        success: true,
        action: `Sniper: halted R${openTrade.round} trade (max R${SNIPER_MAX_ROUNDS} in sniper mode).`,
      };
    }

    if (!openTrade) {
      const { data: lastClosedTrade } = await supabase
        .from('martingale_trades')
        .select('*')
        .eq('session_id', activeSession.id)
        .eq('status', 'closed')
        .order('round', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!lastClosedTrade || (Number(lastClosedTrade.pnl) || 0) >= 0) {
        return { success: true, message: 'No open trade in active session' };
      }

      const resumeResult = await continueSessionFromLastLoss(
        supabase,
        supabaseUrl,
        anonKey,
        activeSession,
        lastClosedTrade,
        tradingMode,
      );

      if (resumeResult.telegramText) {
        await sendTelegram(resumeResult.telegramText);
      }

      return {
        success: resumeResult.success,
        action: resumeResult.action,
        message: resumeResult.message || resumeResult.action || 'Recovered session from last loss',
      };
    }

    // Check 3:25 PM auto square off
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const istHour = nowIST.getHours();
    const istMinute = nowIST.getMinutes();
    const isPastSquareOff = istHour > 15 || (istHour === 15 && istMinute >= 25);

    if (isPastSquareOff && openTrade) {
      const { specificPrice: sqPrice, specificInstrumentKey: sqInstrKey } = await fetchNiftyOptionChain(
        supabaseUrl, anonKey, openTrade.strike_price, openTrade.option_type, openTrade.nifty_spot, openTrade.entry_price
      );
      const exitPrice = sqPrice !== null ? sqPrice : openTrade.entry_price;
      const sqPnl = (exitPrice - openTrade.entry_price) * openTrade.lots * LOT_SIZE;

      if (isActual) {
        const accessToken = await getUpstoxToken(supabase);
        if (accessToken && sqInstrKey) {
          await placeUpstoxOrder(accessToken, {
            instrumentKey: sqInstrKey,
            quantity: openTrade.lots * LOT_SIZE,
            transactionType: 'SELL',
            price: exitPrice,
          });
        }
      }

      const exitIsoSq = new Date().toISOString();
      await supabase.from('martingale_trades').update(
        finalizeTradeClosePatch(openTrade, exitPrice, exitIsoSq, sqPnl, 'square_off_1525_ist'),
      ).eq('id', openTrade.id);

      await supabase.from('martingale_sessions').update({
        status: 'squared_off', total_pnl: activeSession.total_pnl + sqPnl, completed_at: new Date().toISOString(),
      }).eq('id', activeSession.id);

      const modeLabel = isActual ? '🔴' : '📝';
      const msg = `${modeLabel} 🕒 *3:25 PM Square Off*\nExited ${openTrade.option_type} ${openTrade.strike_price} @ ₹${exitPrice} (P&L: ₹${sqPnl.toFixed(0)})`;
      await sendTelegram(msg);

      return {
        success: true, action: `🕒 3:25 PM Square Off! Exited ${openTrade.option_type} ${openTrade.strike_price} @ ₹${exitPrice} (P&L: ₹${sqPnl.toFixed(0)})`,
      };
    }

    // Check daily loss limit
    const dailyPnlCheck = await getDailyPnl(supabase);
    const dailyLossLimitCheck = sniper ? await getSniperDailyLossLimit(supabase) : await getDailyLossLimit(supabase);
    const runningSessionPnl = activeSession.total_pnl;
    const { optionData: odMon, specificPrice: checkPrice, specificInstrumentKey: checkInstrKey } = await fetchNiftyOptionChain(
      supabaseUrl, anonKey, openTrade.strike_price, openTrade.option_type, openTrade.nifty_spot, openTrade.entry_price,
    );

    if (checkPrice === null) {
      return { success: true, message: 'Could not fetch current price' };
    }

    if (
      odMon &&
      typeof odMon.otmCEPrice === 'number' &&
      typeof odMon.otmPEPrice === 'number' &&
      odMon.otmCEPrice > 0 &&
      odMon.otmPEPrice > 0
    ) {
      // Fire-and-forget: do not await — logging must not delay TP/SL/daily-limit logic.
      void recordPremiumTickIfDue(supabase, {
        sessionId: activeSession.id,
        tradeId: openTrade.id,
        niftySpot: odMon.niftySpot,
        otmCEStrike: odMon.otmCEStrike,
        otmPEStrike: odMon.otmPEStrike,
        otmCEPremium: odMon.otmCEPrice,
        otmPEPremium: odMon.otmPEPrice,
        activeOptionType: openTrade.option_type,
        activeStrike: Number(openTrade.strike_price),
        activePremium: checkPrice,
        tickSource: source,
      }).catch((e) => console.error('recordPremiumTickIfDue:', e));
    }

    const checkPnlAmount = (checkPrice - openTrade.entry_price) * openTrade.lots * LOT_SIZE;
    const effectiveDailyPnl = dailyPnlCheck + runningSessionPnl + checkPnlAmount;

    if (effectiveDailyPnl <= -dailyLossLimitCheck) {
      if (isActual) {
        const accessToken = await getUpstoxToken(supabase);
        if (accessToken && checkInstrKey) {
          await placeUpstoxOrder(accessToken, {
            instrumentKey: checkInstrKey,
            quantity: openTrade.lots * LOT_SIZE,
            transactionType: 'SELL',
            price: checkPrice,
          });
        }
      }

      const exitIsoDl = new Date().toISOString();
      await supabase.from('martingale_trades').update(
        finalizeTradeClosePatch(openTrade, checkPrice, exitIsoDl, checkPnlAmount, 'daily_loss_limit'),
      ).eq('id', openTrade.id);

      const finalSessionPnl = runningSessionPnl + checkPnlAmount;
      await supabase.from('martingale_sessions').update({
        status: 'daily_loss_limit', total_pnl: finalSessionPnl, completed_at: new Date().toISOString(),
      }).eq('id', activeSession.id);

      const modeLabel = isActual ? '🔴' : '📝';
      const msg = `${modeLabel} ⛔ Daily loss limit hit (₹${Math.abs(effectiveDailyPnl).toFixed(0)} / ₹${dailyLossLimitCheck}). Squared off ${openTrade.option_type} ${openTrade.strike_price} @ ₹${checkPrice}. Bot stopped.`;
      await sendTelegram(`📊 *Martingale Bot*\n\n${msg}`);
      return { success: true, action: msg };
    }

    const currentPrice = checkPrice;
    const currentInstrKey = checkInstrKey;
    const pnlPercent = ((currentPrice - openTrade.entry_price) / openTrade.entry_price) * 100;
    const pnlAmount = checkPnlAmount;
    let actionTaken = `Monitoring: ${openTrade.option_type} ${openTrade.strike_price} @ ₹${currentPrice} (${pnlPercent.toFixed(2)}%)`;

    if (sniper) {
      const sniperSessionCap = await getSniperSessionLossCap(supabase);
      const { data: closedForCap } = await supabase
        .from('martingale_trades')
        .select('pnl')
        .eq('session_id', activeSession.id)
        .eq('status', 'closed');
      const sessionPnlLive = (closedForCap || []).reduce((s: number, t: any) => s + (Number(t.pnl) || 0), 0) + pnlAmount;
      if (sessionPnlLive <= -sniperSessionCap) {
        const exitIsoCap = new Date().toISOString();
        await supabase.from('martingale_trades').update(
          finalizeTradeClosePatch(openTrade, currentPrice, exitIsoCap, pnlAmount, 'sniper_session_loss_cap'),
        ).eq('id', openTrade.id).eq('status', 'open');
        if (isActual && currentInstrKey) {
          const accessToken = await getUpstoxToken(supabase);
          if (accessToken) {
            await placeUpstoxOrder(accessToken, {
              instrumentKey: currentInstrKey,
              quantity: openTrade.lots * LOT_SIZE,
              transactionType: 'SELL',
              price: currentPrice,
            });
          }
        }
        await completeSniperSession(supabase, activeSession.id, 'sniper_session_loss_cap', sessionPnlLive, openTrade.round);
        const modeLabel = isActual ? '🔴' : '📝';
        return {
          success: true,
          action: `${modeLabel} 🎯 Sniper session loss cap (₹${sniperSessionCap}). Squared off. Done for today.`,
        };
      }
    }

    // (Mid-session decay check removed — the -2% stop loss handles intra-round exits.
    //  Sideways detection now happens between rounds at R3+ entry.)

    async function startNewSession(lastOptionType: string, lastPnl: number) {
      const chainMode = await getStrategyMode(supabase);
      const blockChain = await rejectMartingaleWhenSniperSelected(supabase);
      if (blockChain || isSniperStrategy(chainMode) || sniper) {
        console.log('Sniper: no martingale auto-chain after take-profit — done for today');
        return;
      }
      // GUARD 1: Check if we're still in a trading window (use < for end boundary to prevent starting at exact square-off time)
      const nowCheck = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const checkTime = nowCheck.getHours() * 60 + nowCheck.getMinutes();
      const isExpiryDayCheck = nowCheck.getDay() === 2;
      if (!martingaleInTradingWindow(checkTime, nowCheck.getDay())) {
        console.log(`New session skipped: outside trading windows (${nowCheck.getHours()}:${String(nowCheck.getMinutes()).padStart(2, '0')} IST)`);
        return;
      }

      // GUARD 2: Check no active session already exists (prevents duplicates)
      const { data: existingActive } = await supabase
        .from('martingale_sessions')
        .select('id')
        .eq('status', 'active')
        .maybeSingle();
      if (existingActive) {
        console.log(`New session skipped: active session ${existingActive.id} already exists`);
        return;
      }

      // GUARD 3: Check no session was created in the last 60 seconds
      const recentCutoff = new Date(Date.now() - 60000).toISOString();
      const { data: recentSess } = await supabase
        .from('martingale_sessions')
        .select('id')
        .gte('created_at', recentCutoff)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
      if (recentSess) {
        console.log(`New session skipped: session ${recentSess.id} created within 60s`);
        return;
      }

      const { optionData } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
      if (!optionData) { console.log('Cannot start new session: no option data'); return; }

      // GUARD 4: Check sideways pause (chain-backed recheck after timer expiry)
      const sidewaysPause = await isInSidewaysPause(
        supabase,
        '',
        optionData.niftySpot,
        supabaseUrl,
        anonKey,
        optionData.otmCEPrice,
        optionData.otmPEPrice,
        optionData.otmCEStrike,
        optionData.otmPEStrike,
      );
      if (sidewaysPause.paused) {
        console.log(`New session skipped: sideways pause active (${sidewaysPause.remainingMins} min remaining)`);
        return;
      }

      let newDirection: string;
      if (lastPnl > 0) {
        newDirection = lastOptionType;
      } else {
        newDirection = lastOptionType === 'CE' ? 'PE' : 'CE';
      }

      const newStrike = newDirection === 'CE' ? optionData.otmCEStrike : optionData.otmPEStrike;
      const newPrice = newDirection === 'CE' ? optionData.otmCEPrice : optionData.otmPEPrice;
      const newInstrKey = newDirection === 'CE' ? optionData.otmCEInstrumentKey : optionData.otmPEInstrumentKey;

      if (newPrice <= 0) { console.log(`Cannot start new session: ${newDirection} price is 0`); return; }

      let actualNewPrice = newPrice;
      if (isActual) {
        const accessToken = await getUpstoxToken(supabase);
        if (accessToken && newInstrKey) {
          const buyResult = await placeBuyWithRetry(supabase, accessToken, {
            instrumentKey: newInstrKey,
            quantity: 1 * LOT_SIZE,
            price: newPrice,
          });
          if (!buyResult.success) {
            const { data: pausedSession } = await supabase
              .from('martingale_sessions')
              .insert({ status: 'paused', current_round: 1, max_rounds: activeSession.max_rounds, trading_mode: tradingMode })
              .select().single();
            if (pausedSession) {
              await pauseBotWithNotification(supabase, pausedSession.id,
                `New session BUY for ${newStrike} ${newDirection} @ ₹${newPrice} failed after 3 attempts.`);
            }
            console.error(`New session buy failed after retries: ${buyResult.error}`);
            return;
          }
          actualNewPrice = buyResult.filledPrice;
        } else {
          console.error('Cannot place buy order: missing token or instrument key');
          return;
        }
      }

      // GUARD 5: Final recheck right before insert
      const { data: finalCheck } = await supabase
        .from('martingale_sessions')
        .select('id')
        .eq('status', 'active')
        .maybeSingle();
      if (finalCheck) {
        console.log(`New session skipped at final guard: active session ${finalCheck.id} exists`);
        return;
      }

      const newAnchorCe =
        typeof optionData.otmCEPrice === 'number' && optionData.otmCEPrice > 0 ? optionData.otmCEPrice : null;
      const newAnchorPe =
        typeof optionData.otmPEPrice === 'number' && optionData.otmPEPrice > 0 ? optionData.otmPEPrice : null;

      const { data: newSession } = await supabase
        .from('martingale_sessions')
        .insert({
          status: 'active',
          current_round: 1,
          max_rounds: activeSession.max_rounds,
          trading_mode: tradingMode,
          strategy_mode: STRATEGY_MARTINGALE,
          anchor_otm_ce_premium: newAnchorCe,
          anchor_otm_pe_premium: newAnchorPe,
        })
        .select()
        .single();
      if (newSession) {
        const { error: newSessTradeErr } = await insertMartingaleOpenTrade(supabase, {
          session_id: newSession.id,
          round: 1,
          option_type: newDirection,
          strike_price: newStrike,
          lots: 1,
          entry_price: actualNewPrice,
          nifty_spot: optionData.niftySpot,
          atm_strike: optionData.atmStrike,
          entry_reason_tag: 'fresh_r1_after_take_profit_auto_chain',
        });
        if (newSessTradeErr) console.error('insertMartingaleOpenTrade new session:', newSessTradeErr);
        console.log(`New session: ${newDirection} ${newStrike} @ ₹${actualNewPrice} (lastPnl=${lastPnl.toFixed(0)})`);
      }
    }

    const profitTargetPct =
      Number(openTrade.target_pct) > 0 ? Number(openTrade.target_pct) : await getProfitTargetPct(supabase);
    const stopLossPct =
      Number(openTrade.stop_loss_pct) > 0 ? Number(openTrade.stop_loss_pct) : await getStopLossPct(supabase);

    // Check profit target
    if (pnlPercent >= profitTargetPct) {
      const exitIsoTp = new Date().toISOString();
      const { data: closeResult } = await supabase.from('martingale_trades').update(
        finalizeTradeClosePatch(openTrade, currentPrice, exitIsoTp, pnlAmount, 'profit_target_pct'),
      ).eq('id', openTrade.id).eq('status', 'open').select();
      if (!closeResult || closeResult.length === 0) {
        return { success: true, message: 'Trade already processed by another tick' };
      }

      if (isActual) {
        const accessToken = await getUpstoxToken(supabase);
        if (accessToken && currentInstrKey) {
          await placeUpstoxOrder(accessToken, {
            instrumentKey: currentInstrKey,
            quantity: openTrade.lots * LOT_SIZE,
            transactionType: 'SELL',
            price: currentPrice,
          });
        }
      }

      const sessionPnlAfterWin = (Number(activeSession.total_pnl) || 0) + pnlAmount;
      if (sniper) {
        await completeSniperSession(supabase, activeSession.id, 'sniper_completed_win', sessionPnlAfterWin, openTrade.round);
        const modeLabel = isActual ? '🔴' : '📝';
        actionTaken = `${modeLabel} 🎯 Sniper PROFIT! ${openTrade.option_type} ${openTrade.strike_price} @ ₹${currentPrice} (+${pnlPercent.toFixed(1)}%, ₹${pnlAmount.toFixed(0)}). Done for today.`;
        await sendTelegram(`🎯 *Sniper Bot - PROFIT*\n\n${actionTaken}`);
      } else {
        await supabase.from('martingale_sessions').update({
          status: 'completed', total_pnl: sessionPnlAfterWin, completed_at: new Date().toISOString(),
        }).eq('id', activeSession.id);

        await startNewSession(openTrade.option_type, pnlAmount);
        const modeLabel = isActual ? '🔴' : '📝';
        actionTaken = `${modeLabel} 🎯 PROFIT! Exited ${openTrade.option_type} ${openTrade.strike_price} @ ₹${currentPrice} (+${pnlPercent.toFixed(1)}%, ₹${pnlAmount.toFixed(0)}). New session started.`;
        await sendTelegram(`🎯 *Martingale Bot - PROFIT*\n\n${actionTaken}`);
      }
    }
    // Check loss limit
    else if (pnlPercent <= -stopLossPct) {
      const exitIsoSl = new Date().toISOString();
      const { data: closeResult } = await supabase.from('martingale_trades').update(
        finalizeTradeClosePatch(openTrade, currentPrice, exitIsoSl, pnlAmount, 'stop_loss_pct'),
      ).eq('id', openTrade.id).eq('status', 'open').select();
      if (!closeResult || closeResult.length === 0) {
        return { success: true, message: 'Trade already processed by another tick' };
      }

      if (isActual) {
        const accessToken = await getUpstoxToken(supabase);
        if (accessToken && currentInstrKey) {
          await placeUpstoxOrder(accessToken, {
            instrumentKey: currentInstrKey,
            quantity: openTrade.lots * LOT_SIZE,
            transactionType: 'SELL',
            price: currentPrice,
          });
        }
      }

      const recoveryResult = await continueSessionFromLastLoss(
        supabase,
        supabaseUrl,
        anonKey,
        activeSession,
        { ...openTrade, pnl: pnlAmount },
        tradingMode,
      );

      if (!recoveryResult.success) {
        return { success: false, message: recoveryResult.message || 'Could not continue from last loss' };
      }

      actionTaken = recoveryResult.action || actionTaken;
      if (recoveryResult.telegramText) {
        await sendTelegram(recoveryResult.telegramText);
      }

      await sendTelegram(`📊 *Martingale Bot*\n\n${actionTaken}`);
    }

    return {
      success: true, action: actionTaken,
      current_price: currentPrice, pnl_percent: pnlPercent, pnl_amount: pnlAmount,
    };
}
