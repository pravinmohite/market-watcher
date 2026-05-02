-- Time-series of OTM CE/PE premiums (+ open leg mark) during active positions for decay / expansion analysis

CREATE TABLE public.martingale_premium_ticks (
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

CREATE INDEX idx_martingale_premium_ticks_trade_recorded
  ON public.martingale_premium_ticks (trade_id, recorded_at DESC);

CREATE INDEX idx_martingale_premium_ticks_session_recorded
  ON public.martingale_premium_ticks (session_id, recorded_at DESC);

COMMENT ON TABLE public.martingale_premium_ticks IS 'Snapshots of OTM CE/PE chain premiums while a trade is open (~15s throttle server-side).';

ALTER TABLE public.martingale_premium_ticks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read martingale premium ticks"
  ON public.martingale_premium_ticks FOR SELECT USING (true);
