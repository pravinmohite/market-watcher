import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Play, Square, RefreshCw, Zap, TrendingUp, TrendingDown, ArrowLeftRight, AlertTriangle, DollarSign, Activity, ArrowLeft, Link2, Unlink, Calendar, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Link, useSearchParams } from "react-router-dom";

const Martingale = () => {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [roundFilter, setRoundFilter] = useState<string>("all");
  const [manualToken, setManualToken] = useState<string>("");

  // Check for Upstox OAuth callback code in URL
  useEffect(() => {
    const code = searchParams.get('code');
    if (code) {
      const exchangeCode = async () => {
        try {
          const redirectUri = `${window.location.origin}/martingale`;
          const { data, error } = await supabase.functions.invoke("upstox-auth", {
            body: { action: "exchange", code, redirect_uri: redirectUri },
          });
          if (error) throw error;
          if (data?.success) {
            toast.success("Upstox connected! Real-time option data enabled.");
            queryClient.invalidateQueries({ queryKey: ["upstox-status"] });
            queryClient.invalidateQueries({ queryKey: ["martingale-status"] });
          } else {
            toast.error(data?.error || "Failed to connect Upstox");
          }
        } catch (err: any) {
          toast.error("Failed to exchange Upstox auth code");
          console.error(err);
        }
        setSearchParams({});
      };
      exchangeCode();
    }
  }, [searchParams]);

  const { data: upstoxStatus } = useQuery({
    queryKey: ["upstox-status"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("upstox-auth", {
        body: { action: "check-token" },
      });
      if (error) throw error;
      return data;
    },
    refetchInterval: 60000,
  });

  const [tradingMode, setTradingMode] = useState<'paper' | 'actual'>('paper');
  const [maxRounds, setMaxRounds] = useState<number>(5);
  const [lastTickAction, setLastTickAction] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["martingale-status"],
    queryFn: async () => {
      const { data: tickData } = await supabase.functions.invoke("martingale-bot", {
        body: { action: "tick" },
      });
      if (tickData?.action && tickData.action !== lastTickAction && !tickData.action.startsWith('Monitoring')) {
        setLastTickAction(tickData.action);
        toast.info(tickData.action);
      }
      const { data: statusData, error } = await supabase.functions.invoke("martingale-bot", {
        body: { action: "status" },
      });
      if (error) throw error;
      return statusData;
    },
    refetchInterval: 15000,
    refetchIntervalInBackground: true,
  });

  const connectUpstox = useMutation({
    mutationFn: async () => {
      const redirectUri = `${window.location.origin}/martingale`;
      const { data, error } = await supabase.functions.invoke("upstox-auth", {
        body: { action: "get-auth-url", redirect_uri: redirectUri },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      if (data?.auth_url) {
        window.location.href = data.auth_url;
      }
    },
    onError: () => toast.error("Failed to get Upstox auth URL"),
  });

  const saveManualToken = useMutation({
    mutationFn: async (token: string) => {
      const { data, error } = await supabase.functions.invoke("upstox-auth", {
        body: { action: "save-manual-token", access_token: token },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success(data?.message || "Token saved successfully!");
      setManualToken("");
      queryClient.invalidateQueries({ queryKey: ["upstox-status"] });
      queryClient.invalidateQueries({ queryKey: ["martingale-status"] });
    },
    onError: () => toast.error("Failed to save token"),
  });

  const startBot = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("martingale-bot", {
        body: { action: "start", trading_mode: tradingMode, max_rounds: maxRounds },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success(data.message || "Bot started!");
      queryClient.invalidateQueries({ queryKey: ["martingale-status"] });
    },
    onError: () => toast.error("Failed to start bot"),
  });

  const stopBot = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("martingale-bot", {
        body: { action: "stop" },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.info("Bot stopped");
      queryClient.invalidateQueries({ queryKey: ["martingale-status"] });
    },
    onError: () => toast.error("Failed to stop bot"),
  });

  const tickBot = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("martingale-bot", {
        body: { action: "tick" },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.info(data.action || data.message || "Tick complete");
      queryClient.invalidateQueries({ queryKey: ["martingale-status"] });
    },
    onError: () => toast.error("Tick failed"),
  });

  const activeSession = data?.active_session;
  const activeTrade = data?.active_trade;
  const currentPrice = data?.current_price;
  const currentPnl = data?.current_pnl_percent;
  const optionData = data?.option_data;
  const recentSessions = data?.recent_sessions || [];
  const allTrades = data?.all_trades || [];
  const isActive = activeSession?.status === 'active';
  const isUpstoxConnected = upstoxStatus?.connected;
  const dataSource = optionData?.source;

  // Build session mode lookup
  const sessionModeMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of recentSessions) {
      map[s.id] = s.trading_mode || 'paper';
    }
    return map;
  }, [recentSessions]);

  // Filter trades and sessions to last 2 days
  const twoDaysAgo = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 2);
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const recentTrades = useMemo(() => {
    let trades = allTrades.filter((t: any) => new Date(t.entry_time) >= twoDaysAgo);
    if (roundFilter !== "all") {
      const maxRound = parseInt(roundFilter);
      trades = trades.filter((t: any) => t.round <= maxRound);
    }
    return trades;
  }, [allTrades, twoDaysAgo, roundFilter]);

  const recentSess = useMemo(() => 
    recentSessions.filter((s: any) => new Date(s.created_at) >= twoDaysAgo),
    [recentSessions, twoDaysAgo]
  );

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border sticky top-0 z-10 bg-background/80 backdrop-blur-xl">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center">
              <Zap className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground tracking-tight">Martingale Bot</h1>
              <p className="text-xs text-muted-foreground">
                {activeSession?.trading_mode === 'actual' ? (
                  <span className="text-loss font-medium">🔴 Actual Trading</span>
                ) : tradingMode === 'actual' ? (
                  <span className="text-loss font-medium">🔴 Actual Mode Selected</span>
                ) : (
                  'Paper Trading'
                )} • Nifty Weekly Options • Doubling Strategy
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Trading Mode Toggle - only when bot is stopped */}
            {!isActive && (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className={cn("text-xs font-medium", tradingMode === 'paper' ? "text-foreground" : "text-muted-foreground")}>Paper</span>
                  <Switch
                    checked={tradingMode === 'actual'}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        if (!isUpstoxConnected) {
                          toast.error("Connect Upstox first before enabling actual trading");
                          return;
                        }
                        toast.warning("⚠️ Actual trading mode: Real orders will be placed on your Upstox account!", { duration: 5000 });
                      }
                      setTradingMode(checked ? 'actual' : 'paper');
                    }}
                  />
                  <span className={cn("text-xs font-medium", tradingMode === 'actual' ? "text-loss" : "text-muted-foreground")}>Actual</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Rounds:</span>
                  <select
                    value={maxRounds}
                    onChange={(e) => setMaxRounds(Number(e.target.value))}
                    className="text-xs bg-muted border border-border rounded px-1.5 py-0.5 text-foreground"
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
            {isActive && activeSession?.trading_mode && (
              <span className={cn(
                "px-2 py-1 rounded-full text-xs font-medium",
                activeSession.trading_mode === 'actual' ? "bg-loss/15 text-loss" : "bg-muted text-muted-foreground"
              )}>
                {activeSession.trading_mode === 'actual' ? '🔴 LIVE' : '📝 Paper'}
              </span>
            )}
            {isActive ? (
              <>
                <Button onClick={() => tickBot.mutate()} disabled={tickBot.isPending} variant="outline" size="sm" className="gap-1.5">
                  <RefreshCw className={cn("w-3.5 h-3.5", tickBot.isPending && "animate-spin")} />
                  Tick
                </Button>
                <Button onClick={() => stopBot.mutate()} disabled={stopBot.isPending} variant="destructive" size="sm" className="gap-1.5">
                  <Square className="w-3.5 h-3.5" />
                  Stop
                </Button>
              </>
            ) : (
              <Button
                onClick={() => {
                  if (tradingMode === 'actual') {
                    if (confirm('⚠️ You are about to start ACTUAL TRADING. Real orders will be placed on your Upstox account. Continue?')) {
                      startBot.mutate();
                    }
                  } else {
                    startBot.mutate();
                  }
                }}
                disabled={startBot.isPending}
                size="sm"
                className={cn("gap-1.5", tradingMode === 'actual' && "bg-loss hover:bg-loss/90")}
              >
                <Play className="w-3.5 h-3.5" />
                {startBot.isPending ? "Starting..." : tradingMode === 'actual' ? "Start LIVE" : "Start Bot"}
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Upstox Connection Banner */}
        <div className={cn(
          "rounded-xl border p-4 flex items-center justify-between",
          isUpstoxConnected ? "border-gain/30 bg-gain/5" : "border-warning/30 bg-warning/5"
        )}>
          <div className="flex items-center gap-3">
            {isUpstoxConnected ? (
              <Link2 className="w-4 h-4 text-gain" />
            ) : (
              <Unlink className="w-4 h-4 text-warning" />
            )}
            <div>
              <p className="text-sm font-medium text-foreground">
                {isUpstoxConnected ? "Upstox Connected" : "Upstox Not Connected"}
              </p>
              <p className="text-xs text-muted-foreground">
                {isUpstoxConnected
                  ? `Real-time option data active • Source: Upstox API`
                  : "Connect Upstox for accurate real-time option prices (login required daily)"
                }
              </p>
              {dataSource && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Current data source: <span className="font-mono font-medium text-foreground">{dataSource}</span>
                </p>
              )}
            </div>
          </div>
          {!isUpstoxConnected && (
            <Button
              onClick={() => connectUpstox.mutate()}
              disabled={connectUpstox.isPending}
              variant="outline"
              size="sm"
              className="gap-1.5 border-warning/50 text-warning hover:bg-warning/10"
            >
              <Link2 className="w-3.5 h-3.5" />
              {connectUpstox.isPending ? "Redirecting..." : "Connect Upstox"}
            </Button>
          )}
        </div>

        {/* Status Banner */}
        <div className={cn(
          "rounded-xl border p-4",
          isActive ? "border-primary/30 bg-primary/5" : "border-border bg-card"
        )}>
          <div className="flex items-center gap-3">
            <div className={cn(
              "w-3 h-3 rounded-full",
              isActive ? "bg-gain animate-pulse" : "bg-muted-foreground"
            )} />
            <span className="text-sm font-medium text-foreground">
              {isActive ? "Bot Running" : "Bot Stopped"}
            </span>
            {isActive && activeSession && (
              <span className="text-xs text-muted-foreground">
                • Round {activeSession.current_round}/{activeSession.max_rounds}
                • Session P&L: <span className={cn("font-mono font-medium", activeSession.total_pnl >= 0 ? "text-gain" : "text-loss")}>
                  ₹{Number(activeSession.total_pnl).toFixed(0)}
                </span>
              </span>
            )}
          </div>
        </div>

        {/* Market Data */}
        {optionData && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <MartingaleStatCard icon={<Activity className="w-4 h-4" />} label="Nifty Spot" value={`₹${optionData.niftySpot?.toFixed(0)}`} />
            <MartingaleStatCard icon={<TrendingUp className="w-4 h-4" />} label="OTM CE" value={`${optionData.otmCEStrike} @ ₹${optionData.otmCEPrice?.toFixed(1)}`} />
            <MartingaleStatCard icon={<TrendingDown className="w-4 h-4" />} label="OTM PE" value={`${optionData.otmPEStrike} @ ₹${optionData.otmPEPrice?.toFixed(1)}`} />
            <MartingaleStatCard icon={<ArrowLeftRight className="w-4 h-4" />} label="ATM Strike" value={optionData.atmStrike?.toString()} />
            <MartingaleStatCard icon={<Zap className="w-4 h-4" />} label="Weekly Expiry" value={optionData.expiry || '—'} />
          </div>
        )}

        {/* Active Trade */}
        {activeTrade && (
          <section>
            <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-primary" />
              Active Position
            </h2>
            <div className="rounded-xl border border-primary/30 bg-card p-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Option</p>
                  <p className="text-lg font-bold font-mono text-foreground">
                    {activeTrade.strike_price} {activeTrade.option_type}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Lots</p>
                  <p className="text-lg font-bold font-mono text-foreground">{activeTrade.lots}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Entry → Current</p>
                  <p className="text-lg font-bold font-mono text-foreground">
                    ₹{Number(activeTrade.entry_price).toFixed(1)} → {currentPrice !== null ? `₹${currentPrice.toFixed(1)}` : '...'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">P&L</p>
                  {currentPnl !== null ? (
                    <p className={cn("text-lg font-bold font-mono", currentPnl >= 0 ? "text-gain" : "text-loss")}>
                      {currentPnl >= 0 ? "+" : ""}{currentPnl.toFixed(2)}%
                    </p>
                  ) : (
                    <p className="text-lg font-bold font-mono text-muted-foreground">--</p>
                  )}
                </div>
              </div>
              <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
                <span>Round {activeTrade.round}</span>
                <span>Qty: {activeTrade.lots * 65}</span>
                <span>Capital: ₹{(activeTrade.lots * 65 * Number(activeTrade.entry_price)).toFixed(0)}</span>
                <span>Entered: {new Date(activeTrade.entry_time).toLocaleTimeString('en-IN')}</span>
              </div>
              {/* P&L Bar */}
              {currentPnl !== null && (
                <div className="mt-3">
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>-2% (Exit)</span>
                    <span>0%</span>
                    <span>+2.5% (Target)</span>
                  </div>
                  <div className="h-2 bg-muted rounded-full relative overflow-hidden">
                    <div
                      className={cn("absolute h-full rounded-full transition-all", currentPnl >= 0 ? "bg-gain" : "bg-loss")}
                      style={{
                        left: currentPnl >= 0 ? '40%' : `${Math.max(0, 40 + (currentPnl / 2) * 40)}%`,
                        width: currentPnl >= 0
                          ? `${Math.min((currentPnl / 2.5) * 60, 60)}%`
                          : `${Math.min(Math.abs(currentPnl / 2) * 40, 40)}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Strategy Explanation */}
        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            Strategy Rules
          </h2>
          <div className="grid md:grid-cols-2 gap-3 text-sm text-muted-foreground">
            <div className="space-y-2">
              <p>1️⃣ Smart entry: <strong className="text-foreground">follows last winning direction</strong> (trend-based for first session)</p>
              <p>2️⃣ If <span className="text-loss font-medium">-2%</span> → exit, <strong className="text-foreground">flip direction & double lots</strong></p>
              <p>3️⃣ Continue flipping & doubling (max <strong className="text-foreground">{isActive ? activeSession?.max_rounds : maxRounds} rounds</strong>)</p>
            </div>
            <div className="space-y-2">
              <p>🎯 <span className="text-gain font-medium">+2.5%</span> profit → exit & restart fresh</p>
              <p>⛔ Max rounds reached → <strong className="text-foreground">bot stops, manual restart required</strong></p>
              <p>🕒 Auto square-off at <strong className="text-foreground">3:25 PM</strong></p>
              <p>🔄 Toggle between <strong className="text-foreground">paper & actual trading</strong></p>
              <p>⚙️ Lot size: 65 (Nifty) • Weekly expiry</p>
            </div>
          </div>
        </section>

        {/* Date-wise P&L Summary (all days) */}
        <DateWisePnL sessions={recentSessions} allTrades={allTrades} sessionModeMap={sessionModeMap} />

        {/* Trade History (last 2 days) */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />
              Trade History <span className="text-xs font-normal text-muted-foreground">(Last 2 days)</span>
            </h2>
            <div className="flex items-center gap-2">
              <Filter className="w-3.5 h-3.5 text-muted-foreground" />
              <Select value={roundFilter} onValueChange={setRoundFilter}>
                <SelectTrigger className="h-8 w-[120px] text-xs">
                  <SelectValue placeholder="All Rounds" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Rounds</SelectItem>
                  <SelectItem value="1">R1 only</SelectItem>
                  <SelectItem value="2">R2 & below</SelectItem>
                  <SelectItem value="3">R3 & below</SelectItem>
                  <SelectItem value="4">R4 & below</SelectItem>
                  <SelectItem value="5">R5 & below</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {recentTrades.length === 0 ? (
            <p className="text-sm text-muted-foreground">No trades in the last 2 days.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                 <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="text-left p-3 text-muted-foreground font-medium">Time</th>
                    <th className="text-left p-3 text-muted-foreground font-medium">Mode</th>
                    <th className="text-left p-3 text-muted-foreground font-medium">Round</th>
                    <th className="text-left p-3 text-muted-foreground font-medium">Option</th>
                    <th className="text-right p-3 text-muted-foreground font-medium">Lots</th>
                    <th className="text-right p-3 text-muted-foreground font-medium">Qty</th>
                    <th className="text-right p-3 text-muted-foreground font-medium">Capital</th>
                    <th className="text-right p-3 text-muted-foreground font-medium">Entry</th>
                    <th className="text-right p-3 text-muted-foreground font-medium">Exit</th>
                    <th className="text-right p-3 text-muted-foreground font-medium">P&L</th>
                    <th className="text-left p-3 text-muted-foreground font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTrades.map((trade: any) => (
                    <tr key={trade.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                      <td className="p-3 text-xs font-mono text-muted-foreground">
                        {new Date(trade.entry_time).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="p-3">
                        <span className={cn(
                          "px-1.5 py-0.5 rounded-full text-xs font-medium",
                          sessionModeMap[trade.session_id] === 'actual' ? "bg-loss/15 text-loss" : "bg-muted text-muted-foreground"
                        )}>
                          {sessionModeMap[trade.session_id] === 'actual' ? '🔴 Live' : '📝 Paper'}
                        </span>
                      </td>
                      <td className="p-3 font-mono text-foreground">R{trade.round}</td>
                      <td className="p-3 font-mono text-foreground">
                        <span className={cn(
                          "px-1.5 py-0.5 rounded text-xs font-medium",
                          trade.option_type === 'CE' ? "bg-gain/15 text-gain" : "bg-loss/15 text-loss"
                        )}>
                          {trade.strike_price} {trade.option_type}
                        </span>
                      </td>
                      <td className="p-3 text-right font-mono text-foreground">{trade.lots}</td>
                      <td className="p-3 text-right font-mono text-foreground">{trade.lots * 65}</td>
                      <td className="p-3 text-right font-mono text-foreground">₹{(trade.lots * 65 * Number(trade.entry_price)).toFixed(0)}</td>
                      <td className="p-3 text-right font-mono text-foreground">₹{Number(trade.entry_price).toFixed(1)}</td>
                      <td className="p-3 text-right font-mono text-foreground">
                        {trade.exit_price ? `₹${Number(trade.exit_price).toFixed(1)}` : '—'}
                      </td>
                      <td className={cn("p-3 text-right font-mono font-medium",
                        trade.pnl > 0 ? "text-gain" : trade.pnl < 0 ? "text-loss" : "text-muted-foreground"
                      )}>
                        {trade.pnl !== null ? `₹${Number(trade.pnl).toFixed(0)}` : '—'}
                      </td>
                      <td className="p-3">
                        <span className={cn(
                          "px-2 py-0.5 rounded-full text-xs font-medium",
                          trade.status === 'open' ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                        )}>
                          {trade.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Session History (last 2 days) */}
        {recentSess.length > 0 && (
          <section>
            <h2 className="text-base font-semibold text-foreground mb-3">
              Session History <span className="text-xs font-normal text-muted-foreground">(Last 2 days)</span>
            </h2>
            <div className="grid gap-2">
              {recentSess.map((session: any) => (
                <div key={session.id} className={cn(
                  "rounded-lg border bg-card p-3 flex items-center justify-between",
                  session.trading_mode === 'actual' ? "border-loss/30" : "border-border"
                )}>
                  <div className="flex items-center gap-3">
                    <span className={cn(
                      "px-1.5 py-0.5 rounded-full text-xs font-medium",
                      session.trading_mode === 'actual' ? "bg-loss/15 text-loss" : "bg-muted text-muted-foreground"
                    )}>
                      {session.trading_mode === 'actual' ? '🔴 Live' : '📝 Paper'}
                    </span>
                    <span className={cn(
                      "px-2 py-0.5 rounded-full text-xs font-medium",
                      session.status === 'active' ? "bg-primary/15 text-primary" :
                      session.status === 'completed' ? "bg-gain/15 text-gain" :
                      session.status === 'squared_off' ? "bg-warning/15 text-warning" :
                      "bg-muted text-muted-foreground"
                    )}>
                      {session.status === 'squared_off' ? '3:25 exit' : session.status}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Rounds: {session.current_round}/{session.max_rounds}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={cn("font-mono font-medium text-sm",
                      session.total_pnl >= 0 ? "text-gain" : "text-loss"
                    )}>
                      ₹{Number(session.total_pnl).toFixed(0)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(session.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
};

const DateWisePnL = ({ sessions, allTrades, sessionModeMap }: { sessions: any[]; allTrades: any[]; sessionModeMap: Record<string, string> }) => {
  const dateData = useMemo(() => {
    const byDate: Record<string, { pnl: number; trades: number; sessions: number; paperPnl: number; actualPnl: number; paperTrades: number; actualTrades: number }> = {};
    
    for (const session of sessions) {
      if (session.status === 'active') continue;
      const date = new Date(session.created_at).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: '2-digit' });
      if (!byDate[date]) byDate[date] = { pnl: 0, trades: 0, sessions: 0, paperPnl: 0, actualPnl: 0, paperTrades: 0, actualTrades: 0 };
      byDate[date].sessions += 1;
    }
    
    for (const trade of allTrades) {
      if (trade.status !== 'closed') continue;
      const date = new Date(trade.entry_time).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: '2-digit' });
      if (!byDate[date]) byDate[date] = { pnl: 0, trades: 0, sessions: 0, paperPnl: 0, actualPnl: 0, paperTrades: 0, actualTrades: 0 };
      const tradePnl = Number(trade.pnl || 0);
      const mode = sessionModeMap[trade.session_id] || 'paper';
      byDate[date].pnl += tradePnl;
      byDate[date].trades += 1;
      if (mode === 'actual') {
        byDate[date].actualPnl += tradePnl;
        byDate[date].actualTrades += 1;
      } else {
        byDate[date].paperPnl += tradePnl;
        byDate[date].paperTrades += 1;
      }
    }
    
    return Object.entries(byDate)
      .sort(([a], [b]) => new Date(b).getTime() - new Date(a).getTime());
  }, [sessions, allTrades, sessionModeMap]);

  if (dateData.length === 0) return null;

  const totalPnl = dateData.reduce((sum, [, d]) => sum + d.pnl, 0);
  const totalActualPnl = dateData.reduce((sum, [, d]) => sum + d.actualPnl, 0);
  const totalPaperPnl = dateData.reduce((sum, [, d]) => sum + d.paperPnl, 0);
  const winDays = dateData.filter(([, d]) => d.pnl > 0).length;
  const lossDays = dateData.filter(([, d]) => d.pnl < 0).length;
  const hasActualTrades = dateData.some(([, d]) => d.actualTrades > 0);

  return (
    <section>
      <h2 className="text-base font-semibold text-foreground mb-3 flex items-center gap-2">
        <Calendar className="w-4 h-4 text-primary" />
        Date-wise P&L
      </h2>
      {/* Summary */}
      <div className={cn("grid gap-3 mb-3", hasActualTrades ? "grid-cols-2 md:grid-cols-5" : "grid-cols-3")}>
        <div className="rounded-xl border border-border bg-card p-3 text-center">
          <p className="text-xs text-muted-foreground">Total P&L</p>
          <p className={cn("text-lg font-bold font-mono", totalPnl >= 0 ? "text-gain" : "text-loss")}>
            ₹{totalPnl.toFixed(0)}
          </p>
        </div>
        {hasActualTrades && (
          <>
            <div className="rounded-xl border border-loss/30 bg-card p-3 text-center">
              <p className="text-xs text-muted-foreground">🔴 Actual P&L</p>
              <p className={cn("text-lg font-bold font-mono", totalActualPnl >= 0 ? "text-gain" : "text-loss")}>
                ₹{totalActualPnl.toFixed(0)}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-card p-3 text-center">
              <p className="text-xs text-muted-foreground">📝 Paper P&L</p>
              <p className={cn("text-lg font-bold font-mono", totalPaperPnl >= 0 ? "text-gain" : "text-loss")}>
                ₹{totalPaperPnl.toFixed(0)}
              </p>
            </div>
          </>
        )}
        <div className="rounded-xl border border-border bg-card p-3 text-center">
          <p className="text-xs text-muted-foreground">Win Days</p>
          <p className="text-lg font-bold font-mono text-gain">{winDays}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-3 text-center">
          <p className="text-xs text-muted-foreground">Loss Days</p>
          <p className="text-lg font-bold font-mono text-loss">{lossDays}</p>
        </div>
      </div>
      {/* Daily breakdown */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left p-3 text-muted-foreground font-medium">Date</th>
              <th className="text-right p-3 text-muted-foreground font-medium">Sessions</th>
              <th className="text-right p-3 text-muted-foreground font-medium">Trades</th>
              <th className="text-right p-3 text-muted-foreground font-medium">P&L</th>
              {hasActualTrades && (
                <>
                  <th className="text-right p-3 text-muted-foreground font-medium">🔴 Actual</th>
                  <th className="text-right p-3 text-muted-foreground font-medium">📝 Paper</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {dateData.map(([date, d]) => (
              <tr key={date} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                <td className="p-3 font-mono text-foreground">{date}</td>
                <td className="p-3 text-right font-mono text-muted-foreground">{d.sessions}</td>
                <td className="p-3 text-right font-mono text-muted-foreground">{d.trades}</td>
                <td className={cn("p-3 text-right font-mono font-medium", d.pnl >= 0 ? "text-gain" : "text-loss")}>
                  ₹{d.pnl.toFixed(0)}
                </td>
                {hasActualTrades && (
                  <>
                    <td className={cn("p-3 text-right font-mono font-medium", d.actualPnl >= 0 ? "text-gain" : "text-loss")}>
                      {d.actualTrades > 0 ? `₹${d.actualPnl.toFixed(0)}` : '—'}
                    </td>
                    <td className={cn("p-3 text-right font-mono font-medium", d.paperPnl >= 0 ? "text-gain" : "text-loss")}>
                      {d.paperTrades > 0 ? `₹${d.paperPnl.toFixed(0)}` : '—'}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const MartingaleStatCard = ({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) => (
  <div className="rounded-xl border border-border p-3 bg-card">
    <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
      {icon}
      <span className="text-xs">{label}</span>
    </div>
    <p className="text-sm font-bold font-mono text-foreground">{value}</p>
  </div>
);

export default Martingale;
