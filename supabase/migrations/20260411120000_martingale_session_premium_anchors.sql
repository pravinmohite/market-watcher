-- OTM CE/PE chain premiums at session start (same snapshot) for double-decay detection at R3+
ALTER TABLE public.martingale_sessions
  ADD COLUMN IF NOT EXISTS anchor_otm_ce_premium numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS anchor_otm_pe_premium numeric DEFAULT NULL;

COMMENT ON COLUMN public.martingale_sessions.anchor_otm_ce_premium IS 'OTM CE premium from option chain when session started (double-decay baseline)';
COMMENT ON COLUMN public.martingale_sessions.anchor_otm_pe_premium IS 'OTM PE premium from option chain when session started (double-decay baseline)';
