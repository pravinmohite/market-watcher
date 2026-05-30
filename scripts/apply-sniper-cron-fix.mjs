#!/usr/bin/env node
/**
 * Apply sniper cron fix via REST (bot_settings) — no SQL Editor paste required.
 * Still run `supabase db push` for migrations (strategy_mode column, pg_cron job).
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

function loadEnv() {
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '')) {
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
const url = (env.VITE_SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/$/, '');
const key =
  env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  env.VITE_SUPABASE_ANON_KEY ||
  env.SUPABASE_PUBLISHABLE_KEY ||
  env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env');
  process.exit(1);
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=merge-duplicates',
};

async function upsertSetting(settingKey, value) {
  const r = await fetch(`${url}/rest/v1/bot_settings?on_conflict=key`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ key: settingKey, value, updated_at: new Date().toISOString() }),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`upsert ${settingKey}: ${r.status} ${text}`);
  }
  console.log(`  ✓ ${settingKey}`);
}

console.log('\n=== Applying sniper cron bot_settings ===\n');
console.log(`Project: ${url}\n`);

await upsertSetting('martingale_cron_publishable_key', key);
await upsertSetting('martingale_project_url', url);
await upsertSetting('strategy_mode', 'sniper');

const verify = await fetch(
  `${url}/rest/v1/bot_settings?select=key,value&key=in.('martingale_cron_publishable_key','martingale_project_url','strategy_mode')`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } },
);
const rows = await verify.json();
const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
const ok =
  map.strategy_mode === 'sniper' &&
  (map.martingale_cron_publishable_key || '').length >= 20 &&
  (map.martingale_project_url || '').includes('supabase.co');

console.log('\nVerify:');
console.log(`  strategy_mode: ${map.strategy_mode}`);
console.log(`  cron key: ${map.martingale_cron_publishable_key ? map.martingale_cron_publishable_key.length + ' chars' : 'MISSING'}`);
console.log(`  project url: ${map.martingale_project_url ? 'set' : 'MISSING'}`);

if (!ok) {
  console.error('\nVerification failed.');
  process.exit(1);
}

console.log('\n✓ bot_settings updated. pg_cron still needs migrations (supabase db push).');
console.log('  Then: supabase functions deploy martingale-bot\n');
