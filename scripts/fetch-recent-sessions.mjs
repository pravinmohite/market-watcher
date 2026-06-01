#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
if (existsSync(join(root, '.env'))) {
  for (const line of readFileSync(join(root, '.env'), 'utf8').replace(/^\uFEFF/, '')) {
    const t = line.trim();
    if (!t || t[0] === '#') continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1);
    env[t.slice(0, eq).trim()] = v;
  }
}
const url = (env.VITE_SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/$/, '');
const key =
  env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  env.VITE_SUPABASE_ANON_KEY ||
  env.SUPABASE_PUBLISHABLE_KEY ||
  env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Missing Supabase URL/key in .env');
  process.exit(1);
}
const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

const sessions = await (
  await fetch(
    `${url}/rest/v1/martingale_sessions?select=id,status,strategy_mode,created_at,completed_at&order=created_at.desc&limit=8`,
    { headers: h },
  )
).json();
console.log('Recent sessions:');
for (const s of sessions) {
  const ist = new Date(new Date(s.created_at).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  console.log(
    `  ${s.created_at} | IST ~${ist.getHours()}:${String(ist.getMinutes()).padStart(2, '0')} | ${s.status} | strategy=${s.strategy_mode ?? '?'}`,
  );
}

const cron = await (
  await fetch(`${url}/functions/v1/martingale-bot`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ action: 'cron-tick', source: 'pg_cron' }),
  })
).json();
console.log('\nManual cron-tick (outside window may skip start):');
console.log(JSON.stringify(cron, null, 2));
