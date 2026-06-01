-- Expose pg_cron job status to REST/RPC for diagnostics (anon can call).
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
    RETURN jsonb_build_object(
      'pg_cron_job_exists', false,
      'error', 'pg_cron not enabled — enable in Database > Extensions, then run push-sniper-migrations.sql'
    );
  WHEN OTHERS THEN
    RETURN jsonb_build_object('pg_cron_job_exists', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_sniper_cron_health() TO anon, authenticated, service_role;
