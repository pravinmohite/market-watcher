
-- Apply missing martingale_trades analytics columns
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

CREATE INDEX IF NOT EXISTS idx_martingale_trades_closed_exit_time
  ON public.martingale_trades (exit_time DESC)
  WHERE status = 'closed';

-- Daily reports table (also referenced in code)
CREATE TABLE IF NOT EXISTS public.martingale_daily_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trading_day date NOT NULL UNIQUE,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.martingale_daily_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read martingale daily reports" ON public.martingale_daily_reports;
CREATE POLICY "Anyone can read martingale daily reports"
  ON public.martingale_daily_reports FOR SELECT USING (true);

-- Weekly reports table
CREATE TABLE IF NOT EXISTS public.martingale_weekly_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start date NOT NULL,
  week_end date NOT NULL,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(week_start, week_end)
);
ALTER TABLE public.martingale_weekly_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read martingale weekly reports" ON public.martingale_weekly_reports;
CREATE POLICY "Anyone can read martingale weekly reports"
  ON public.martingale_weekly_reports FOR SELECT USING (true);

-- Premium ticks time-series
CREATE TABLE IF NOT EXISTS public.martingale_premium_ticks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.martingale_sessions(id) ON DELETE CASCADE,
  trade_id uuid NOT NULL REFERENCES public.martingale_trades(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  nifty_spot numeric NOT NULL,
  otm_ce_strike numeric,
  otm_pe_strike numeric,
  otm_ce_premium numeric,
  otm_pe_premium numeric,
  active_option_type text NOT NULL,
  active_strike numeric NOT NULL,
  active_premium numeric NOT NULL,
  tick_source text NOT NULL DEFAULT 'tick'
);
CREATE INDEX IF NOT EXISTS idx_martingale_premium_ticks_trade_recorded
  ON public.martingale_premium_ticks (trade_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_martingale_premium_ticks_session_recorded
  ON public.martingale_premium_ticks (session_id, recorded_at DESC);
ALTER TABLE public.martingale_premium_ticks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read martingale premium ticks" ON public.martingale_premium_ticks;
CREATE POLICY "Anyone can read martingale premium ticks"
  ON public.martingale_premium_ticks FOR SELECT USING (true);

-- session premium anchors (in case earlier migration also missing)
ALTER TABLE public.martingale_sessions
  ADD COLUMN IF NOT EXISTS anchor_otm_ce_premium numeric,
  ADD COLUMN IF NOT EXISTS anchor_otm_pe_premium numeric,
  ADD COLUMN IF NOT EXISTS last_tick_at timestamptz;
