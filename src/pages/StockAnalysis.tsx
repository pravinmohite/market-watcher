import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Brain, TrendingUp, TrendingDown, AlertTriangle, ArrowLeft, RefreshCw, Sparkles, Shield, Target, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";

interface Recommendation {
  symbol: string;
  name: string;
  current_price: number;
  target_percent: string;
  confidence: string;
  rationale: string;
  risk: string;
  timeframe: string;
}

interface Analysis {
  market_outlook: string;
  recommendations: Recommendation[];
  avoid: string[];
  sector_insights: string;
  raw_analysis?: string;
}

const StockAnalysis = () => {
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // First fetch stock data
  const { data: stockData } = useQuery({
    queryKey: ["stock-data"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("check-stock-alerts");
      if (error) throw error;
      return data;
    },
    refetchInterval: 60000,
  });

  // Analysis query - manual trigger only
  const { data: analysisData, refetch: runAnalysis, isLoading } = useQuery({
    queryKey: ["stock-analysis"],
    queryFn: async () => {
      // Fetch stock data fresh to avoid stale/missing data issues
      let stocks = stockData?.all_stocks;
      if (!stocks || stocks.length === 0) {
        const { data: freshData, error: freshError } = await supabase.functions.invoke("check-stock-alerts");
        if (freshError) throw freshError;
        stocks = freshData?.all_stocks;
      }
      if (!stocks || stocks.length === 0) throw new Error("No stock data available");
      const { data, error } = await supabase.functions.invoke("analyze-stocks", {
        body: { stocks },
      });
      if (error) throw error;
      if (!data.success) throw new Error(data.error);
      return data as { success: boolean; analysis: Analysis; generated_at: string };
    },
    enabled: false,
  });

  const handleAnalyze = async () => {
    setIsAnalyzing(true);
    try {
      await runAnalysis();
      toast.success("AI analysis complete!");
    } catch {
      toast.error("Failed to analyze stocks");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const analysis = analysisData?.analysis;
  const loading = isAnalyzing || isLoading;

  const confidenceColor = (c: string) => {
    switch (c.toLowerCase()) {
      case "high": return "text-gain bg-gain/15";
      case "medium": return "text-yellow-500 bg-yellow-500/15";
      case "low": return "text-loss bg-loss/15";
      default: return "text-muted-foreground bg-muted";
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border sticky top-0 z-10 bg-background/80 backdrop-blur-xl">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/">
              <Button variant="ghost" size="icon" className="mr-1">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center">
              <Brain className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground tracking-tight">AI Stock Picks</h1>
              <p className="text-xs text-muted-foreground">AI-powered investment ideas from today's movers</p>
            </div>
          </div>
          <Button
            onClick={handleAnalyze}
            disabled={loading}
            className="gap-2"
          >
            {loading ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">{loading ? "Analyzing..." : "Analyze Now"}</span>
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6 max-w-4xl">
        {!analysis && !loading && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mb-6">
              <Brain className="w-10 h-10 text-primary" />
            </div>
            <h2 className="text-xl font-bold text-foreground mb-2">AI Stock Analysis</h2>
            <p className="text-muted-foreground max-w-md mb-6">
              Click "Analyze Now" to let AI analyze today's stock movements and identify potential 3-5% monthly gainers.
            </p>
            <Button onClick={handleAnalyze} size="lg" className="gap-2">
              <Sparkles className="w-5 h-5" />
              Run Analysis
            </Button>
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center justify-center py-20">
            <RefreshCw className="w-10 h-10 text-primary animate-spin mb-4" />
            <p className="text-muted-foreground">AI is analyzing market data...</p>
          </div>
        )}

        {analysis && !loading && (
          <>
            {/* Market Outlook */}
            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2">
                <TrendingUp className="w-4 h-4" />
                Market Outlook
              </h2>
              <p className="text-foreground">{analysis.market_outlook}</p>
              {analysisData?.generated_at && (
                <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  Generated: {new Date(analysisData.generated_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                </p>
              )}
            </div>

            {/* Raw analysis fallback */}
            {analysis.raw_analysis && (
              <div className="rounded-xl border border-border bg-card p-4">
                <pre className="whitespace-pre-wrap text-sm text-foreground">{analysis.raw_analysis}</pre>
              </div>
            )}

            {/* Recommendations */}
            {analysis.recommendations?.length > 0 && (
              <section>
                <h2 className="text-base font-semibold text-foreground mb-4 flex items-center gap-2">
                  <Target className="w-4 h-4 text-primary" />
                  Investment Ideas ({analysis.recommendations.length})
                </h2>
                <div className="space-y-3">
                  {analysis.recommendations.map((rec, i) => (
                    <div key={i} className="rounded-xl border border-border bg-card p-4 hover:border-primary/30 transition-colors">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <p className="text-xs text-muted-foreground font-mono">{rec.symbol}</p>
                          <p className="text-sm font-semibold text-foreground">{rec.name}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={cn("text-xs font-bold px-2 py-1 rounded-md", confidenceColor(rec.confidence))}>
                            {rec.confidence}
                          </span>
                          <span className="text-sm font-bold text-gain bg-gain/10 px-2 py-1 rounded-md">
                            ↑ {rec.target_percent}
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                        <div>
                          <p className="text-xs text-muted-foreground mb-1">Current Price</p>
                          <p className="font-mono font-bold text-foreground">
                            ₹{rec.current_price?.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                            <Clock className="w-3 h-3" /> Timeframe
                          </p>
                          <p className="font-semibold text-foreground">{rec.timeframe}</p>
                        </div>
                      </div>

                      <div className="mt-3 p-3 rounded-lg bg-muted/50">
                        <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                          <Sparkles className="w-3 h-3" /> Rationale
                        </p>
                        <p className="text-sm text-foreground">{rec.rationale}</p>
                      </div>

                      <div className="mt-2 p-3 rounded-lg bg-loss/5 border border-loss/10">
                        <p className="text-xs text-loss mb-1 flex items-center gap-1">
                          <Shield className="w-3 h-3" /> Risk
                        </p>
                        <p className="text-sm text-foreground">{rec.risk}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Stocks to Avoid */}
            {analysis.avoid?.length > 0 && (
              <section>
                <h2 className="text-base font-semibold text-foreground mb-4 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-loss" />
                  Stocks to Avoid
                </h2>
                <div className="rounded-xl border border-loss/20 bg-loss/5 p-4 space-y-2">
                  {analysis.avoid.map((item, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <TrendingDown className="w-4 h-4 text-loss mt-0.5 flex-shrink-0" />
                      <p className="text-sm text-foreground">{item}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Sector Insights */}
            {analysis.sector_insights && (
              <div className="rounded-xl border border-border bg-card p-4">
                <h2 className="text-sm font-semibold text-muted-foreground mb-2">Sector Insights</h2>
                <p className="text-foreground text-sm">{analysis.sector_insights}</p>
              </div>
            )}

            {/* Disclaimer */}
            <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground text-center">
              ⚠️ This is AI-generated analysis for educational purposes only. Not financial advice. Always do your own research before investing.
            </div>
          </>
        )}
      </main>
    </div>
  );
};

export default StockAnalysis;
