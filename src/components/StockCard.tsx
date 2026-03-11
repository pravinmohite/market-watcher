import { TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface StockCardProps {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  open: number;
  iv?: number;
  ivPercentile?: number;
}

const StockCard = ({ symbol, name, price, changePercent, open, iv, ivPercentile }: StockCardProps) => {
  const isUp = changePercent >= 0;
  const isAlert = Math.abs(changePercent) >= 1;

  return (
    <div className={cn(
      "rounded-xl border p-4 transition-all duration-300 hover:scale-[1.02]",
      "bg-card border-border",
      isAlert && isUp && "border-gain/40 shadow-[0_0_20px_-5px_hsl(var(--gain)/0.2)]",
      isAlert && !isUp && "border-loss/40 shadow-[0_0_20px_-5px_hsl(var(--loss)/0.2)]",
    )}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-xs text-muted-foreground font-mono">{symbol}</p>
          <p className="text-sm font-semibold text-foreground truncate max-w-[140px]">{name}</p>
        </div>
        <div className={cn(
          "flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold",
          isUp ? "bg-gain/15 text-gain" : "bg-loss/15 text-loss"
        )}>
          {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {isUp ? "+" : ""}{changePercent.toFixed(2)}%
        </div>
      </div>
      <div className="space-y-1">
        <div className="flex justify-between items-baseline">
          <span className="text-xs text-muted-foreground">Current</span>
          <span className={cn("text-lg font-mono font-bold", isUp ? "text-gain" : "text-loss")}>
            ₹{price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div className="flex justify-between items-baseline">
          <span className="text-xs text-muted-foreground">Prev Close</span>
          <span className="text-sm font-mono text-muted-foreground">
            ₹{open.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        {iv !== undefined && (
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-muted-foreground">ATM IV</span>
            <span className="text-sm font-mono text-foreground">{iv.toFixed(1)}%</span>
          </div>
        )}
        {ivPercentile !== undefined && (
          <div className="flex justify-between items-center">
            <span className="text-xs text-muted-foreground">IV Percentile</span>
            <span className={cn(
              "text-sm font-bold font-mono px-2 py-0.5 rounded",
              ivPercentile >= 80 ? "bg-loss/15 text-loss" :
              ivPercentile <= 20 ? "bg-gain/15 text-gain" :
              "bg-muted text-foreground"
            )}>
              {ivPercentile.toFixed(0)}
            </span>
          </div>
        )}
      </div>
      {isAlert && (
        <div className={cn(
          "mt-3 text-center text-xs font-semibold py-1 rounded-md",
          isUp ? "bg-gain/10 text-gain" : "bg-loss/10 text-loss"
        )}>
          ⚡ ALERT TRIGGERED
        </div>
      )}
    </div>
  );
};

export default StockCard;
