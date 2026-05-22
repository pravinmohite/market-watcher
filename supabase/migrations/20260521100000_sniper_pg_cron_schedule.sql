-- Unattended sniper bot: pg_cron invokes martingale-bot cron-tick every minute during
-- 9:30–11:29 IST (UTC hours 4–5, Mon–Fri). Edge function gates actual start to 9:35–11:00.
-- Only runs when bot_settings.strategy_mode = 'sniper'.
--
-- One-time after migrate: add Vault secret for your publishable/anon key (see scripts/setup-sniper-cron-vault.mjs)

CREATE OR REPLACE FUNCTION public.invoke_martingale_sniper_cron_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
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

  SELECT decrypted_secret INTO base_url
  FROM vault.decrypted_secrets
  WHERE name = 'martingale_project_url'
  LIMIT 1;

  SELECT decrypted_secret INTO api_key
  FROM vault.decrypted_secrets
  WHERE name = 'martingale_publishable_key'
  LIMIT 1;

  IF base_url IS NULL OR api_key IS NULL THEN
    RAISE WARNING 'martingale sniper cron: missing vault secrets martingale_project_url / martingale_publishable_key';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := rtrim(base_url, '/') || '/functions/v1/martingale-bot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || api_key,
      'apikey', api_key
    ),
    body := '{"action":"cron-tick"}'::jsonb
  ) INTO req_id;
END;
$$;

COMMENT ON FUNCTION public.invoke_martingale_sniper_cron_tick() IS
  'POST martingale-bot cron-tick when strategy_mode=sniper (requires Vault URL + publishable key).';

-- Idempotent reschedule
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'martingale-sniper-morning-tick') THEN
    PERFORM cron.unschedule('martingale-sniper-morning-tick');
  END IF;
END $$;

SELECT cron.schedule(
  'martingale-sniper-morning-tick',
  '*/1 4-5 * * 1-5',
  $$SELECT public.invoke_martingale_sniper_cron_tick();$$
);

-- Default project URL in Vault (public). Publishable key: run scripts/setup-sniper-cron-vault.mjs once.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'martingale_project_url') THEN
    PERFORM vault.create_secret(
      'https://wrgwbzbmqphnjwalodsd.supabase.co',
      'martingale_project_url',
      'Supabase project URL for martingale-bot cron'
    );
  END IF;
END $$;
