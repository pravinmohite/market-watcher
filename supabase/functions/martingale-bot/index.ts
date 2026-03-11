import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const LOT_SIZE = 75;
const PROFIT_TARGET = 3;
const LOSS_LIMIT = 2;
const MAX_ROUNDS = 5;

interface OptionChainData {
  niftySpot: number;
  atmStrike: number;
  otmCEStrike: number;
  otmPEStrike: number;
  otmCEPrice: number;
  otmPEPrice: number;
  strikeDiff: number;
}

async function fetchNiftyOptionChain(supabaseUrl: string, anonKey: string, strike?: number, optionType?: string, entrySpot?: number, entryPrice?: number): Promise<{ optionData: OptionChainData | null; specificPrice: number | null }> {
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
    if (!res.ok) { console.error(`Proxy failed: ${res.status}`); await res.text(); return { optionData: null, specificPrice: null }; }
    const data = await res.json();
    if (!data.success) { console.error(`Proxy error: ${data.error}`); return { optionData: null, specificPrice: null }; }
    return {
      optionData: { niftySpot: data.niftySpot, atmStrike: data.atmStrike, otmCEStrike: data.otmCEStrike, otmPEStrike: data.otmPEStrike, otmCEPrice: data.otmCEPrice, otmPEPrice: data.otmPEPrice, strikeDiff: data.strikeDiff, source: data.source },
      specificPrice: data.specificPrice,
    };
  } catch (error) { console.error("Option chain error:", error); return { optionData: null, specificPrice: null }; }
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
        .limit(10);

      let allTrades: any[] = [];
      if (recentSessions && recentSessions.length > 0) {
        const sessionIds = recentSessions.map((s: any) => s.id);
        const { data: trades } = await supabase
          .from('martingale_trades')
          .select('*')
          .in('session_id', sessionIds)
          .order('entry_time', { ascending: false });
        allTrades = trades || [];
      }

      return new Response(JSON.stringify({
        success: true,
        active_session: activeSession,
        active_trade: activeTrade,
        current_price: currentPrice,
        current_pnl_percent: currentPnlPercent,
        option_data: optionData,
        recent_sessions: recentSessions || [],
        all_trades: allTrades,
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

      const { optionData } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
      if (!optionData) {
        return new Response(JSON.stringify({ success: false, message: 'Could not fetch option chain data' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: session, error: sessErr } = await supabase
        .from('martingale_sessions')
        .insert({ status: 'active', current_round: 1, max_rounds: MAX_ROUNDS })
        .select()
        .single();
      if (sessErr) throw sessErr;

      // Don't enter trade if price is 0
      if (optionData.otmCEPrice <= 0) {
        return new Response(JSON.stringify({ success: false, message: `Cannot start: option price is ₹0. Upstox may not be returning data. Source: ${optionData.source || 'unknown'}` }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { error: tradeErr } = await supabase
        .from('martingale_trades')
        .insert({
          session_id: session.id, round: 1, option_type: 'CE',
          strike_price: optionData.otmCEStrike, lots: 1,
          entry_price: optionData.otmCEPrice, status: 'open', nifty_spot: optionData.niftySpot,
        });
      if (tradeErr) throw tradeErr;

      return new Response(JSON.stringify({
        success: true,
        message: `Started! Bought 1 lot ${optionData.otmCEStrike} CE @ ₹${optionData.otmCEPrice}`,
        session,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // action === 'tick'
    const { data: activeSession } = await supabase
      .from('martingale_sessions')
      .select('*')
      .eq('status', 'active')
      .maybeSingle();

    if (!activeSession) {
      return new Response(JSON.stringify({ success: true, message: 'No active session' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: openTrade } = await supabase
      .from('martingale_trades')
      .select('*')
      .eq('session_id', activeSession.id)
      .eq('status', 'open')
      .maybeSingle();

    if (!openTrade) {
      return new Response(JSON.stringify({ success: true, message: 'No open trade in active session' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { specificPrice: currentPrice } = await fetchNiftyOptionChain(
      supabaseUrl, anonKey, openTrade.strike_price, openTrade.option_type, openTrade.nifty_spot, openTrade.entry_price
    );

    if (currentPrice === null) {
      return new Response(JSON.stringify({ success: true, message: 'Could not fetch current price' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const pnlPercent = ((currentPrice - openTrade.entry_price) / openTrade.entry_price) * 100;
    const pnlAmount = (currentPrice - openTrade.entry_price) * openTrade.lots * LOT_SIZE;
    let actionTaken = `Monitoring: ${openTrade.option_type} ${openTrade.strike_price} @ ₹${currentPrice} (${pnlPercent.toFixed(2)}%)`;

    async function startNewSession() {
      const { optionData } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
      if (optionData) {
        const { data: newSession } = await supabase
          .from('martingale_sessions')
          .insert({ status: 'active', current_round: 1, max_rounds: MAX_ROUNDS })
          .select().single();
        if (newSession) {
          await supabase.from('martingale_trades').insert({
            session_id: newSession.id, round: 1, option_type: 'CE',
            strike_price: optionData.otmCEStrike, lots: 1,
            entry_price: optionData.otmCEPrice, status: 'open', nifty_spot: optionData.niftySpot,
          });
        }
      }
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

    // Check profit target
    if (pnlPercent >= PROFIT_TARGET) {
      await supabase.from('martingale_trades').update({
        status: 'closed', exit_price: currentPrice, pnl: pnlAmount, exit_time: new Date().toISOString(),
      }).eq('id', openTrade.id);

      await supabase.from('martingale_sessions').update({
        status: 'completed', total_pnl: activeSession.total_pnl + pnlAmount, completed_at: new Date().toISOString(),
      }).eq('id', activeSession.id);

      await startNewSession();
      actionTaken = `🎯 PROFIT! Exited ${openTrade.option_type} ${openTrade.strike_price} @ ₹${currentPrice} (+${pnlPercent.toFixed(1)}%, ₹${pnlAmount.toFixed(0)}). New session started.`;
      await sendTelegram(`🎯 *Martingale Bot - PROFIT*\n\n${actionTaken}`);
    }
    // Check loss limit
    else if (pnlPercent <= -LOSS_LIMIT) {
      await supabase.from('martingale_trades').update({
        status: 'closed', exit_price: currentPrice, pnl: pnlAmount, exit_time: new Date().toISOString(),
      }).eq('id', openTrade.id);

      const newRound = activeSession.current_round + 1;
      const newTotalPnl = activeSession.total_pnl + pnlAmount;

      if (newRound > MAX_ROUNDS) {
        await supabase.from('martingale_sessions').update({
          status: 'max_rounds_reached', total_pnl: newTotalPnl,
          completed_at: new Date().toISOString(), current_round: newRound - 1,
        }).eq('id', activeSession.id);

        actionTaken = `⛔ MAX ROUNDS (${MAX_ROUNDS}) reached. Session P&L: ₹${newTotalPnl.toFixed(0)}. Starting fresh.`;
        await startNewSession();
      } else {
        const newOptionType = openTrade.option_type === 'CE' ? 'PE' : 'CE';
        const newLots = openTrade.lots * 2;

        const { optionData } = await fetchNiftyOptionChain(supabaseUrl, anonKey);
        if (!optionData) {
          return new Response(JSON.stringify({ success: false, message: 'Could not fetch new option data for next round' }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const newStrike = newOptionType === 'CE' ? optionData.otmCEStrike : optionData.otmPEStrike;
        const newPrice = newOptionType === 'CE' ? optionData.otmCEPrice : optionData.otmPEPrice;

        await supabase.from('martingale_sessions').update({
          current_round: newRound, total_pnl: newTotalPnl,
        }).eq('id', activeSession.id);

        await supabase.from('martingale_trades').insert({
          session_id: activeSession.id, round: newRound, option_type: newOptionType,
          strike_price: newStrike, lots: newLots, entry_price: newPrice,
          status: 'open', nifty_spot: optionData.niftySpot,
        });

        actionTaken = `🔄 Round ${newRound}: Lost ${pnlPercent.toFixed(1)}%. Flipped to ${newLots} lots ${newStrike} ${newOptionType} @ ₹${newPrice}`;
      }

      await sendTelegram(`📊 *Martingale Bot*\n\n${actionTaken}`);
    }

    return new Response(JSON.stringify({
      success: true, action: actionTaken,
      current_price: currentPrice, pnl_percent: pnlPercent, pnl_amount: pnlAmount,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error("Martingale bot error:", error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
