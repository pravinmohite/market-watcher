CREATE OR REPLACE FUNCTION public.invoke_martingale_sniper_cron_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  strat text;
  base_url text;
  api_key text;
  req_id bigint;
BEGIN
  SELECT lower(trim(value)) INTO strat FROM public.bot_settings WHERE key = 'strategy_mode' LIMIT 1;
  IF strat IS DISTINCT FROM 'sniper' THEN
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
$function$;