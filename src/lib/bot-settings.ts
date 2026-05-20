import { supabase } from "@/integrations/supabase/client";

export const BOT_SETTING_KEYS = {
  trading_mode: "trading_mode",
  strategy_mode: "strategy_mode",
  max_rounds: "max_rounds",
  profit_target_pct: "profit_target_pct",
  stop_loss_pct: "stop_loss_pct",
  daily_loss_limit: "daily_loss_limit",
  sniper_session_loss_cap: "sniper_session_loss_cap",
  sniper_daily_loss_limit: "sniper_daily_loss_limit",
} as const;

/** Defaults used when DB has no value yet (also seeded by bot edge function). */
export const DEFAULT_PROFIT_TARGET_PCT = 2.5;
export const DEFAULT_STOP_LOSS_PCT = 1.5;
export const DEFAULT_MAX_ROUNDS = 5;
export const DEFAULT_DAILY_LOSS_LIMIT = 12000;
export const DEFAULT_SNIPER_SESSION_LOSS_CAP = 1200;
export const DEFAULT_SNIPER_DAILY_LOSS_LIMIT = 3000;

export type BotSettingsMap = {
  trading_mode: "paper" | "actual";
  strategy_mode: "martingale" | "sniper";
  max_rounds: number;
  profit_target_pct: number;
  stop_loss_pct: number;
  daily_loss_limit: number;
  sniper_session_loss_cap: number;
  sniper_daily_loss_limit: number;
};

export function parseBotSettings(rows: { key: string; value: string }[] | null | undefined): BotSettingsMap {
  const map = Object.fromEntries((rows ?? []).map((s) => [s.key, s.value]));
  const num = (k: string, fallback: number) => {
    const v = parseFloat(map[k] ?? "");
    return !Number.isNaN(v) && v > 0 ? v : fallback;
  };
  return {
    trading_mode: map.trading_mode === "actual" ? "actual" : "paper",
    strategy_mode: map.strategy_mode === "martingale" ? "martingale" : "sniper",
    max_rounds: Math.min(10, Math.max(1, Math.round(num(BOT_SETTING_KEYS.max_rounds, DEFAULT_MAX_ROUNDS)))),
    profit_target_pct: num(BOT_SETTING_KEYS.profit_target_pct, DEFAULT_PROFIT_TARGET_PCT),
    stop_loss_pct: num(BOT_SETTING_KEYS.stop_loss_pct, DEFAULT_STOP_LOSS_PCT),
    daily_loss_limit: Math.round(num(BOT_SETTING_KEYS.daily_loss_limit, DEFAULT_DAILY_LOSS_LIMIT)),
    sniper_session_loss_cap: Math.round(
      num(BOT_SETTING_KEYS.sniper_session_loss_cap, DEFAULT_SNIPER_SESSION_LOSS_CAP),
    ),
    sniper_daily_loss_limit: Math.round(
      num(BOT_SETTING_KEYS.sniper_daily_loss_limit, DEFAULT_SNIPER_DAILY_LOSS_LIMIT),
    ),
  };
}

export async function upsertBotSetting(key: string, value: string): Promise<void> {
  const { error } = await supabase
    .from("bot_settings" as never)
    .upsert({ key, value, updated_at: new Date().toISOString() } as never, { onConflict: "key" });
  if (error) throw error;
}

/** IST minutes since midnight for sniper window checks. */
export function istMinutesNow(): number {
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return ist.getHours() * 60 + ist.getMinutes();
}

export const SNIPER_WINDOW_START_MIN = 9 * 60 + 35;
export const SNIPER_WINDOW_END_MIN = 11 * 60 + 0;

export function sniperInWindowNow(): boolean {
  const m = istMinutesNow();
  return m >= SNIPER_WINDOW_START_MIN && m < SNIPER_WINDOW_END_MIN;
}
