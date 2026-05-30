#!/usr/bin/env node
/** Pre-flight: will sniper auto-start on next market Monday? */
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
  console.error('Missing VITE_SUPABASE_URL / publishable key in .env');
  process.exit(1);
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
};

async function rest(path) {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers });
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}

async function invoke(fn, body) {
  const r = await fetch(`${url}/functions/v1/${fn}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return r.json();
}

function nextMondayYmd() {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  const add = day === 0 ? 1 : day === 6 ? 2 : day === 1 ? 7 : 8 - day;
  ist.setDate(ist.getDate() + add);
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, '0');
  const d = String(ist.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const checks = [];
function pass(msg) {
  checks.push({ ok: true, msg });
}
function fail(msg) {
  checks.push({ ok: false, msg });
}

console.log('\n=== Sniper Monday auto-start readiness ===\n');
console.log(`Project: ${url}`);
console.log(`Next Monday (IST): ${nextMondayYmd()}\n`);

const settings = await rest('bot_settings?select=key,value');
const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));

if (map.strategy_mode === 'sniper') pass('strategy_mode = sniper');
else fail(`strategy_mode = "${map.strategy_mode ?? 'missing'}" (need sniper)`);

const cronKey = map.martingale_cron_publishable_key || '';
const projUrl = map.martingale_project_url || '';
if (cronKey.length >= 20) pass(`martingale_cron_publishable_key set (${cronKey.length} chars)`);
else fail('martingale_cron_publishable_key missing or too short — run setup-sniper-cron-vault.mjs SQL');

if (projUrl.includes('supabase.co')) pass('martingale_project_url set');
else fail('martingale_project_url missing in bot_settings (Vault may still have it)');

try {
  await rest('martingale_sessions?select=strategy_mode&limit=1');
  pass('DB column martingale_sessions.strategy_mode exists');
} catch {
  fail('Migration 20260522100000 missing — sniper session tracking / start may fail');
}

const status = await invoke('martingale-bot', { action: 'status' });
if (status.strategy_mode === 'sniper') pass('Edge function reports strategy_mode sniper');
else fail(`Edge status strategy_mode = ${status.strategy_mode}`);

const sniper = status.sniper_status || {};
console.log('Sniper status now:', JSON.stringify(sniper, null, 2));

if (map.trading_mode === 'paper') {
  pass('trading_mode = paper (Upstox not required for start)');
} else if (map.trading_mode === 'actual') {
  const tok = await invoke('upstox-auth', { action: 'check-token' });
  if (tok.connected) pass(`Upstox connected until ${tok.valid_until_ist || '?'}`);
  else fail('trading_mode actual but Upstox not connected — reconnect before 9:35 Monday');
}

const cron = await invoke('martingale-bot', { action: 'cron-tick', source: 'readiness-check' });
console.log('\nTest cron-tick response:', cron.message || cron.success);
if (Array.isArray(cron.tick_results) && cron.tick_results.length) {
  console.log('  tick_results:', cron.tick_results.join(' | '));
}

console.log('\n--- Cannot verify from API (run in Supabase SQL Editor) ---');
console.log('  SELECT jobname, schedule, active FROM cron.job');
console.log("    WHERE jobname = 'martingale-sniper-morning-tick';");
console.log('  Expect: active=true, schedule=*/1 4-5 * * 1-5\n');

console.log('--- Result ---\n');
let allOk = true;
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.msg}`);
  if (!c.ok) allOk = false;
}

if (allOk) {
  console.log('\nApp + DB settings look ready. Confirm pg_cron job is active in SQL Editor.');
  console.log('Sniper should auto-start Monday 9:35–11:00 IST (browser closed).\n');
} else {
  console.log('\nFix failed items before Monday. Deploy martingale-bot after DB push.\n');
  process.exit(1);
}
