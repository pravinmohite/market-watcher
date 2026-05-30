-- Idempotent: ensure sniper cron function + job + project URL fallback exist.
-- Cron API key: set via node scripts/diagnose-sniper-autostart.mjs --apply-cron-fix

-- strategy_mode on sessions (if prior migration not applied)
ALTER TABLE public.martingale_sessions
  ADD COLUMN IF NOT EXISTS strategy_mode text NOT NULL DEFAULT 'martingale';

ALTER TABLE public.martingale_sessions
  DROP CONSTRAINT IF EXISTS martingale_sessions_strategy_mode_check;

ALTER TABLE public.martingale_sessions
  ADD CONSTRAINT martingale_sessions_strategy_mode_check
  CHECK (strategy_mode IN ('martingale', 'sniper'));

COMMENT ON COLUMN public.martingale_sessions.strategy_mode IS
  'sniper = 9:35–11:00 max R2; martingale = multi-round windows';

-- Reuse latest cron tick function (bot_settings + Vault fallback)
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

  IF base_url IS NULL THEN
    SELECT value INTO base_url FROM public.bot_settings WHERE key = 'martingale_project_url' LIMIT 1;
  END IF;

  SELECT decrypted_secret INTO api_key
  FROM vault.decrypted_secrets
  WHERE name = 'martingale_publishable_key'
  LIMIT 1;

  IF api_key IS NULL THEN
    SELECT value INTO api_key FROM public.bot_settings WHERE key = 'martingale_cron_publishable_key' LIMIT 1;
  END IF;

  IF base_url IS NULL OR api_key IS NULL OR length(trim(api_key)) < 20 THEN
    RAISE WARNING 'sniper cron: set bot_settings martingale_cron_publishable_key (diagnose --apply-cron-fix)';
    RETURN;
  END IF;

  SELECT net.http_post(
    url := rtrim(base_url, '/') || '/functions/v1/martingale-bot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || api_key,
      'apikey', api_key
    ),
    body := '{"action":"cron-tick","source":"pg_cron"}'::jsonb
  ) INTO req_id;
END;
$$;

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

INSERT INTO public.bot_settings (key, value, updated_at)
VALUES ('martingale_project_url', 'https://wrgwbzbmqphnjwalodsd.supabase.co', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

INSERT INTO public.bot_settings (key, value, updated_at)
VALUES ('strategy_mode', 'sniper', now())
ON CONFLICT (key) DO UPDATE SET value = 'sniper', updated_at = now();
