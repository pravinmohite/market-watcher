#!/usr/bin/env node
/**
 * Diagnose why sniper did not auto-start on a given IST date.
 * Usage: node scripts/diagnose-sniper-autostart.mjs [YYYY-MM-DD]
 * Default date: yesterday IST.
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

function loadEnv() {
  if (!existsSync(envPath)) return {};
  const out = {};
  const raw = readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
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

function istDateOffset(d = new Date()) {
  const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return ist;
}

function yesterdayYmdIst() {
  const ist = istDateOffset();
  ist.setDate(ist.getDate() - 1);
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, '0');
  const day = String(ist.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function istDayBoundsUtc(ymd) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const istMidnight = new Date(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+05:30`);
  const next = new Date(istMidnight);
  next.setDate(next.getDate() + 1);
  return { start: istMidnight.toISOString(), end: next.toISOString() };
}

const env = loadEnv();
const url = (env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;
const targetYmd = process.argv[2] || yesterdayYmdIst();

if (!url || !key || url.includes('not-configured')) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env');
  process.exit(1);
}

const { start, end } = istDayBoundsUtc(targetYmd);

async function rest(path, opts = {}) {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
    ...opts,
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}

async function invokeMartingale(body) {
  const r = await fetch(`${url}/functions/v1/martingale-bot`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return r.json();
}

console.log(`\n=== Sniper auto-start diagnosis for ${targetYmd} (IST) ===\n`);

const settings = await rest('bot_settings?select=key,value,updated_at');
const settingsMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));
console.log('Current bot_settings:');
for (const k of [
  'strategy_mode',
  'bot_running',
  'trading_mode',
  'sideways_pause_until',
]) {
  console.log(`  ${k}: ${settingsMap[k] ?? '(not set)'}`);
}

let sessions = [];
try {
  sessions = await rest(
    `martingale_sessions?select=id,status,strategy_mode,max_rounds,created_at,completed_at&created_at=gte.${start}&created_at=lt.${end}&order=created_at.asc`,
  );
} catch (e) {
  if (String(e.message).includes('strategy_mode')) {
    console.log('\n⚠️  DB migration missing: martingale_sessions.strategy_mode column does not exist.');
    console.log('    Run: supabase db push (migration 20260522100000_martingale_sessions_strategy_mode.sql)\n');
    sessions = await rest(
      `martingale_sessions?select=id,status,max_rounds,created_at,completed_at&created_at=gte.${start}&created_at=lt.${end}&order=created_at.asc`,
    );
  } else throw e;
}
console.log(`\nSessions on ${targetYmd}: ${sessions.length}`);
for (const s of sessions) {
  console.log(
    `  ${s.created_at?.slice(11, 19)} IST-ish | status=${s.status} | strategy=${s.strategy_mode ?? '?'} | max_rounds=${s.max_rounds} | id=${s.id?.slice(0, 8)}...`,
  );
}

const trades = await rest(
  `martingale_trades?select=id,session_id,round,entry_time,entry_reason_tag,status,pnl&entry_time=gte.${start}&entry_time=lt.${end}&order=entry_time.asc`,
);
console.log(`\nTrades on ${targetYmd}: ${trades.length}`);
const sniperTags = trades.filter((t) => String(t.entry_reason_tag || '').startsWith('sniper_'));
const martTags = trades.filter((t) =>
  /martingale_flip|fresh_r1_after_take_profit|session_start_carry/.test(t.entry_reason_tag || ''),
);
console.log(`  Sniper-tagged trades: ${sniperTags.length}`);
console.log(`  Martingale-tagged trades: ${martTags.length}`);

const window935 = trades.filter((t) => {
  const ist = new Date(new Date(t.entry_time).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 9 * 60 + 35 && mins < 11 * 60;
});
console.log(`  Trades entered 9:35–11:00 IST: ${window935.length}`);
if (window935.length) {
  for (const t of window935.slice(0, 8)) {
    const ist = new Date(new Date(t.entry_time).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    console.log(
      `    ${String(ist.getHours()).padStart(2, '0')}:${String(ist.getMinutes()).padStart(2, '0')} R${t.round} ${t.entry_reason_tag}`,
    );
  }
}

const status = await invokeMartingale({ action: 'status' });
console.log('\nLive status API:');
console.log(`  strategy_mode: ${status.strategy_mode}`);
console.log(`  bot_running: ${status.bot_running}`);
console.log(`  sniper_status: ${JSON.stringify(status.sniper_status ?? null)}`);

console.log('\n--- Likely reasons sniper did NOT auto-start at 9:35 ---\n');
const reasons = [];

const dow = new Date(`${targetYmd}T12:00:00+05:30`).getDay();
if (dow === 0 || dow === 6) reasons.push('Market closed (weekend).');
if (settingsMap.strategy_mode !== 'sniper') {
  reasons.push(`strategy_mode in DB is "${settingsMap.strategy_mode ?? 'missing'}" (need "sniper").`);
}
if (sessions.length > 0 && sniperTags.length === 0) {
  reasons.push(
    `${sessions.length} session(s) that day but ZERO sniper-tagged trades — likely martingale ran, or sniper never started.`,
  );
}
if (sniperTags.length > 0) {
  reasons.push('Sniper DID trade that day — check entry times above (may have started after 9:35).');
}
if (sessions.length === 0 && sniperTags.length === 0) {
  reasons.push('No sessions at all — auto-start never fired OR every start attempt failed.');
  reasons.push('Common: pg_cron not migrated, Vault key missing, edge function not deployed, browser tab closed.');
}
if (martTags.length > 0 && settingsMap.strategy_mode === 'sniper') {
  reasons.push('Martingale trades exist while sniper selected — old code or strategy_mode was flipped during day.');
}

if (reasons.length === 0) reasons.push('Review Supabase Edge Function logs for martingale-bot around 04:05 UTC.');
for (const r of reasons) console.log(`  • ${r}`);

console.log('\nSupabase checks (SQL Editor):');
console.log('  SELECT jobname, schedule, active FROM cron.job WHERE jobname = \'martingale-sniper-morning-tick\';');
console.log('  SELECT name FROM vault.secrets WHERE name LIKE \'martingale_%\';');
console.log('');
