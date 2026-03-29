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
const ORDER_FILL_CHECK_INTERVAL_MS = 8000; // 8 seconds between fill checks
const ORDER_FILL_MAX_CHECKS = 3; // check 3 times (24s total wait per attempt)
const PAUSE_DURATION_MS = 10 * 60 * 1000; // 10 minutes

async function getDailyPnl(supabase: any): Promise<number> {
  // Get today's date in IST
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const todayStart = new Date(nowIST);
  todayStart.setHours(0, 0, 0, 0);
  // Convert back to UTC for DB query
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
    // Use MARKET for SELL orders (exits) to guarantee fill, LIMIT for BUY orders
    const effectiveOrderType = params.orderType || (params.transactionType === 'SELL' ? 'MARKET' : 'LIMIT');
    const orderBody = {
      quantity: params.quantity,
      product: 'I', // Intraday
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

// Place BUY order with retry logic: try up to 3 times, check fill status, cancel if pending
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

    // Poll for fill status
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
      // If rejected/cancelled by exchange, break immediately
      if (['rejected', 'cancelled', 'canceled'].includes(status.status)) {
        console.log(`Order ${buyResult.orderId} was ${status.status}`);
        break;
      }
    }

    if (filled) {
      console.log(`BUY filled on attempt ${attempt} @ ₹${filledPrice}`);
      return { success: true, filledPrice };
    }

    // Not filled — cancel and retry
    console.log(`Order not filled after ${ORDER_FILL_MAX_CHECKS} checks, cancelling...`);
    await cancelUpstoxOrder(accessToken, buyResult.orderId);
    await new Promise(r => setTimeout(r, 2000)); // small gap before retry
  }

  return { success: false, filledPrice: 0, error: `Order not filled after ${ORDER_FILL_MAX_RETRIES} attempts` };
}

async function pauseBotWithNotification(supabase: any, sessionId: string, reason: string) {
  const pausedUntil = new Date(Date.now() + PAUSE_DURATION_MS).toISOString();
  
  await supabase.from('martingale_sessions').update({
    status: 'paused',
    last_tick_at: new Date().toISOString(),
  }).eq('id', sessionId);

  // Store pause info in bot_settings
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
      const { data: activeSession } = await supabase
        .from('martingale_sessions')
        .select('*')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

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
        const sessionIds = recentSessions.map((s: any) => s.id);
        const batchSize = 500;
        for (let i = 0; i < sessionIds.length; i += batchSize) {
          const batch = sessionIds.slice(i, i + batchSize);
          const { data: trades } = await supabase
            .from('martingale_trades')
            .select('*')
            .in('session_id', batch)
            .order('entry_time', { ascending: false })
            .limit(5000);
          if (trades) allTrades = allTrades.concat(trades);
        }
        allTrades.sort((a: any, b: any) => new Date(b.entry_time).getTime() - new Date(a.entry_time).getTime());
      }

      const dailyPnl = await getDailyPnl(supabase);
      const dailyLossLimit = await getDailyLossLimit(supabase);

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

          // Place sell order if actual trading
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

      return new Response(JSON.stringify({ success: true, message: 'Bot stopped' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'start') {
      const tradingMode = body.trading_mode || 'paper';
      const maxRounds = Math.min(Math.max(parseInt(body.max_rounds) || DEFAULT_MAX_ROUNDS, 1), 10);


      // Market hours guard
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

      // Validate Upstox connection for actual trading
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

      // Determine entry direction
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

      // Place actual buy order if in actual mode (with retry + fill verification)
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
          // All 3 attempts failed — create session in paused state
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
    // For 'cron-tick', run 4 ticks with 15s intervals inside one invocation
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
      const schedDay = nowIST_sched.getDay(); // 0=Sun, 6=Sat

      // NSE holidays 2025-2026 (MMDD format for easy matching)
      const NSE_HOLIDAYS: string[] = [
        // 2025
        '0226', // Mahashivratri
        '0314', // Holi
        '0331', // Id-Ul-Fitr
        '0410', // Shri Mahavir Jayanti
        '0414', // Dr. Ambedkar Jayanti
        '0418', // Good Friday
        '0501', // Maharashtra Day
        '0812', // Independence Day (observed)
        '0815', // Independence Day
        '0827', // Ganesh Chaturthi
        '1002', // Mahatma Gandhi Jayanti
        '1020', // Diwali (Laxmi Puja)
        '1021', // Diwali Balipratipada
        '1105', // Guru Nanak Jayanti (Prakash Utsav)
        '1225', // Christmas
        // 2026
        '0126', // Republic Day
        '0217', // Mahashivratri
        '0310', // Holi (Dhuleti)
        '0320', // Id-Ul-Fitr (subject to moon)
        '0402', // Shri Mahavir Jayanti / Ram Navami
        '0403', // Good Friday
        '0414', // Dr. Ambedkar Jayanti
        '0501', // Maharashtra Day
        '0527', // Id-Ul-Adha (Bakri Id)
        '0815', // Independence Day
        '0817', // Ganesh Chaturthi
        '1002', // Mahatma Gandhi Jayanti
        '1009', // Diwali (Laxmi Puja)
        '1026', // Guru Nanak Jayanti
        '1225', // Christmas
      ];

      const schedMMDD = String(nowIST_sched.getMonth() + 1).padStart(2, '0') + String(nowIST_sched.getDate()).padStart(2, '0');
      const isMarketDay = schedDay !== 0 && schedDay !== 6 && !NSE_HOLIDAYS.includes(schedMMDD);
      const isExpiryDay = schedDay === 2; // Nifty weekly expiry is Tuesday (since Sept 2025)

      const AUTO_START_1 = 9 * 60 + 25;   // 9:25 AM
      const AUTO_STOP_1  = 11 * 60 + 15;  // 11:15 AM
      const AUTO_START_2 = 14 * 60 + 30;  // 2:30 PM
      // 3:25 PM square-off is already handled inside runSingleTick

      const { data: existingSession } = await supabase
        .from('martingale_sessions')
        .select('id, status')
        .eq('status', 'active')
        .maybeSingle();

      // Auto-start at 9:25 AM or 2:30 PM — only on market days
      // Skip 2:30 PM session on expiry day (Tuesday) due to high theta decay
      // Skip auto-start if daily loss limit was already hit today
      const dailyPnlSched = await getDailyPnl(supabase);
      const dailyLossLimitSched = await getDailyLossLimit(supabase);
      const isDailyLossHit = dailyPnlSched <= -dailyLossLimitSched;

      if (isMarketDay && !isDailyLossHit &&
          ((schedTime >= AUTO_START_1 && schedTime < AUTO_START_1 + 1) ||
           (!isExpiryDay && schedTime >= AUTO_START_2 && schedTime < AUTO_START_2 + 1))) {
        if (!existingSession) {
          // Fetch saved settings from bot_settings
          const { data: settings } = await supabase.from('bot_settings').select('key, value');
          let savedMode = 'paper';
          let savedMaxRounds = DEFAULT_MAX_ROUNDS;
          if (settings) {
            for (const s of settings) {
              if (s.key === 'trading_mode') savedMode = s.value;
              if (s.key === 'max_rounds') savedMaxRounds = Math.min(Math.max(parseInt(s.value) || DEFAULT_MAX_ROUNDS, 1), 10);
            }
          }

          // Call start logic internally by making a self-request
          const startRes = await fetch(`${supabaseUrl}/functions/v1/martingale-bot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
            body: JSON.stringify({ action: 'start', trading_mode: savedMode, max_rounds: savedMaxRounds }),
          });
          const startData = await startRes.json();
          const timeLabel = schedTime >= AUTO_START_2 ? '2:30 PM' : '9:25 AM';
          tickResults.push(`⏰ Auto-start (${timeLabel}): ${startData.message || 'started'}`);
          await sendTelegram(`⏰ *Auto-Start (${timeLabel})*\n${startData.message || 'Bot started automatically'}`);
        }
      }

      // Auto square-off + stop at 11:15 AM (within a 1-minute window)
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
          // Skip ticks since we just stopped
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
        // Sleep 15 seconds between ticks
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

// Single tick logic extracted into a function
async function runSingleTick(supabase: any, supabaseUrl: string, anonKey: string, source: string): Promise<any> {
    // Market hours guard
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

      // Pause period over — resume by starting fresh
      await supabase.from('martingale_sessions').update({
        status: 'pause_expired', completed_at: new Date().toISOString(),
      }).eq('id', pausedSession.id);

      // Clear pause_until
      await supabase.from('bot_settings').delete().eq('key', 'pause_until');

      // Auto-start a new session using saved settings
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

    const { data: activeSession } = await supabase
      .from('martingale_sessions')
      .select('*')
      .eq('status', 'active')
      .maybeSingle();

    if (!activeSession) {
      return { success: true, message: 'No active session' };
    }

    // Deduplication: skip if last tick was less than 10 seconds ago (from a different source)
    if (activeSession.last_tick_at) {
      const lastTickTime = new Date(activeSession.last_tick_at).getTime();
      const now = Date.now();
      const secondsSinceLastTick = (now - lastTickTime) / 1000;
      if (secondsSinceLastTick < 10) {
        return { success: true, message: `Skipped: last tick was ${secondsSinceLastTick.toFixed(0)}s ago (source: ${source})` };
      }
    }

    // Update last_tick_at
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
      return { success: true, message: 'No open trade in active session' };
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

    // Check daily loss limit — square off and stop if breached
    const dailyPnlCheck = await getDailyPnl(supabase);
    const dailyLossLimitCheck = await getDailyLossLimit(supabase);
    // Include current session's running P&L in the check
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
      // Square off the open trade
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

    async function startNewSession(lastOptionType: string, lastPnl: number) {

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
            // Pause bot — create session in paused state for auto-resume
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

      const newRound = activeSession.current_round + 1;
      const newTotalPnl = activeSession.total_pnl + pnlAmount;


      if (newRound > activeSession.max_rounds) {
        await supabase.from('martingale_sessions').update({
          status: 'max_rounds_reached', total_pnl: newTotalPnl,
          completed_at: new Date().toISOString(), current_round: newRound - 1,
        }).eq('id', activeSession.id);

        const modeLabel = isActual ? '🔴' : '📝';
        actionTaken = `${modeLabel} ⛔ MAX ROUNDS (${activeSession.max_rounds}) reached. Session P&L: ₹${newTotalPnl.toFixed(0)}. Bot stopped — manual restart required.`;
        await sendTelegram(`📊 *Martingale Bot*\n\n${actionTaken}`);
      } else {
        const newOptionType = openTrade.option_type === 'CE' ? 'PE' : 'CE';
        const newLots = openTrade.lots * 2;

        const { optionData } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
        if (!optionData) {
          return { success: false, message: 'Could not fetch new option data for next round' };
        }

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
              // Pause bot for 10 mins
              await pauseBotWithNotification(supabase, activeSession.id,
                `Round ${newRound} BUY for ${newLots} lots ${newStrike} ${newOptionType} @ ₹${newPrice} failed after 3 attempts.`);
              await supabase.from('martingale_sessions').update({
                current_round: newRound, total_pnl: newTotalPnl,
              }).eq('id', activeSession.id);
              return { success: false, message: `Round ${newRound} order not filled after 3 attempts. Bot paused for 10 minutes.` };
            }
            actualRoundPrice = buyResult.filledPrice;
          }
        }

        await supabase.from('martingale_sessions').update({
          current_round: newRound, total_pnl: newTotalPnl,
        }).eq('id', activeSession.id);

        await supabase.from('martingale_trades').insert({
          session_id: activeSession.id, round: newRound, option_type: newOptionType,
          strike_price: newStrike, lots: newLots, entry_price: actualRoundPrice,
          status: 'open', nifty_spot: optionData.niftySpot,
        });

        const modeLabel = isActual ? '🔴' : '📝';
        actionTaken = `${modeLabel} 🔄 Round ${newRound}: Lost ${pnlPercent.toFixed(1)}%. Flipped to ${newLots} lots ${newStrike} ${newOptionType} @ ₹${newPrice}`;
      }

      await sendTelegram(`📊 *Martingale Bot*\n\n${actionTaken}`);
    }

    return {
      success: true, action: actionTaken,
      current_price: currentPrice, pnl_percent: pnlPercent, pnl_amount: pnlAmount,
    };
}
