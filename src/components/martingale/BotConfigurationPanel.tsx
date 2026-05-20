import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Settings2 } from "lucide-react";
import type { BotSettingsMap } from "@/lib/bot-settings";

type Props = {
  settings: BotSettingsMap;
  disabled?: boolean;
  isUpstoxConnected?: boolean;
  onTradingModeChange: (mode: "paper" | "actual") => void;
  onStrategyChange: (mode: "martingale" | "sniper") => void;
  onMaxRoundsChange: (n: number) => void;
  onProfitTargetChange: (pct: number) => void;
  onStopLossChange: (pct: number) => void;
  onDailyLossLimitChange: (inr: number) => void;
  onSniperSessionCapChange: (inr: number) => void;
  onSniperDailyLossChange: (inr: number) => void;
};

const PROFIT_OPTIONS = [1.5, 2, 2.5, 3, 3.5, 4];
const STOP_OPTIONS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const DAILY_LOSS_OPTIONS = [3000, 5000, 8000, 10000, 12000, 15000, 20000, 25000, 30000];
const SNIPER_SESSION_CAP_OPTIONS = [800, 1000, 1200, 1500, 2000, 2500];

export function BotConfigurationPanel({
  settings,
  disabled,
  isUpstoxConnected,
  onTradingModeChange,
  onStrategyChange,
  onMaxRoundsChange,
  onProfitTargetChange,
  onStopLossChange,
  onDailyLossLimitChange,
  onSniperSessionCapChange,
  onSniperDailyLossChange,
}: Props) {
  const isSniper = settings.strategy_mode === "sniper";

  return (
    <section className="rounded-xl border border-border bg-card p-3 md:p-5">
      <h2 className="text-sm md:text-base font-semibold text-foreground mb-3 flex items-center gap-2">
        <Settings2 className="w-4 h-4 text-primary" />
        Bot configuration
        {disabled && (
          <span className="text-[10px] font-normal text-muted-foreground">(stop bot to edit)</span>
        )}
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
        <ConfigField label="Strategy">
          <Select
            value={settings.strategy_mode}
            onValueChange={(v) => onStrategyChange(v as "martingale" | "sniper")}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sniper">Sniper daily (R1→R2)</SelectItem>
              <SelectItem value="martingale">Martingale (multi-round)</SelectItem>
            </SelectContent>
          </Select>
        </ConfigField>

        <ConfigField label="Trading mode">
          <div className="flex items-center gap-2 h-8">
            <span className={cn("text-xs", settings.trading_mode === "paper" ? "text-foreground font-medium" : "text-muted-foreground")}>
              Paper
            </span>
            <Switch
              checked={settings.trading_mode === "actual"}
              disabled={disabled}
              onCheckedChange={(checked) => onTradingModeChange(checked ? "actual" : "paper")}
            />
            <span className={cn("text-xs", settings.trading_mode === "actual" ? "text-loss font-medium" : "text-muted-foreground")}>
              Actual
            </span>
            {settings.trading_mode === "actual" && !isUpstoxConnected && (
              <span className="text-[10px] text-warning">Connect Upstox</span>
            )}
          </div>
        </ConfigField>

        {!isSniper && (
          <ConfigField label="Max martingale rounds">
            <Select
              value={String(settings.max_rounds)}
              onValueChange={(v) => onMaxRoundsChange(Number(v))}
              disabled={disabled}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ConfigField>
        )}

        <ConfigField label="Take profit (% premium)">
          <Select
            value={String(settings.profit_target_pct)}
            onValueChange={(v) => onProfitTargetChange(Number(v))}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROFIT_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  +{n}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ConfigField>

        <ConfigField label="Stop loss (% premium)">
          <Select
            value={String(settings.stop_loss_pct)}
            onValueChange={(v) => onStopLossChange(Number(v))}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STOP_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  -{n}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ConfigField>

        {!isSniper && (
          <ConfigField label="Daily loss limit (₹)">
            <Select
              value={String(settings.daily_loss_limit)}
              onValueChange={(v) => onDailyLossLimitChange(Number(v))}
              disabled={disabled}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAILY_LOSS_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    ₹{(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ConfigField>
        )}

        {isSniper && (
          <>
            <ConfigField label="Sniper session loss cap (₹)">
              <Select
                value={String(settings.sniper_session_loss_cap)}
                onValueChange={(v) => onSniperSessionCapChange(Number(v))}
                disabled={disabled}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SNIPER_SESSION_CAP_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      ₹{n.toLocaleString("en-IN")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ConfigField>

            <ConfigField label="Sniper daily loss cap (₹)">
              <Select
                value={String(settings.sniper_daily_loss_limit)}
                onValueChange={(v) => onSniperDailyLossChange(Number(v))}
                disabled={disabled}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAILY_LOSS_OPTIONS.filter((n) => n <= 15000).map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      ₹{(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ConfigField>

            <div className="sm:col-span-2 lg:col-span-3 text-[11px] text-muted-foreground border-t border-border/60 pt-2">
              Sniper: one session per day · 9:35–11:00 IST · max R2 · R2 only if R1 stops out and trend is sideways ·
              no up+CE · no afternoon trades.
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function ConfigField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] md:text-xs text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}
