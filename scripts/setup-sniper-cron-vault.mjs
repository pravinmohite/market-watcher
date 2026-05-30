#!/usr/bin/env node
/**
 * One-time: enable pg_cron → martingale-bot for unattended sniper auto-start (9:35–11:00 IST).
 *
 * 1. Apply migrations: supabase db push (includes 20260521100000 + 20260530120000 + strategy_mode)
 * 2. Run: node scripts/setup-sniper-cron-vault.mjs
 * 3. Paste ALL SQL below into Supabase Dashboard → SQL Editor → Run
 * 4. Deploy edge function: supabase functions deploy martingale-bot
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

function loadEnv() {
  if (!existsSync(envPath)) {
    console.error('Missing .env — copy .env.example and set VITE_SUPABASE_PUBLISHABLE_KEY');
    process.exit(1);
  }
  const raw = readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = loadEnv();
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;
const url = (env.VITE_SUPABASE_URL || 'https://wrgwbzbmqphnjwalodsd.supabase.co').replace(/\/$/, '');

if (!key || key.includes('not-configured') || key.includes('your-')) {
  console.error('Set VITE_SUPABASE_PUBLISHABLE_KEY in .env first.');
  process.exit(1);
}

const escapedKey = key.replace(/'/g, "''");
const escapedUrl = url.replace(/'/g, "''");

console.log(`
-- ========== Sniper cron setup (run entire block in Supabase SQL Editor) ==========
-- Project: ${url}

-- A) bot_settings fallback (used if Vault key missing)
INSERT INTO public.bot_settings (key, value, updated_at)
VALUES ('martingale_cron_publishable_key', '${escapedKey}', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

INSERT INTO public.bot_settings (key, value, updated_at)
VALUES ('martingale_project_url', '${escapedUrl}', now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- B) Vault (preferred)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'martingale_project_url') THEN
    PERFORM vault.create_secret('${escapedUrl}', 'martingale_project_url', 'Sniper cron project URL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'martingale_publishable_key') THEN
    PERFORM vault.create_secret('${escapedKey}', 'martingale_publishable_key', 'Sniper cron API key');
  END IF;
END $$;

-- C) Ensure strategy is sniper
INSERT INTO public.bot_settings (key, value, updated_at)
VALUES ('strategy_mode', 'sniper', now())
ON CONFLICT (key) DO UPDATE SET value = 'sniper', updated_at = now();

-- D) Verify cron job (re-created by migration 20260530120000)
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'martingale-sniper-morning-tick';

-- E) Test invoke now (only starts if inside 9:35–11:00 IST + market day)
SELECT public.invoke_martingale_sniper_cron_tick();

-- F) Check recent sessions
SELECT id, status, max_rounds, created_at FROM martingale_sessions
ORDER BY created_at DESC LIMIT 5;
`);
