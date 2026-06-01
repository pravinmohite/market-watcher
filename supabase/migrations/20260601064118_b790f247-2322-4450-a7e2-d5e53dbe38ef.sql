-- Apply pending migration pieces that aren't yet in the live database.

-- 1) martingale_pause_events (from 20260504120000)
CREATE TABLE IF NOT EXISTS public.martingale_pause_events (
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

GRANT SELECT ON public.martingale_pause_events TO anon, authenticated;
GRANT ALL ON public.martingale_pause_events TO service_role;

CREATE INDEX IF NOT EXISTS idx_martingale_pause_events_trading_day_ist
  ON public.martingale_pause_events (trading_day_ist DESC);
CREATE INDEX IF NOT EXISTS idx_martingale_pause_events_recorded_at
  ON public.martingale_pause_events (recorded_at DESC);

ALTER TABLE public.martingale_pause_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read martingale pause events" ON public.martingale_pause_events;
CREATE POLICY "Anyone can read martingale pause events"
  ON public.martingale_pause_events FOR SELECT USING (true);

-- 2) upstox_tokens extended columns (from 20260530130000)
ALTER TABLE public.upstox_tokens
  ADD COLUMN IF NOT EXISTS extended_token text NULL,
  ADD COLUMN IF NOT EXISTS user_name text NULL,
  ADD COLUMN IF NOT EXISTS user_id text NULL;

-- 3) Sniper cron health RPC (from 20260602120000)
CREATE OR REPLACE FUNCTION public.get_sniper_cron_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, cron
AS $$
DECLARE
  j record;
  key_len int;
BEGIN
  SELECT jobname, schedule, active INTO j
  FROM cron.job
  WHERE jobname = 'martingale-sniper-morning-tick'
  LIMIT 1;

  SELECT length(trim(coalesce(value, ''))) INTO key_len
  FROM public.bot_settings
  WHERE key = 'martingale_cron_publishable_key'
  LIMIT 1;

  RETURN jsonb_build_object(
    'pg_cron_job_exists', j.jobname IS NOT NULL,
    'jobname', j.jobname,
    'schedule', j.schedule,
    'active', COALESCE(j.active, false),
    'cron_key_chars', COALESCE(key_len, 0),
    'strategy_mode', (SELECT value FROM public.bot_settings WHERE key = 'strategy_mode' LIMIT 1),
    'has_strategy_mode_column', EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'martingale_sessions'
        AND column_name = 'strategy_mode'
    ),
    'note', 'If pg_cron_job_exists is false, run scripts/push-sniper-migrations.sql in SQL Editor'
  );
EXCEPTION
  WHEN undefined_table THEN
    RETURN jsonb_build_object('pg_cron_job_exists', false,
      'error', 'pg_cron not enabled — enable in Database > Extensions');
  WHEN OTHERS THEN
    RETURN jsonb_build_object('pg_cron_job_exists', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_sniper_cron_health() TO anon, authenticated, service_role;

-- 4) bot_settings defaults (from 20260520120000)
INSERT INTO public.bot_settings (key, value) VALUES
  ('profit_target_pct', '2.5'),
  ('stop_loss_pct', '1.5'),
  ('sniper_session_loss_cap', '1200'),
  ('sniper_daily_loss_limit', '3000')
ON CONFLICT (key) DO NOTHING;
