import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { TrendingUp, TrendingDown, Bell } from "lucide-react";
import { cn } from "@/lib/utils";

const AlertHistory = () => {
  const { data: alerts, isLoading } = useQuery({
    queryKey: ["stock-alerts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_alerts")
        .select("*")
        .order("alerted_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (!alerts?.length) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Bell className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm">No alerts yet</p>
        <p className="text-xs mt-1">Alerts appear when stocks move ≥1%</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {alerts.map((alert) => {
        const isUp = alert.direction === "up";
        return (
          <div
            key={alert.id}
            className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border border-border"
          >
            <div className="flex items-center gap-3">
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center",
                isUp ? "bg-gain/15" : "bg-loss/15"
              )}>
                {isUp ? (
                  <TrendingUp className="w-4 h-4 text-gain" />
                ) : (
                  <TrendingDown className="w-4 h-4 text-loss" />
                )}
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{alert.symbol}</p>
                <p className="text-xs text-muted-foreground">{alert.name}</p>
              </div>
            </div>
            <div className="text-right">
              <p className={cn("text-sm font-mono font-bold", isUp ? "text-gain" : "text-loss")}>
                {isUp ? "+" : ""}{Number(alert.change_percent).toFixed(2)}%
              </p>
              <p className="text-xs text-muted-foreground">
                {new Date(alert.alerted_at).toLocaleString('en-IN', {
                  timeZone: 'Asia/Kolkata',
                  hour: '2-digit',
                  minute: '2-digit',
                  day: '2-digit',
                  month: 'short'
                })}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default AlertHistory;
