#!/usr/bin/env node
/**
 * One-time: store publishable key in Supabase Vault for pg_cron → martingale-bot.
 * Run from market-watcher/: node scripts/setup-sniper-cron-vault.mjs
 *
 * Requires .env with VITE_SUPABASE_PUBLISHABLE_KEY (and optional VITE_SUPABASE_URL).
 * Paste the printed SQL into Supabase Dashboard → SQL Editor → Run.
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
  const text = readFileSync(envPath, 'utf8');
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
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

const escaped = key.replace(/'/g, "''");

console.log(`
-- Run once in Supabase SQL Editor (project: ${url})

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'martingale_publishable_key') THEN
    PERFORM vault.create_secret(
      '${escaped}',
      'martingale_publishable_key',
      'Publishable/anon key for martingale-bot cron (verify_jwt=false)'
    );
  ELSE
    RAISE NOTICE 'martingale_publishable_key already exists — update it in Dashboard → Database → Vault if needed';
  END IF;
END $$;

-- Verify cron job exists:
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'martingale-sniper-morning-tick';

-- Optional: test invoke (only when strategy_mode = sniper in bot_settings):
SELECT public.invoke_martingale_sniper_cron_tick();
`);
