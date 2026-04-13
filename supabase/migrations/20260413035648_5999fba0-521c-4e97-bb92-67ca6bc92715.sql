ALTER TABLE public.martingale_sessions ADD COLUMN IF NOT EXISTS anchor_otm_ce_premium numeric NULL;
ALTER TABLE public.martingale_sessions ADD COLUMN IF NOT EXISTS anchor_otm_pe_premium numeric NULL;