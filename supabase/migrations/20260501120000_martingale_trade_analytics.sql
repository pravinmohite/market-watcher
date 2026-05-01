-- Structured logging & daily self-improvement metrics for martingale trades

ALTER TABLE public.martingale_trades
  ADD COLUMN IF NOT EXISTS symbol text NOT NULL DEFAULT 'NIFTY',
  ADD COLUMN IF NOT EXISTS target_pct numeric,
  ADD COLUMN IF NOT EXISTS stop_loss_pct numeric,
  ADD COLUMN IF NOT EXISTS position_qty int,
  ADD COLUMN IF NOT EXISTS pnl_pct numeric,
  ADD COLUMN IF NOT EXISTS trade_result text,
  ADD COLUMN IF NOT EXISTS streak_wins_before int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS streak_losses_before int DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trade_log jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.martingale_trades.trade_log IS 'Structured entry/exit context (JSON): entry market snapshot, streaks, exit reason, etc.';

CREATE INDEX IF NOT EXISTS idx_martingale_trades_closed_exit_time
  ON public.martingale_trades (exit_time DESC)
  WHERE status = 'closed';

CREATE TABLE IF NOT EXISTS public.martingale_daily_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trading_day date NOT NULL UNIQUE,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.martingale_daily_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read martingale daily reports"
  ON public.martingale_daily_reports FOR SELECT USING (true);
