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
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY;
const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

const cr = await fetch(`${url}/functions/v1/martingale-bot`, {
  method: 'POST',
  headers: h,
  body: JSON.stringify({ action: 'cron-tick', source: 'pg_cron' }),
});
console.log('cron-tick:', JSON.stringify(await cr.json(), null, 2));

const bs = await fetch(
  `${url}/rest/v1/bot_settings?select=key,value&key=in.('last_cron_tick_at','last_sniper_auto_start_log')`,
  { headers: h },
);
console.log('bot_settings:', JSON.stringify(await bs.json(), null, 2));
