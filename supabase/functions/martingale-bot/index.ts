import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const LOT_SIZE = 65;
const PROFIT_TARGET = 2.5;
const LOSS_LIMIT = 2;
const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_DAILY_LOSS_LIMIT = 12000;
const ORDER_FILL_MAX_RETRIES = 3;
const ORDER_FILL_CHECK_INTERVAL_MS = 8000;
const ORDER_FILL_MAX_CHECKS = 3;
const PAUSE_DURATION_MS = 10 * 60 * 1000;
const SIDEWAYS_PAUSE_DURATION_MS = 15 * 60 * 1000; // 15 min pause after sideways skip
const SIDEWAYS_MIN_ROUND = 3; // Only gate entry from R3 onwards
const SIDEWAYS_NIFTY_RANGE_THRESHOLD = 50; // Nifty range < 50pts in last 15min = sideways
const SIDEWAYS_PREMIUM_DECLINE_RATIO = 0.97; // Both premiums down >3% from R1 = decay

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
    return { success: false, error: error.message };
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

// ========== BETWEEN-ROUND SIDEWAYS GATE ==========
// Instead of detecting decay mid-trade (the -2% stop handles that),
// this gates ENTRY into R3+ by checking:
// 1) Were the last 2 rounds both losses?
// 2) Is Nifty range-bound (< threshold pts in recent history)?
// If both → skip entry, end session, reset to R1, pause 15 min.

async function shouldSkipNextRound(
  supabase: any, 
  sessionId: string, 
  nextRound: number,
  niftySpot: number,
  supabaseUrl: string,
  anonKey: string,
  currentCEPrice?: number,
  currentPEPrice?: number,
): Promise<{ skip: boolean; reason: string }> {
  // R1 and R2 — always allow, early losses are normal
  if (nextRound < SIDEWAYS_MIN_ROUND) {
    return { skip: false, reason: `R${nextRound}: allowed (< R${SIDEWAYS_MIN_ROUND})` };
  }

  // Check if last 2 rounds in this session were both losses
  const { data: recentTrades } = await supabase
    .from('martingale_trades')
    .select('round, pnl, status, nifty_spot')
    .eq('session_id', sessionId)
    .eq('status', 'closed')
    .order('round', { ascending: false })
    .limit(2);

  if (!recentTrades || recentTrades.length < 2) {
    return { skip: false, reason: 'Not enough trade history to evaluate' };
  }

  const lastTwoLosses = recentTrades.every((t: any) => (t.pnl || 0) < 0);
  if (!lastTwoLosses) {
    return { skip: false, reason: `R${nextRound}: last 2 rounds not both losses — proceed` };
  }

  // Both were losses — now check TWO signals (either one triggers skip)

  // Signal 1: Nifty range-bound (market going nowhere)
  const { data: allSessionTrades } = await supabase
    .from('martingale_trades')
    .select('nifty_spot, entry_price, option_type, round, entry_time')
    .eq('session_id', sessionId)
    .order('entry_time', { ascending: true });

  let niftyRange = 0;
  if (allSessionTrades && allSessionTrades.length > 0) {
    const spots = allSessionTrades
      .map((t: any) => Number(t.nifty_spot))
      .filter((s: number) => s > 0);
    if (spots.length > 0) {
      spots.push(niftySpot);
      niftyRange = Math.max(...spots) - Math.min(...spots);
    }
  }

  const marketSideways = niftyRange < SIDEWAYS_NIFTY_RANGE_THRESHOLD;

  // Signal 2: Both premiums decaying from R1 anchor (catches IV crush days)
  let bothDecaying = false;
  let decayDetail = '';
  if (currentCEPrice && currentPEPrice && allSessionTrades && allSessionTrades.length > 0) {
    // Find R1 entry price as the premium anchor
    const r1CE = allSessionTrades.find((t: any) => t.round === 1 && t.option_type === 'CE');
    const r1PE = allSessionTrades.find((t: any) => t.round === 1 && t.option_type === 'PE');
    
    // Use R1 entry prices if available, otherwise use earliest trade of each type
    const anchorCE = r1CE ? Number(r1CE.entry_price) : null;
    const anchorPE = r1PE ? Number(r1PE.entry_price) : null;

    if (anchorCE && anchorPE && anchorCE > 0 && anchorPE > 0) {
      const ceRatio = currentCEPrice / anchorCE;
      const peRatio = currentPEPrice / anchorPE;
      bothDecaying = ceRatio < SIDEWAYS_PREMIUM_DECLINE_RATIO && peRatio < SIDEWAYS_PREMIUM_DECLINE_RATIO;
      decayDetail = `CE: ₹${anchorCE.toFixed(0)}→₹${currentCEPrice.toFixed(0)} (${((1 - ceRatio) * 100).toFixed(1)}% down), PE: ₹${anchorPE.toFixed(0)}→₹${currentPEPrice.toFixed(0)} (${((1 - peRatio) * 100).toFixed(1)}% down)`;
    }
  }

  if (marketSideways) {
    return { 
      skip: true, 
      reason: `R${nextRound}: last 2 rounds both losses + Nifty range only ${niftyRange.toFixed(0)}pts (< ${SIDEWAYS_NIFTY_RANGE_THRESHOLD}pts). Sideways trap detected.`,
    };
  }

  if (bothDecaying) {
    return {
      skip: true,
      reason: `R${nextRound}: last 2 rounds both losses + both premiums decaying from R1. ${decayDetail}. IV crush / theta trap detected.`,
    };
  }

  return { skip: false, reason: `R${nextRound}: last 2 losses but market moving (range ${niftyRange.toFixed(0)}pts) and premiums not both decaying — proceed` };
}

// Check if currently in a sideways pause period
async function isInSidewaysPause(supabase: any): Promise<{ paused: boolean; remainingMins: number }> {
  const { data } = await supabase
    .from('bot_settings')
    .select('value')
    .eq('key', 'sideways_pause_until')
    .maybeSingle();

  if (!data?.value) return { paused: false, remainingMins: 0 };

  const pauseUntil = new Date(data.value).getTime();
  if (Date.now() >= pauseUntil) {
    await supabase.from('bot_settings').delete().eq('key', 'sideways_pause_until');
    return { paused: false, remainingMins: 0 };
  }

  const remainingMins = Math.ceil((pauseUntil - Date.now()) / 60000);
  return { paused: true, remainingMins };
}

async function setSidewaysPause(supabase: any): Promise<string> {
  const pauseUntil = new Date(Date.now() + SIDEWAYS_PAUSE_DURATION_MS).toISOString();
  await supabase.from('bot_settings').upsert({
    key: 'sideways_pause_until',
    value: pauseUntil,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
  return pauseUntil;
}

// Get sideways gate status for UI display
async function getDecayStatus(supabase: any): Promise<any> {
  const { data } = await supabase
    .from('bot_settings')
    .select('value')
    .eq('key', 'sideways_pause_until')
    .maybeSingle();

  if (!data?.value) return { active: false };

  const pauseUntil = new Date(data.value).getTime();
  const isActive = Date.now() < pauseUntil;

  return {
    active: isActive,
    pause_until: data.value,
    remaining_mins: isActive ? Math.ceil((pauseUntil - Date.now()) / 60000) : undefined,
    type: 'sideways_gate',
    description: 'Between-round sideways detection (R3+ gate)',
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
  const isActual = tradingMode === 'actual';
  const modeLabel = isActual ? '🔴' : '📝';
  const lastLossRound = Number(lastLossTrade?.round) || Number(session.current_round) || 1;
  const maxRounds = Number(session.max_rounds) || DEFAULT_MAX_ROUNDS;

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
    const action = `${modeLabel} ⛔ MAX ROUNDS (${maxRounds}) reached. Session P&L: ₹${sessionTotalPnl.toFixed(0)}. Bot stopped — manual restart required.`;

    await supabase.from('martingale_sessions').update({
      status: 'max_rounds_reached',
      total_pnl: sessionTotalPnl,
      completed_at: new Date().toISOString(),
      current_round: lastLossRound,
    }).eq('id', session.id);

    return {
      success: true,
      action,
      telegramText: `📊 *Martingale Bot*\n\n${action}`,
    };
  }

  const { optionData } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
  if (!optionData) {
    return { success: false, message: `Could not fetch new option data for round ${newRound}` };
  }

  const sidewaysCheck = await shouldSkipNextRound(
    supabase,
    session.id,
    newRound,
    optionData.niftySpot,
    supabaseUrl,
    anonKey,
    optionData.otmCEPrice,
    optionData.otmPEPrice,
  );

  if (sidewaysCheck.skip) {
    await supabase.from('martingale_sessions').update({
      status: 'sideways_skipped',
      total_pnl: sessionTotalPnl,
      completed_at: new Date().toISOString(),
      current_round: newRound - 1,
    }).eq('id', session.id);

    const pauseUntil = await setSidewaysPause(supabase);
    const action = `⚠️ Sideways skip at R${newRound}. ${sidewaysCheck.reason}. Paused 15 min → fresh R1.`;

    return {
      success: true,
      action,
      telegramText: `${modeLabel} ⚠️ *Sideways Trap Detected at R${newRound}*\n\n${sidewaysCheck.reason}\n\n⏸️ Session ended. Pausing 15 min until ${new Date(pauseUntil).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.\nNext start will be fresh R1 with base lots.`,
    };
  }

  const newOptionType = lastLossTrade.option_type === 'CE' ? 'PE' : 'CE';
  const newLots = Math.pow(2, newRound - 1);
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

  await supabase.from('martingale_trades').insert({
    session_id: session.id,
    round: newRound,
    option_type: newOptionType,
    strike_price: newStrike,
    lots: newLots,
    entry_price: actualRoundPrice,
    status: 'open',
    nifty_spot: optionData.niftySpot,
  });

  const action = `${modeLabel} 🔄 Round ${newRound}: Resumed from last loss. Flipped to ${newLots} lots ${newStrike} ${newOptionType} @ ₹${actualRoundPrice.toFixed(2)}`;
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
        .limit(500);

      let allTrades: any[] = [];
      if (recentSessions && recentSessions.length > 0) {
        const oldestSession = recentSessions[recentSessions.length - 1];
        const { data: trades } = await supabase
          .from('martingale_trades')
          .select('*')
          .gte('entry_time', oldestSession.created_at)
          .order('entry_time', { ascending: false })
          .limit(5000);
        if (trades) allTrades = trades;
      }

      const dailyPnl = await getDailyPnl(supabase);
      const dailyLossLimit = await getDailyLossLimit(supabase);
      const decayStatus = await getDecayStatus(supabase);

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
        daily_loss_limit: dailyLossLimit,
        decay_status: decayStatus,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'stop') {
      const { data: activeSession } = await supabase
        .from('martingale_sessions')
        .select('*')
        .eq('status', 'active')
        .maybeSingle();

      if (activeSession) {
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

          await supabase.from('martingale_trades').update({
            status: 'closed', exit_price: exitPrice, pnl, exit_time: new Date().toISOString(),
          }).eq('id', openTrade.id);

          await supabase.from('martingale_sessions').update({
            status: 'stopped', total_pnl: activeSession.total_pnl + pnl, completed_at: new Date().toISOString(),
          }).eq('id', activeSession.id);
        } else {
          await supabase.from('martingale_sessions').update({
            status: 'stopped', completed_at: new Date().toISOString(),
          }).eq('id', activeSession.id);
        }
      }

      // Clear sideways pause on manual stop
      await supabase.from('bot_settings').delete().eq('key', 'sideways_pause_until');

      return new Response(JSON.stringify({ success: true, message: 'Bot stopped' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'start') {
      const tradingMode = body.trading_mode || 'paper';
      const maxRounds = Math.min(Math.max(parseInt(body.max_rounds) || DEFAULT_MAX_ROUNDS, 1), 10);
      const skipDecayCheck = body.skip_decay_check === true; // Allow manual override

      const nowIST_start = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const startHour = nowIST_start.getHours();
      const startMinute = nowIST_start.getMinutes();
      const startTime = startHour * 60 + startMinute;
      const mktOpen = 9 * 60 + 15;
      const mktClose = 15 * 60 + 30;

      if (startTime < mktOpen || startTime > mktClose) {
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

      // Check for sideways pause before starting
      if (!skipDecayCheck) {
        const sidewaysPause = await isInSidewaysPause(supabase);
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

      const { optionData } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
      if (!optionData) {
        return new Response(JSON.stringify({ success: false, message: 'Could not fetch option chain data' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      let entryOptionType = 'CE';

      const { data: lastSession } = await supabase
        .from('martingale_sessions')
        .select('id, status')
        .neq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

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
            .insert({ status: 'paused', current_round: 1, max_rounds: maxRounds, trading_mode: tradingMode })
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

      const { data: session, error: sessErr } = await supabase
        .from('martingale_sessions')
        .insert({ status: 'active', current_round: 1, max_rounds: maxRounds, trading_mode: tradingMode })
        .select()
        .single();
      if (sessErr) throw sessErr;

      const { error: tradeErr } = await supabase
        .from('martingale_trades')
        .insert({
          session_id: session.id, round: 1, option_type: entryOptionType,
          strike_price: entryStrike, lots: 1,
          entry_price: actualEntryPrice, status: 'open', nifty_spot: optionData.niftySpot,
        });
      if (tradeErr) throw tradeErr;

      const modeLabel = tradingMode === 'actual' ? '🔴 ACTUAL' : '📝 Paper';
      return new Response(JSON.stringify({
        success: true,
        message: `${modeLabel} Started! Bought 1 lot ${entryStrike} ${entryOptionType} @ ₹${entryPrice}`,
        session,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // action === 'tick' or 'cron-tick'
    const isCronTick = action === 'cron-tick';
    const source = body.source || (isCronTick ? 'cron' : 'ui');
    const tickCount = isCronTick ? 4 : 1;
    const tickResults: string[] = [];

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

      const AUTO_START_1 = 9 * 60 + 25;
      const AUTO_STOP_1  = 11 * 60 + 15;
      const AUTO_START_2 = 14 * 60 + 30;

      const { data: existingSession } = await supabase
        .from('martingale_sessions')
        .select('id, status')
        .eq('status', 'active')
        .maybeSingle();

      const dailyPnlSched = await getDailyPnl(supabase);
      const dailyLossLimitSched = await getDailyLossLimit(supabase);
      const isDailyLossHit = dailyPnlSched <= -dailyLossLimitSched;

      if (isMarketDay && !isDailyLossHit &&
          ((schedTime >= AUTO_START_1 && schedTime < AUTO_START_1 + 1) ||
           (!isExpiryDay && schedTime >= AUTO_START_2 && schedTime < AUTO_START_2 + 1))) {
        if (!existingSession) {
          // Check for sideways pause before auto-starting
          const sidewaysPause = await isInSidewaysPause(supabase);
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
              body: JSON.stringify({ action: 'start', trading_mode: savedMode, max_rounds: savedMaxRounds, skip_decay_check: true }),
            });
            const startData = await startRes.json();
            const timeLabel = schedTime >= AUTO_START_2 ? '2:30 PM' : '9:25 AM';
            tickResults.push(`⏰ Auto-start (${timeLabel}): ${startData.message || 'started'}`);
            await sendTelegram(`⏰ *Auto-Start (${timeLabel})*\n${startData.message || 'Bot started automatically'}`);
          }
        }
      }

      // Auto square-off + stop at 11:15 AM
      if (schedTime >= AUTO_STOP_1 && schedTime < AUTO_STOP_1 + 1) {
        if (existingSession) {
          const stopRes = await fetch(`${supabaseUrl}/functions/v1/martingale-bot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
            body: JSON.stringify({ action: 'stop' }),
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
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// Single tick logic
async function runSingleTick(supabase: any, supabaseUrl: string, anonKey: string, source: string): Promise<any> {
    const nowIST_tick = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const tickHour = nowIST_tick.getHours();
    const tickMinute = nowIST_tick.getMinutes();
    const tickTime = tickHour * 60 + tickMinute;
    const marketOpen = 9 * 60 + 15;
    const marketClose = 15 * 60 + 30;

    if (tickTime < marketOpen || tickTime > marketClose) {
      return { success: true, message: `Outside market hours (${tickHour}:${String(tickMinute).padStart(2, '0')} IST). Skipping tick.` };
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

      const startRes = await fetch(`${supabaseUrl}/functions/v1/martingale-bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
        body: JSON.stringify({ action: 'start', trading_mode: savedMode, max_rounds: savedMaxRounds }),
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
      const sidewaysPause = await isInSidewaysPause(supabase);
      if (sidewaysPause.paused) {
        return { success: true, message: `⚠️ Sideways pause: ${sidewaysPause.remainingMins} min remaining. Will restart as fresh R1.` };
      }
    }

    const { data: activeSession } = await supabase
      .from('martingale_sessions')
      .select('*')
      .eq('status', 'active')
      .maybeSingle();

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

    const { data: openTrade } = await supabase
      .from('martingale_trades')
      .select('*')
      .eq('session_id', activeSession.id)
      .eq('status', 'open')
      .maybeSingle();

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

      await supabase.from('martingale_trades').update({
        status: 'closed', exit_price: exitPrice, pnl: sqPnl, exit_time: new Date().toISOString(),
      }).eq('id', openTrade.id);

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
    const dailyLossLimitCheck = await getDailyLossLimit(supabase);
    const runningSessionPnl = activeSession.total_pnl;
    const { specificPrice: checkPrice, specificInstrumentKey: checkInstrKey } = await fetchNiftyOptionChain(
      supabaseUrl, anonKey, openTrade.strike_price, openTrade.option_type, openTrade.nifty_spot, openTrade.entry_price
    );

    if (checkPrice === null) {
      return { success: true, message: 'Could not fetch current price' };
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

      await supabase.from('martingale_trades').update({
        status: 'closed', exit_price: checkPrice, pnl: checkPnlAmount, exit_time: new Date().toISOString(),
      }).eq('id', openTrade.id);

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

    // (Mid-session decay check removed — the -2% stop loss handles intra-round exits.
    //  Sideways detection now happens between rounds at R3+ entry.)

    async function startNewSession(lastOptionType: string, lastPnl: number) {
      // Check sideways pause before starting new session
      const sidewaysPause = await isInSidewaysPause(supabase);
      if (sidewaysPause.paused) {
        console.log(`New session skipped: sideways pause active (${sidewaysPause.remainingMins} min remaining)`);
        return;
      }

      const { optionData } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
      if (!optionData) { console.log('Cannot start new session: no option data'); return; }

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

      const { data: newSession } = await supabase
        .from('martingale_sessions')
        .insert({ status: 'active', current_round: 1, max_rounds: activeSession.max_rounds, trading_mode: tradingMode })
        .select().single();
      if (newSession) {
        await supabase.from('martingale_trades').insert({
          session_id: newSession.id, round: 1, option_type: newDirection,
          strike_price: newStrike, lots: 1,
          entry_price: actualNewPrice, status: 'open', nifty_spot: optionData.niftySpot,
        });




        console.log(`New session: ${newDirection} ${newStrike} @ ₹${actualNewPrice} (lastPnl=${lastPnl.toFixed(0)})`);
      }
    }

    // Check profit target
    if (pnlPercent >= PROFIT_TARGET) {
      const { data: closeResult } = await supabase.from('martingale_trades').update({
        status: 'closed', exit_price: currentPrice, pnl: pnlAmount, exit_time: new Date().toISOString(),
      }).eq('id', openTrade.id).eq('status', 'open').select();
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

      await supabase.from('martingale_sessions').update({
        status: 'completed', total_pnl: activeSession.total_pnl + pnlAmount, completed_at: new Date().toISOString(),
      }).eq('id', activeSession.id);

      await startNewSession(openTrade.option_type, pnlAmount);
      const modeLabel = isActual ? '🔴' : '📝';
      actionTaken = `${modeLabel} 🎯 PROFIT! Exited ${openTrade.option_type} ${openTrade.strike_price} @ ₹${currentPrice} (+${pnlPercent.toFixed(1)}%, ₹${pnlAmount.toFixed(0)}). New session started.`;
      await sendTelegram(`🎯 *Martingale Bot - PROFIT*\n\n${actionTaken}`);
    }
    // Check loss limit
    else if (pnlPercent <= -LOSS_LIMIT) {
      const { data: closeResult } = await supabase.from('martingale_trades').update({
        status: 'closed', exit_price: currentPrice, pnl: pnlAmount, exit_time: new Date().toISOString(),
      }).eq('id', openTrade.id).eq('status', 'open').select();
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
