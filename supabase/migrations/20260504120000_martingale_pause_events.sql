-- Structured log rows when sideways / decay gate triggers a 15m pause (improve analytics & reports).

CREATE TABLE public.martingale_pause_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  trading_day_ist date NOT NULL,
  pause_until timestamptz NOT NULL,
  pause_kind text NOT NULL DEFAULT 'sideways_gate',
  session_id uuid REFERENCES public.martingale_sessions (id) ON DELETE SET NULL,
  reason text,
  nifty_spot double precision,
  nifty_range_pts double precision,
  range_source text,
  anchor_ce_premium double precision,
  anchor_pe_premium double precision,
  otm_ce_at_pause double precision,
  otm_pe_at_pause double precision,
  otm_ce_strike double precision,
  otm_pe_strike double precision,
  ce_drop_pct double precision,
  pe_drop_pct double precision,
  gate_round int,
  gate_eval jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_martingale_pause_events_trading_day_ist
  ON public.martingale_pause_events (trading_day_ist DESC);

CREATE INDEX IF NOT EXISTS idx_martingale_pause_events_recorded_at
  ON public.martingale_pause_events (recorded_at DESC);

COMMENT ON TABLE public.martingale_pause_events IS 'Each row: pause window set by sideways/decay gate or recheck; CE/PE drop % vs anchors when eval available.';

ALTER TABLE public.martingale_pause_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read martingale pause events"
  ON public.martingale_pause_events FOR SELECT USING (true);
