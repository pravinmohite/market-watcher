CREATE UNIQUE INDEX IF NOT EXISTS martingale_sessions_one_active_session_idx
ON public.martingale_sessions ((status))
WHERE status = 'active';

CREATE OR REPLACE FUNCTION public.invoke_martingale_sniper_cron_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $fn$
DECLARE
  strat text;
  base_url text;
  api_key text;
  req_id bigint;
BEGIN
  SELECT lower(trim(value)) INTO strat FROM public.bot_settings WHERE key = 'strategy_mode' LIMIT 1;
  IF strat IS DISTINCT FROM 'sniper' THEN
    INSERT INTO public.bot_settings (key, value, updated_at)
    VALUES ('last_sniper_cron_noop_at', 'strategy_mode=' || COALESCE(strat, 'null') || ' at ' || now()::text, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
    RETURN;
  END IF;

  SELECT decrypted_secret INTO base_url FROM vault.decrypted_secrets WHERE name = 'martingale_project_url' LIMIT 1;
  IF base_url IS NULL THEN
    SELECT value INTO base_url FROM public.bot_settings WHERE key = 'martingale_project_url' LIMIT 1;
  END IF;

  SELECT decrypted_secret INTO api_key FROM vault.decrypted_secrets WHERE name = 'martingale_publishable_key' LIMIT 1;
  IF api_key IS NULL THEN
    SELECT value INTO api_key FROM public.bot_settings WHERE key = 'martingale_cron_publishable_key' LIMIT 1;
  END IF;

  IF base_url IS NULL OR api_key IS NULL OR length(trim(api_key)) < 20 THEN
    INSERT INTO public.bot_settings (key, value, updated_at)
    VALUES ('last_sniper_cron_noop_at', 'missing url/key at ' || now()::text, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
    RAISE WARNING 'sniper cron: missing API key/url in bot_settings';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := rtrim(base_url, '/') || '/functions/v1/martingale-bot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || api_key,
      'apikey', api_key
    ),
    body := '{"action":"cron-tick","source":"pg_cron"}'::jsonb,
    timeout_milliseconds := 55000
  ) INTO req_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.invoke_martingale_general_cron_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $fn$
DECLARE
  strat text;
  base_url text;
  api_key text;
  req_id bigint;
BEGIN
  SELECT lower(trim(value)) INTO strat FROM public.bot_settings WHERE key = 'strategy_mode' LIMIT 1;
  IF strat = 'sniper' THEN
    INSERT INTO public.bot_settings (key, value, updated_at)
    VALUES ('last_martingale_cron_noop_at', 'strategy_mode=sniper at ' || now()::text, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
    RETURN;
  END IF;

  SELECT decrypted_secret INTO base_url FROM vault.decrypted_secrets WHERE name = 'martingale_project_url' LIMIT 1;
  IF base_url IS NULL THEN
    SELECT value INTO base_url FROM public.bot_settings WHERE key = 'martingale_project_url' LIMIT 1;
  END IF;

  SELECT decrypted_secret INTO api_key FROM vault.decrypted_secrets WHERE name = 'martingale_publishable_key' LIMIT 1;
  IF api_key IS NULL THEN
    SELECT value INTO api_key FROM public.bot_settings WHERE key = 'martingale_cron_publishable_key' LIMIT 1;
  END IF;

  IF base_url IS NULL OR api_key IS NULL OR length(trim(api_key)) < 20 THEN
    INSERT INTO public.bot_settings (key, value, updated_at)
    VALUES ('last_martingale_cron_noop_at', 'missing url/key at ' || now()::text, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
    RAISE WARNING 'martingale cron: missing API key/url in bot_settings';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := rtrim(base_url, '/') || '/functions/v1/martingale-bot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || api_key,
      'apikey', api_key
    ),
    body := '{"action":"cron-tick","source":"pg_cron"}'::jsonb,
    timeout_milliseconds := 55000
  ) INTO req_id;
END;
$fn$;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'martingale-tick-15s') THEN
    PERFORM cron.unschedule('martingale-tick-15s');
  END IF;

  PERFORM cron.schedule(
    'martingale-tick-15s',
    '* * * * *',
    $job$SELECT public.invoke_martingale_general_cron_tick();$job$
  );
END;
$do$;