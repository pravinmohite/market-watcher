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
const SIDEWAYS_PAUSE_DURATION_MS = 15 * 60 * 1000;
const SIDEWAYS_MIN_ROUND = 3;
const SIDEWAYS_PAUSE_DURATION_MIN = SIDEWAYS_PAUSE_DURATION_MS / 60000;


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
): Promise<{ skip: boolean; reason: string }> {
  if (nextRound < SIDEWAYS_MIN_ROUND) {
    return { skip: false, reason: `R${nextRound}: allowed (<R${SIDEWAYS_MIN_ROUND})` };
  }

  const { data: recentTrades } = await supabase
    .from('martingale_trades')
    .select('round, pnl')
    .eq('session_id', sessionId)
    .eq('status', 'closed')
    .order('round', { ascending: false })
    .limit(2);
  if (!recentTrades || recentTrades.length < 2) {
    return { skip: false, reason: 'Not enough history' };
  }
  const lastTwoLosses = recentTrades.every((t: any) => (t.pnl || 0) < 0);
  if (!lastTwoLosses) {
    return { skip: false, reason: `R${nextRound}: last 2 not both losses` };
  }

  // Compute recent Nifty range (last RECENT_TRADES_WINDOW trades)
  const { data: allSessionTrades } = await supabase
    .from('martingale_trades')
    .select('nifty_spot, entry_time')
    .eq('session_id', sessionId)
    .order('entry_time', { ascending: true });
  let niftyRange = 0;
  if (allSessionTrades && allSessionTrades.length > 0) {
    const spots = allSessionTrades.map((t: any) => Number(t.nifty_spot)).filter((s: number) => s > 0);
    if (spots.length > 0) {
      niftyRange = calculateRange(spots, niftySpot, RECENT_TRADES_WINDOW);
    }
  }

  // Check premium decay vs anchors
  let strongDoubleDecay = false, mildDoubleDecay = false;
  let decayDetail = '';
  if (currentCEPrice > 0 && currentPEPrice > 0) {
    const { anchorCE, anchorPE } = await getSessionPremiumAnchors(supabase, sessionId, allSessionTrades);
    if (anchorCE && anchorPE && anchorCE > MIN_OPTION_PREMIUM && anchorPE > MIN_OPTION_PREMIUM) {
      const ceRatio = currentCEPrice / anchorCE;
      const peRatio = currentPEPrice / anchorPE;
      strongDoubleDecay = (ceRatio < SIDEWAYS_PREMIUM_DECAY_STRONG && peRatio < SIDEWAYS_PREMIUM_DECAY_STRONG);
      mildDoubleDecay   = (ceRatio < SIDEWAYS_PREMIUM_DECAY_WEAK   && peRatio < SIDEWAYS_PREMIUM_DECAY_WEAK);
      decayDetail = `CE ₹${anchorCE.toFixed(0)}→₹${currentCEPrice.toFixed(0)} (${((1-ceRatio)*100).toFixed(1)}%), ` +
                    `PE ₹${anchorPE.toFixed(0)}→₹${currentPEPrice.toFixed(0)} (${((1-peRatio)*100).toFixed(1)}%)`;
    }
  }

  // HARD block: strong decay + range under threshold
  if (strongDoubleDecay && niftyRange < SIDEWAYS_NIFTY_RANGE_THRESHOLD) {
    return {
      skip: true,
      reason: `R${nextRound}: Strong decay + low range (${niftyRange.toFixed(0)} pts). ${decayDetail}`,
    };
  }
  // SOFT block: mild decay + range under threshold_weaker
  if (mildDoubleDecay && niftyRange < SIDEWAYS_NIFTY_RANGE_THRESHOLD_WEAK) {
    return {
      skip: true,
      reason: `R${nextRound}: Mild decay + low range (${niftyRange.toFixed(0)} pts). ${decayDetail}`,
    };
  }
  // Safety: extreme scenario
  if ((!currentCEPrice || !currentPEPrice) && niftyRange < 15) {
    return {
      skip: true,
      reason: `R${nextRound}: No price data + very low range (${niftyRange.toFixed(0)} pts).`,
    };
  }

  return { skip: false, reason: `R${nextRound}: Market moving (${niftyRange.toFixed(0)} pts) or decay not strong` };
}


async function isInSidewaysPause(
  supabase: any,
  sessionId: string,
  niftySpot: number,
  supabaseUrl: string,
  anonKey: string,
  currentCEPrice?: number,
  currentPEPrice?: number,
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

  // Pause expired — recheck conditions (NEW)
  const nextRound = 3; // assume we are about to enter R3 after pause
  const { skip, reason } = await shouldSkipNextRound(
    supabase, sessionId, nextRound,
    niftySpot, supabaseUrl, anonKey,
    currentCEPrice, currentPEPrice
  );

  if (skip) {
    // Extend pause (NEW)
    await setSidewaysPause(supabase);
    return { paused: true, remainingMins: Math.ceil(SIDEWAYS_PAUSE_DURATION_MS / 60000) };
  }

  // Conditions cleared — exit pause
  await supabase.from('bot_settings').delete().eq('key', 'sideways_pause_until');
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
        .limit(2000);

      let allTrades: any[] = [];
      if (recentSessions && recentSessions.length > 0) {
        const oldestSession = recentSessions[recentSessions.length - 1];
        // Fetch all trades from the oldest session onwards, paginated to avoid limits
        let offset = 0;
        const pageSize = 5000;
        while (true) {
          const { data: trades } = await supabase
            .from('martingale_trades')
            .select('*')
            .gte('entry_time', oldestSession.created_at)
            .order('entry_time', { ascending: false })
            .range(offset, offset + pageSize - 1);
          if (!trades || trades.length === 0) break;
          allTrades = allTrades.concat(trades);
          if (trades.length < pageSize) break;
          offset += pageSize;
        }
      }

      const dailyPnl = await getDailyPnl(supabase);
      const dailyLossLimit = await getDailyLossLimit(supabase);
      const decayStatus = await getDecayStatus(supabase);

      // Get pause info for UI — check both order-fill pause and sideways pause
      let pauseInfo: { paused: boolean; pause_until?: string; reason?: string } = { paused: false };
      if (activeSession?.status === 'paused') {
        const { data: pauseData } = await supabase.from('bot_settings').select('key, value').in('key', ['pause_until', 'pause_reason']);
        if (pauseData) {
          const pauseUntil = pauseData.find((d: any) => d.key === 'pause_until')?.value;
          const pauseReason = pauseData.find((d: any) => d.key === 'pause_reason')?.value;
          pauseInfo = { paused: true, pause_until: pauseUntil, reason: pauseReason || 'Order fill failed' };
        }
      }
      // Also check sideways pause (no active session but bot is paused between sessions)
      if (!pauseInfo.paused && !activeSession) {
        const sidewaysPauseCheck = await isInSidewaysPause(supabase);
        if (sidewaysPauseCheck.paused) {
          const { data: spData } = await supabase.from('bot_settings').select('value').eq('key', 'sideways_pause_until').maybeSingle();
          pauseInfo = { paused: true, pause_until: spData?.value, reason: 'Sideways market detected — waiting for movement' };
        }
      }

      const { data: botRunningData } = await supabase.from('bot_settings').select('value').eq('key', 'bot_running').maybeSingle();
      const botRunning = botRunningData?.value === 'true';

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
        daily_loss_limit: dailyLossLimit,
        decay_status: decayStatus,
        pause_info: pauseInfo,
        bot_running: botRunning,
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
      }

      // Also stop any paused sessions
      await supabase.from('martingale_sessions').update({
        status: 'stopped', completed_at: new Date().toISOString(),
      }).eq('status', 'paused');

      // Clear sideways pause on manual stop
      await supabase.from('bot_settings').delete().eq('key', 'sideways_pause_until');

      if (!body.keep_running) {
        await supabase.from('bot_settings').delete().eq('key', 'bot_running');
      }

      return new Response(JSON.stringify({ success: true, message: 'Bot stopped' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'force_stop_all') {
      // Bulk stop all active/paused sessions without P&L calculation (for cleanup)
      await supabase.from('martingale_trades').update({ status: 'closed', exit_time: new Date().toISOString() }).eq('status', 'open');
      await supabase.from('martingale_sessions').update({ status: 'stopped', completed_at: new Date().toISOString() }).eq('status', 'active');
      await supabase.from('martingale_sessions').update({ status: 'stopped', completed_at: new Date().toISOString() }).eq('status', 'paused');
      await supabase.from('bot_settings').delete().eq('key', 'sideways_pause_until');
      await supabase.from('bot_settings').delete().eq('key', 'pause_until');
      await supabase.from('bot_settings').delete().eq('key', 'bot_running');
      return new Response(JSON.stringify({ success: true, message: 'Force stopped all sessions' }), {
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
          anchor_otm_ce_premium: anchorCe,
          anchor_otm_pe_premium: anchorPe,
        })
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

      await supabase.from('bot_settings').upsert({ key: 'bot_running', value: 'true', updated_at: new Date().toISOString() }, { onConflict: 'key' });

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

    const tickHour = nowIST_tick.getHours();
    const tickMinute = nowIST_tick.getMinutes();
    const tickTime = tickHour * 60 + tickMinute;

    // Strict trading windows: 9:25-11:15 and 14:30-15:25
    const WINDOW_1_START = 9 * 60 + 25;
    const WINDOW_1_END = 11 * 60 + 15;
    const WINDOW_2_START = 14 * 60 + 30;
    const WINDOW_2_END = 15 * 60 + 25;
    const inWindow1 = tickTime >= WINDOW_1_START && tickTime <= WINDOW_1_END;
    const inWindow2 = tickTime >= WINDOW_2_START && tickTime <= WINDOW_2_END;
    const inTradingWindow = inWindow1 || inWindow2;

    if (!inTradingWindow) {
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

            await supabase.from('martingale_trades').update({
              status: 'closed', exit_price: exitPrice, pnl: sqPnl, exit_time: new Date().toISOString(),
            }).eq('id', openTradeOutside.id);

            await supabase.from('martingale_sessions').update({
              status: 'squared_off', total_pnl: activeOutside.total_pnl + sqPnl, completed_at: new Date().toISOString(),
            }).eq('id', activeOutside.id);

            const modeLabel = activeOutside.trading_mode === 'actual' ? '🔴' : '📝';
            const windowLabel = tickTime > WINDOW_1_END && tickTime < WINDOW_2_START ? '11:15 AM' : '3:25 PM';
            await sendTelegram(`${modeLabel} ⏰ *Window Closed (${windowLabel})*\nSquared off ${openTradeOutside.option_type} ${openTradeOutside.strike_price} @ ₹${exitPrice} (P&L: ₹${sqPnl.toFixed(0)})`);
          } else {
            await supabase.from('martingale_sessions').update({
              status: 'squared_off', completed_at: new Date().toISOString(),
            }).eq('id', activeOutside.id);
          }
        }
      }

      return { success: true, message: `Outside trading windows (${tickHour}:${String(tickMinute).padStart(2, '0')} IST). Next: ${tickTime < WINDOW_1_START ? '9:25 AM' : tickTime < WINDOW_2_START ? '2:30 PM' : 'tomorrow 9:25 AM'}.` };
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
      // Check sideways_pause_until key BEFORE isInSidewaysPause clears it
      const { data: rawPauseData } = await supabase
        .from('bot_settings')
        .select('value')
        .eq('key', 'sideways_pause_until')
        .maybeSingle();
      
      const hadSidewaysPause = !!rawPauseData?.value;
      const sidewaysPause = await isInSidewaysPause(supabase);
      
      if (sidewaysPause.paused) {
        return { success: true, message: `⚠️ Sideways pause: ${sidewaysPause.remainingMins} min remaining. Will restart as fresh R1.` };
      }

      // Only auto-restart if a sideways pause key existed and just expired (was cleared by isInSidewaysPause)
      if (hadSidewaysPause && !sidewaysPause.paused) {
        const inMorningWindow = tickTime >= (9 * 60 + 25) && tickTime <= (11 * 60 + 15);
        const inAfternoonWindow = tickTime >= (14 * 60 + 30) && tickTime <= (15 * 60 + 25);
        if (inMorningWindow || inAfternoonWindow) {
          const dailyPnl = await getDailyPnl(supabase);
          const dailyLimit = await getDailyLossLimit(supabase);
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
                const newPauseUntil = await setSidewaysPause(supabase);
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
                    const newPauseUntil = await setSidewaysPause(supabase);
                    const ceDecay = ((1 - ceRatio) * 100).toFixed(1);
                    const peDecay = ((1 - peRatio) * 100).toFixed(1);
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

          const startRes = await fetch(`${supabaseUrl}/functions/v1/martingale-bot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
            body: JSON.stringify({ action: 'start', trading_mode: savedMode, max_rounds: savedMaxRounds }),
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

        const inMorningWindow = tickTime >= (9 * 60 + 25) && tickTime <= (11 * 60 + 15);
        const inAfternoonWindow = tickTime >= (14 * 60 + 30) && tickTime <= (15 * 60 + 25);
        if (inMorningWindow || inAfternoonWindow) {
          const dailyPnl = await getDailyPnl(supabase);
          const dailyLimit = await getDailyLossLimit(supabase);
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
            const startRes = await fetch(`${supabaseUrl}/functions/v1/martingale-bot`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
              body: JSON.stringify({ action: 'start', trading_mode: savedMode, max_rounds: savedMaxRounds }),
            });
            const startData = await startRes.json();
            return { success: true, action: `▶️ Auto-restarted: ${startData.message || 'new session'}` };
          } else {
            return { success: true, message: `⚠️ Bot watching — daily loss limit hit` };
          }
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
            .select('id')
            .eq('session_id', dup.id)
            .eq('status', 'open');
          if (dupTrades) {
            for (const t of dupTrades) {
              await supabase.from('martingale_trades').update({
                status: 'closed', exit_time: new Date().toISOString(),
              }).eq('id', t.id);
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
      // GUARD 1: Check if we're still in a trading window (use < for end boundary to prevent starting at exact square-off time)
      const nowCheck = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const checkTime = nowCheck.getHours() * 60 + nowCheck.getMinutes();
      const inW1 = checkTime >= (9 * 60 + 25) && checkTime < (11 * 60 + 15);
      const inW2 = checkTime >= (14 * 60 + 30) && checkTime < (15 * 60 + 25);
      if (!inW1 && !inW2) {
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

      // GUARD 4: Check sideways pause
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
          anchor_otm_ce_premium: newAnchorCe,
          anchor_otm_pe_premium: newAnchorPe,
        })
        .select()
        .single();
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
