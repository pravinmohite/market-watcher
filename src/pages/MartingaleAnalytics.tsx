import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { ArrowLeft, BarChart3, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

type PremiumTick = {
  id: string;
  recorded_at: string;
  nifty_spot: number;
  otm_ce_strike: number | null;
  otm_pe_strike: number | null;
  otm_ce_premium: number | null;
  otm_pe_premium: number | null;
  active_option_type: string;
  active_strike: number;
  active_premium: number;
  trade_id: string;
  tick_source: string;
};

type TradeRow = {
  id: string;
  session_id: string;
  round: number;
  option_type: string;
  strike_price: number;
  entry_price: number;
  exit_price: number | null;
  entry_time: string;
  exit_time: string | null;
  pnl: number | null;
  status: string;
  trade_result: string | null;
  trade_log: unknown;
};

/** Sideways/decay gate snapshot written on martingale-flip entries (see edge `sideways_gate_eval`). */
type SidewaysGateEval = {
  gate_round?: number;
  last_two_losses?: boolean;
  nifty_range_pts?: number;
  range_window_trades?: number;
  thresholds?: {
    strong_decay_ratio?: number;
    weak_decay_ratio?: number;
    strong_range_lt?: number;
    weak_range_lt?: number;
  };
  anchor_ce?: number | null;
  anchor_pe?: number | null;
  current_ce?: number | null;
  current_pe?: number | null;
  ce_ratio?: number | null;
  pe_ratio?: number | null;
  range_source?: "premium_ticks" | "trade_spots" | "none";
  anchor_ce_strike?: number | null;
  anchor_pe_strike?: number | null;
  current_ce_strike?: number | null;
  current_pe_strike?: number | null;
  strike_consistent?: boolean;
  strong_double_decay?: boolean;
  mild_double_decay?: boolean;
  skip_decision?: boolean;
};

function sidewaysGateTooltip(ev: SidewaysGateEval): string {
  return JSON.stringify(ev, null, 2);
}

function gateRangeShort(ev: SidewaysGateEval): string {
  if (ev.range_source === "none" || ev.range_source == null || ev.nifty_range_pts == null) return "—";
  const src =
    ev.range_source === "premium_ticks" ? "ticks" : ev.range_source === "trade_spots" ? "trades" : ev.range_source;
  return `${Number(ev.nifty_range_pts).toFixed(1)} (${src})`;
}

function gateRatiosShort(ev: SidewaysGateEval): string {
  if (ev.ce_ratio == null && ev.pe_ratio == null) return "—";
  const c = ev.ce_ratio != null ? Number(ev.ce_ratio).toFixed(3) : "—";
  const p = ev.pe_ratio != null ? Number(ev.pe_ratio).toFixed(3) : "—";
  return `${c} / ${p}`;
}

function gateDecayShort(ev: SidewaysGateEval): string {
  if (ev.strong_double_decay) return "strong";
  if (ev.mild_double_decay) return "mild";
  return "—";
}

function gateYesNo(val: boolean | undefined): string {
  if (val === undefined) return "—";
  return val ? "Y" : "N";
}

function fmtIst(iso: string) {
  try {
    return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  } catch {
    return iso;
  }
}

/** IST weekday label → offset from Monday (Mon=0 … Sun=6). */
function istMondayContaining(anchorYmd: string): string {
  const ms = Date.parse(`${anchorYmd}T12:00:00+05:30`);
  const label = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short" }).format(new Date(ms));
  const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const dow = map[label] ?? 0;
  const monMs = ms - dow * 86400000;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(monMs));
}

function weekEndFromMondayIst(monYmd: string): string {
  const monMs = Date.parse(`${monYmd}T12:00:00+05:30`);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(monMs + 6 * 86400000),
  );
}

/** Default anchor: calendar week that ended last Sunday → its Monday YMD (IST). */
function previousCompletedWeekMondayDefault(): string {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const ymd = `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, "0")}-${String(ist.getDate()).padStart(2, "0")}`;
  const thisMon = istMondayContaining(ymd);
  const thisMonMs = Date.parse(`${thisMon}T12:00:00+05:30`);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(thisMonMs - 7 * 86400000),
  );
}

const MartingaleAnalytics = () => {
  const queryClient = useQueryClient();
  const [analysisDay, setAnalysisDay] = useState(() => {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    d.setDate(d.getDate() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  });

  const [weekAnchorDay, setWeekAnchorDay] = useState(previousCompletedWeekMondayDefault);
  const weekStartIst = useMemo(() => istMondayContaining(weekAnchorDay), [weekAnchorDay]);
  const weekEndIst = useMemo(() => weekEndFromMondayIst(weekStartIst), [weekStartIst]);

  const { data: ticks = [], isLoading: ticksLoading } = useQuery({
    queryKey: ["martingale-premium-ticks"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("martingale_premium_ticks" as never)
        .select(
          "id, recorded_at, nifty_spot, otm_ce_strike, otm_pe_strike, otm_ce_premium, otm_pe_premium, active_option_type, active_strike, active_premium, trade_id, tick_source",
        )
        .order("recorded_at", { ascending: false })
        .limit(400);
      if (error) throw error;
      return (data || []) as PremiumTick[];
    },
    refetchInterval: 30_000,
  });

  const { data: trades = [], isLoading: tradesLoading } = useQuery({
    queryKey: ["martingale-trades-analytics"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("martingale_trades" as never)
        .select(
          "id, session_id, round, option_type, strike_price, entry_price, exit_price, entry_time, exit_time, pnl, status, trade_result, trade_log",
        )
        .order("entry_time", { ascending: false })
        .limit(150);
      if (error) throw error;
      return (data || []) as TradeRow[];
    },
    refetchInterval: 60_000,
  });

  const { data: reports = [], isLoading: reportsLoading } = useQuery({
    queryKey: ["martingale-daily-reports"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("martingale_daily_reports" as never)
        .select("id, trading_day, report, created_at")
        .order("trading_day", { ascending: false })
        .limit(45);
      if (error) throw error;
      return (data || []) as { id: string; trading_day: string; report: Record<string, unknown>; created_at: string }[];
    },
  });

  const { data: weeklyReports = [], isLoading: weeklyReportsLoading } = useQuery({
    queryKey: ["martingale-weekly-reports"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("martingale_weekly_reports" as never)
        .select("id, week_start, week_end, report, created_at")
        .order("week_start", { ascending: false })
        .limit(24);
      if (error) throw error;
      return (data || []) as {
        id: string;
        week_start: string;
        week_end: string;
        report: Record<string, unknown>;
        created_at: string;
      }[];
    },
  });

  const runAnalysis = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("martingale-bot", {
        body: { action: "daily_analysis", trading_day: analysisDay, persist: true },
      });
      if (error) throw error;
      return data as { success?: boolean; report?: unknown; error?: string };
    },
    onSuccess: (d) => {
      if (d?.success === false) toast.error(d?.error || "Analysis failed");
      else {
        toast.success(`Daily analysis saved for ${analysisDay}`);
        queryClient.invalidateQueries({ queryKey: ["martingale-daily-reports"] });
      }
    },
    onError: () => toast.error("Could not run daily_analysis"),
  });

  const runWeeklyAnalysis = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("martingale-bot", {
        body: { action: "weekly_analysis", week_start: weekStartIst, persist: true },
      });
      if (error) throw error;
      return data as { success?: boolean; report?: unknown; error?: string; week_start?: string; week_end?: string };
    },
    onSuccess: (d) => {
      if (d?.success === false) toast.error(d?.error || "Weekly analysis failed");
      else {
        toast.success(`Weekly analysis saved (${d?.week_start ?? weekStartIst} → ${d?.week_end ?? weekEndIst})`);
        queryClient.invalidateQueries({ queryKey: ["martingale-weekly-reports"] });
      }
    },
    onError: () => toast.error("Could not run weekly_analysis"),
  });

  const ticksWithDelta = useMemo(() => {
    const asc = [...ticks].sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());
    return asc.map((row, i) => {
      const prev = i > 0 ? asc[i - 1] : null;
      const dCe = prev && row.otm_ce_premium != null && prev.otm_ce_premium != null ? row.otm_ce_premium - prev.otm_ce_premium : null;
      const dPe = prev && row.otm_pe_premium != null && prev.otm_pe_premium != null ? row.otm_pe_premium - prev.otm_pe_premium : null;
      const dN = prev ? row.nifty_spot - prev.nifty_spot : null;
      const spread = row.otm_ce_premium != null && row.otm_pe_premium != null ? row.otm_ce_premium - row.otm_pe_premium : null;
      return { ...row, dCe, dPe, dN, spread };
    });
  }, [ticks]);

  const ticksDisplay = useMemo(() => [...ticksWithDelta].reverse(), [ticksWithDelta]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border sticky top-0 z-10 bg-background/85 backdrop-blur-xl">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Link to="/martingale" className="text-muted-foreground hover:text-foreground shrink-0">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <BarChart3 className="w-5 h-5 text-primary shrink-0" />
            <div className="min-w-0">
              <h1 className="text-base font-semibold truncate">Martingale analytics & logs</h1>
              <p className="text-xs text-muted-foreground truncate">Premium ticks, trades, daily &amp; weekly reports</p>
            </div>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/martingale">Bot controls</Link>
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">How this helps (breakouts & losses)</CardTitle>
            <CardDescription className="space-y-2 text-sm">
              <p>
                <strong>Premium ticks:</strong> Each row is a snapshot while a position is open — <strong>OTM CE and OTM PE</strong> premiums
                from the same chain response as the bot, plus your <strong>active leg</strong> mark. Rows are written at most once per{" "}
                <strong>15 seconds per open trade</strong> (when the bot gets a valid price). Ce/Pe deltas between rows show{" "}
                <em>decay</em> vs <em>both rising</em> (often with spot direction).
              </p>
              <p>
                <strong>Breakouts (manual read):</strong> There is no guaranteed “breakout detector” here — use ticks + Nifty Δ: e.g. CE and PE
                both falling with flat Nifty ⇒ typical decay; sustained Nifty move with one side expanding faster ⇒ directional pressure. Pair
                this with your daily report segments (trend bucket, time bucket) before changing rules.
              </p>
              <p>
                <strong>Earlier logging:</strong> Trade open/close rows store <code className="text-xs">trade_log</code> (entry market snapshot,
                exit reason) but <strong>did not</strong> store dual CE/PE every tick until now.
              </p>
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div>
              <CardTitle className="text-base">Daily analysis</CardTitle>
              <CardDescription>
                Generate report for an IST calendar date (closed trades by <code className="text-xs">exit_time</code>).
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={analysisDay}
                onChange={(e) => setAnalysisDay(e.target.value)}
                className="text-sm rounded-md border border-input bg-background px-2 py-1.5"
              />
              <Button size="sm" onClick={() => runAnalysis.mutate()} disabled={runAnalysis.isPending} className="gap-1">
                <Sparkles className="w-3.5 h-3.5" />
                Run &amp; save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  queryClient.invalidateQueries({ queryKey: ["martingale-daily-reports"] });
                  queryClient.invalidateQueries({ queryKey: ["martingale-weekly-reports"] });
                  queryClient.invalidateQueries({ queryKey: ["martingale-premium-ticks"] });
                  queryClient.invalidateQueries({ queryKey: ["martingale-trades-analytics"] });
                }}
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
                Refresh tables
              </Button>
            </div>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div>
              <CardTitle className="text-base">Weekly analysis (IST Mon–Sun)</CardTitle>
              <CardDescription>
                Pick any day — the bot normalizes to the <strong>Monday</strong> that starts that IST week ({weekStartIst} → {weekEndIst}). After{" "}
                <strong>2–3 days</strong> of CE/PE ticks and closed trades, re-run to surface pattern-based notes in{" "}
                <em>expert review</em> (education only).
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={weekAnchorDay}
                onChange={(e) => setWeekAnchorDay(e.target.value)}
                className="text-sm rounded-md border border-input bg-background px-2 py-1.5"
              />
              <Button size="sm" onClick={() => runWeeklyAnalysis.mutate()} disabled={runWeeklyAnalysis.isPending} className="gap-1">
                <Sparkles className="w-3.5 h-3.5" />
                Run week &amp; save
              </Button>
            </div>
          </CardHeader>
        </Card>

        <Tabs defaultValue="ticks">
          <TabsList className="flex-wrap h-auto gap-1">
            <TabsTrigger value="ticks">CE/PE ticks ({ticks.length})</TabsTrigger>
            <TabsTrigger value="trades">Trades ({trades.length})</TabsTrigger>
            <TabsTrigger value="reports">
              Reports ({reports.length} · {weeklyReports.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="ticks" className="mt-4">
            <Card>
              <CardContent className="pt-4">
                <div className="max-h-[560px] overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>IST time</TableHead>
                        <TableHead className="text-right">Nifty</TableHead>
                        <TableHead className="text-right">ΔNx</TableHead>
                        <TableHead className="text-right">CE prem</TableHead>
                        <TableHead className="text-right">ΔCE</TableHead>
                        <TableHead className="text-right">PE prem</TableHead>
                        <TableHead className="text-right">ΔPE</TableHead>
                        <TableHead className="text-right">CE−PE</TableHead>
                        <TableHead>Held</TableHead>
                        <TableHead className="text-right">Held ₹</TableHead>
                        <TableHead className="text-xs">src</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ticksLoading ? (
                        <TableRow>
                          <TableCell colSpan={11} className="text-muted-foreground">
                            Loading…
                          </TableCell>
                        </TableRow>
                      ) : ticksDisplay.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={11} className="text-muted-foreground">
                            No ticks yet. Opens require an active session and successful chain fetch; snapshots are throttled to ~15s per open
                            trade.
                          </TableCell>
                        </TableRow>
                      ) : (
                        ticksDisplay.map((r) => (
                          <TableRow key={r.id}>
                            <TableCell className="whitespace-nowrap text-xs">{fmtIst(r.recorded_at)}</TableCell>
                            <TableCell className="text-right font-mono text-xs">{Number(r.nifty_spot).toFixed(1)}</TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {r.dN != null ? r.dN.toFixed(1) : "—"}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {r.otm_ce_premium != null ? r.otm_ce_premium.toFixed(1) : "—"}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">{r.dCe != null ? r.dCe.toFixed(2) : "—"}</TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {r.otm_pe_premium != null ? r.otm_pe_premium.toFixed(1) : "—"}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">{r.dPe != null ? r.dPe.toFixed(2) : "—"}</TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {r.spread != null ? r.spread.toFixed(1) : "—"}
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              {r.active_option_type} {r.active_strike}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">{r.active_premium.toFixed(2)}</TableCell>
                            <TableCell className="text-[10px] text-muted-foreground">{r.tick_source}</TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="trades" className="mt-4">
            <Card>
              <CardContent className="pt-4">
                <div className="max-h-[560px] overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Entry (IST)</TableHead>
                        <TableHead>R</TableHead>
                        <TableHead>Leg</TableHead>
                        <TableHead className="text-right">Strike</TableHead>
                        <TableHead className="text-right">Entry ₹</TableHead>
                        <TableHead className="text-right">Exit ₹</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">PnL ₹</TableHead>
                        <TableHead>Trend @entry</TableHead>
                        <TableHead className="text-xs max-w-[140px]">Entry tag</TableHead>
                        <TableHead className="text-xs text-center" title="Round evaluated by sideways gate">
                          Gate R
                        </TableHead>
                        <TableHead className="text-xs whitespace-nowrap" title="Nifty range + source (premium ticks vs trade spots)">
                          Nifty rng
                        </TableHead>
                        <TableHead className="text-xs whitespace-nowrap" title="CE/PE ratio vs session anchor premiums">
                          CE/PE r
                        </TableHead>
                        <TableHead className="text-xs" title="Double-decay tier">
                          Decay
                        </TableHead>
                        <TableHead className="text-xs text-center" title="Anchor vs current OTM strikes aligned">
                          Str OK
                        </TableHead>
                        <TableHead className="text-xs text-center" title="Gate would skip this round (pause session)">
                          Skip?
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tradesLoading ? (
                        <TableRow>
                          <TableCell colSpan={16} className="text-muted-foreground">
                            Loading…
                          </TableCell>
                        </TableRow>
                      ) : (
                        trades.map((t) => {
                          const lg = (t.trade_log || {}) as {
                            entry?: {
                              market?: { trend?: string };
                              entry_reason_rule_tag?: string;
                              sideways_gate_eval?: SidewaysGateEval | null;
                            };
                            exit?: { close_reason?: string };
                          };
                          const ge =
                            lg.entry?.sideways_gate_eval && typeof lg.entry.sideways_gate_eval === "object"
                              ? (lg.entry.sideways_gate_eval as SidewaysGateEval)
                              : null;
                          const gateFull = ge ? sidewaysGateTooltip(ge) : undefined;
                          return (
                            <TableRow key={t.id}>
                              <TableCell className="text-xs whitespace-nowrap">{fmtIst(t.entry_time)}</TableCell>
                              <TableCell>{t.round}</TableCell>
                              <TableCell className="text-xs">{t.option_type}</TableCell>
                              <TableCell className="text-right">{t.strike_price}</TableCell>
                              <TableCell className="text-right font-mono text-xs">{t.entry_price}</TableCell>
                              <TableCell className="text-right font-mono text-xs">{t.exit_price ?? "—"}</TableCell>
                              <TableCell className="text-xs">{t.status}</TableCell>
                              <TableCell className={`text-right font-mono text-xs ${(t.pnl || 0) < 0 ? "text-loss" : ""}`}>
                                {t.pnl != null ? t.pnl.toFixed(0) : "—"}
                              </TableCell>
                              <TableCell className="text-xs">{lg.entry?.market?.trend ?? "—"}</TableCell>
                              <TableCell className="text-[10px] max-w-[200px] truncate" title={lg.entry?.entry_reason_rule_tag}>
                                {lg.entry?.entry_reason_rule_tag ?? "—"}
                              </TableCell>
                              <TableCell className="text-center text-xs font-mono" title={gateFull}>
                                {ge?.gate_round != null ? ge.gate_round : "—"}
                              </TableCell>
                              <TableCell className="text-xs font-mono whitespace-nowrap" title={gateFull}>
                                {ge ? gateRangeShort(ge) : "—"}
                              </TableCell>
                              <TableCell className="text-[10px] font-mono whitespace-nowrap max-w-[100px]" title={gateFull}>
                                {ge ? gateRatiosShort(ge) : "—"}
                              </TableCell>
                              <TableCell className="text-xs capitalize" title={gateFull}>
                                {ge ? gateDecayShort(ge) : "—"}
                              </TableCell>
                              <TableCell className="text-center text-xs font-mono" title={gateFull}>
                                {ge ? gateYesNo(ge.strike_consistent) : "—"}
                              </TableCell>
                              <TableCell className="text-center text-xs font-mono" title={gateFull}>
                                {ge && ge.skip_decision !== undefined ? (ge.skip_decision ? "Y" : "N") : "—"}
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="reports" className="mt-4 space-y-8">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Daily reports</CardTitle>
                <CardDescription className="text-xs">Saved from the daily analysis card above.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-[560px] overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Trading day</TableHead>
                        <TableHead className="text-right">Trades</TableHead>
                        <TableHead className="text-right">Win %</TableHead>
                        <TableHead className="text-right">Max DD ₹</TableHead>
                        <TableHead className="text-[10px] whitespace-nowrap" title="Sideways/decay gate pauses logged that day">
                          Pause gates
                        </TableHead>
                        <TableHead className="text-xs max-w-[320px]">Sample warnings</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {reportsLoading ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-muted-foreground">
                            Loading…
                          </TableCell>
                        </TableRow>
                      ) : reports.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-muted-foreground">
                            No saved reports. Pick a date above and Run & save.
                          </TableCell>
                        </TableRow>
                      ) : (
                        reports.map((rep) => {
                          const summary = rep.report?.summary as
                            | { trade_count_closed?: number; win_rate_pct?: number; max_drawdown_inr?: number }
                            | undefined;
                          const warnings = rep.report?.risk_warnings as string[] | undefined;
                          const pauseSum = rep.report?.pause_gate_summary as
                            | {
                                count?: number;
                                avg_nifty_range_pts?: number | null;
                                avg_ce_drop_pct?: number | null;
                                avg_pe_drop_pct?: number | null;
                              }
                            | undefined;
                          const pauseLabel =
                            pauseSum?.count != null && pauseSum.count > 0
                              ? `${pauseSum.count} · rng ${pauseSum.avg_nifty_range_pts ?? "—"} · CE↓${pauseSum.avg_ce_drop_pct ?? "—"}% PE↓${pauseSum.avg_pe_drop_pct ?? "—"}%`
                              : "—";
                          return (
                            <TableRow key={rep.id}>
                              <TableCell className="font-medium">{rep.trading_day}</TableCell>
                              <TableCell className="text-right">{summary?.trade_count_closed ?? "—"}</TableCell>
                              <TableCell className="text-right">
                                {summary?.win_rate_pct != null ? `${Number(summary.win_rate_pct).toFixed(1)}%` : "—"}
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs">
                                {summary?.max_drawdown_inr != null ? Number(summary.max_drawdown_inr).toFixed(0) : "—"}
                              </TableCell>
                              <TableCell className="text-[10px] font-mono text-muted-foreground max-w-[220px]" title={pauseLabel}>
                                {pauseLabel}
                              </TableCell>
                              <TableCell className="text-[11px] text-muted-foreground max-w-md">
                                {warnings?.length ? warnings.join("; ") : "—"}
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Weekly reports</CardTitle>
                <CardDescription className="text-xs">
                  IST week roll-up with <code className="text-[10px]">expert_review</code> (options-style notes from win/loss structure, weekday
                  clusters, martingale depth, tick density). Minimum history: prefer several active days before changing parameters.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-[560px] overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Week (Mon → Sun)</TableHead>
                        <TableHead className="text-right">Days</TableHead>
                        <TableHead className="text-right">Trades</TableHead>
                        <TableHead className="text-right">Win %</TableHead>
                        <TableHead className="text-right">Net ₹</TableHead>
                        <TableHead className="text-right">Max DD ₹</TableHead>
                        <TableHead className="text-right text-xs">CE/PE ticks</TableHead>
                        <TableHead className="text-right text-[10px]" title="Decay/sideways pause rows in week window">
                          Pauses
                        </TableHead>
                        <TableHead className="text-xs min-w-[280px]">Expert review</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {weeklyReportsLoading ? (
                        <TableRow>
                          <TableCell colSpan={9} className="text-muted-foreground">
                            Loading…
                          </TableCell>
                        </TableRow>
                      ) : weeklyReports.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={9} className="text-muted-foreground">
                            No weekly rows yet. Apply migration <code className="text-xs">martingale_weekly_reports</code>, deploy the edge
                            function, then use <strong>Run week &amp; save</strong> above.
                          </TableCell>
                        </TableRow>
                      ) : (
                        weeklyReports.map((wr) => {
                          const summary = wr.report?.summary as
                            | {
                                distinct_trading_days?: number;
                                trade_count_closed?: number;
                                win_rate_pct?: number;
                                net_pnl_inr?: number;
                                max_drawdown_inr?: number;
                                premium_tick_snapshots?: number;
                              }
                            | undefined;
                          const expert = wr.report?.expert_review as string[] | undefined;
                          const excerpt = expert?.length ? expert.slice(0, 3).join(" · ") : "—";
                          const pw = wr.report?.pause_gate_summary as
                            | {
                                count?: number;
                                avg_nifty_range_pts?: number | null;
                                avg_ce_drop_pct?: number | null;
                                avg_pe_drop_pct?: number | null;
                              }
                            | undefined;
                          const pauseWeekLabel =
                            pw?.count != null && pw.count > 0 ? `${pw.count} · rng ${pw.avg_nifty_range_pts ?? "—"}` : "—";
                          const pauseWeekTitle =
                            pw?.count != null && pw.count > 0
                              ? `${pw.count} pause(s): avg rng ${pw.avg_nifty_range_pts ?? "—"} pts; CE↓${pw.avg_ce_drop_pct ?? "—"}% PE↓${pw.avg_pe_drop_pct ?? "—"}%`
                              : undefined;
                          return (
                            <TableRow key={wr.id}>
                              <TableCell className="font-medium text-xs whitespace-nowrap">
                                {wr.week_start} → {wr.week_end}
                              </TableCell>
                              <TableCell className="text-right">{summary?.distinct_trading_days ?? "—"}</TableCell>
                              <TableCell className="text-right">{summary?.trade_count_closed ?? "—"}</TableCell>
                              <TableCell className="text-right">
                                {summary?.win_rate_pct != null ? `${Number(summary.win_rate_pct).toFixed(1)}%` : "—"}
                              </TableCell>
                              <TableCell className={`text-right font-mono text-xs ${(summary?.net_pnl_inr ?? 0) < 0 ? "text-loss" : ""}`}>
                                {summary?.net_pnl_inr != null ? Number(summary.net_pnl_inr).toFixed(0) : "—"}
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs">
                                {summary?.max_drawdown_inr != null ? Number(summary.max_drawdown_inr).toFixed(0) : "—"}
                              </TableCell>
                              <TableCell className="text-right text-xs">{summary?.premium_tick_snapshots ?? "—"}</TableCell>
                              <TableCell className="text-right text-[10px] font-mono text-muted-foreground" title={pauseWeekTitle}>
                                {pauseWeekLabel}
                              </TableCell>
                              <TableCell className="text-[11px] text-muted-foreground align-top max-w-xl" title={expert?.join("\n")}>
                                {excerpt}
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default MartingaleAnalytics;
