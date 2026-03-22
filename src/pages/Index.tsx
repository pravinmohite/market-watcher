import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Activity, Bell, Brain, RefreshCw, Send, TrendingUp, Zap, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import StockCard from "@/components/StockCard";
import AlertHistory from "@/components/AlertHistory";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";

interface StockData {
  symbol: string;
  name: string;
  open: number;
  lastPrice: number;
  changePercent: number;
  iv?: number;
  ivPercentile?: number;
}

const Index = () => {
  const [isChecking, setIsChecking] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["stock-data"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("check-stock-alerts");
      if (error) throw error;
      return data as {
        success: boolean;
        total_stocks: number;
        stocks_above_threshold: number;
        new_alerts_sent: number;
        all_stocks: StockData[];
        alert_stocks: StockData[];
      };
    },
    refetchInterval: 60000,
  });

  const handleManualCheck = async () => {
    setIsChecking(true);
    try {
      await refetch();
      if (data?.new_alerts_sent && data.new_alerts_sent > 0) {
        toast.success(`${data.new_alerts_sent} alert(s) sent to Telegram!`);
      } else {
        toast.info("Checked! No new alerts to send.");
      }
    } catch {
      toast.error("Failed to check stocks");
    } finally {
      setIsChecking(false);
    }
  };

  const allStocks = data?.all_stocks || [];
  const alertStocks = data?.alert_stocks || [];
  const indices = allStocks.filter(s => s.symbol === "NIFTY 50" || s.symbol === "NIFTY BANK");
  const stocks = allStocks.filter(s => s.symbol !== "NIFTY 50" && s.symbol !== "NIFTY BANK");

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border sticky top-0 z-10 bg-background/80 backdrop-blur-xl">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center">
              <Zap className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground tracking-tight">NSE Alert Agent</h1>
              <p className="text-xs text-muted-foreground">Real-time stock movement alerts → Telegram</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/stock-analysis">
              <Button variant="outline" className="gap-2">
                <Brain className="w-4 h-4" />
                <span className="hidden sm:inline">AI Picks</span>
              </Button>
            </Link>
            <Link to="/martingale">
              <Button variant="outline" className="gap-2">
                <Bot className="w-4 h-4" />
                <span className="hidden sm:inline">Martingale Bot</span>
              </Button>
            </Link>
            <Button
              onClick={handleManualCheck}
              disabled={isChecking || isLoading}
              className="gap-2"
            >
              <RefreshCw className={cn("w-4 h-4", (isChecking || isLoading) && "animate-spin")} />
              {isChecking ? "Checking..." : "Check Now"}
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-8">
        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            icon={<Activity className="w-4 h-4" />}
            label="Tracked"
            value={allStocks.length.toString()}
          />
          <StatCard
            icon={<TrendingUp className="w-4 h-4" />}
            label="≥1% Movers"
            value={alertStocks.length.toString()}
            highlight
          />
          <StatCard
            icon={<Send className="w-4 h-4" />}
            label="Alerts Sent"
            value={data?.new_alerts_sent?.toString() || "0"}
          />
          <StatCard
            icon={<Bell className="w-4 h-4" />}
            label="Threshold"
            value="±1%"
          />
        </div>

        {/* Indices */}
        <section>
          <h2 className="text-base font-semibold text-foreground mb-4 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            Indices
          </h2>
          {isLoading ? (
            <div className="grid grid-cols-2 gap-3">
              {[...Array(2)].map((_, i) => (
                <div key={i} className="h-40 rounded-xl bg-muted animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {indices.map((stock) => (
                <StockCard
                  key={stock.symbol}
                  symbol={stock.symbol}
                  name={stock.name}
                  price={stock.lastPrice}
                  changePercent={stock.changePercent}
                  open={stock.open}
                  iv={stock.iv}
                  ivPercentile={stock.ivPercentile}
                />
              ))}
            </div>
          )}
        </section>

        {/* Stocks */}
        <section>
          <h2 className="text-base font-semibold text-foreground mb-4 flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            Top Movers
          </h2>
          {isLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {[...Array(10)].map((_, i) => (
                <div key={i} className="h-40 rounded-xl bg-muted animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {stocks.map((stock) => (
                <StockCard
                  key={stock.symbol}
                  symbol={stock.symbol}
                  name={stock.name}
                  price={stock.lastPrice}
                  changePercent={stock.changePercent}
                  open={stock.open}
                  iv={stock.iv}
                  ivPercentile={stock.ivPercentile}
                />
              ))}
            </div>
          )}
        </section>

        {/* Alert History */}
        <section>
          <h2 className="text-base font-semibold text-foreground mb-4 flex items-center gap-2">
            <Bell className="w-4 h-4 text-warning" />
            Alert History
          </h2>
          <div className="max-w-2xl">
            <AlertHistory />
          </div>
        </section>
      </main>
    </div>
  );
};

const StatCard = ({ icon, label, value, highlight }: { icon: React.ReactNode; label: string; value: string; highlight?: boolean }) => (
  <div className={cn(
    "rounded-xl border p-4 bg-card border-border",
    highlight && "border-primary/30 bg-primary/5"
  )}>
    <div className="flex items-center gap-2 text-muted-foreground mb-1">
      {icon}
      <span className="text-xs">{label}</span>
    </div>
    <p className={cn("text-2xl font-bold font-mono", highlight ? "text-primary" : "text-foreground")}>{value}</p>
  </div>
);

export default Index;
