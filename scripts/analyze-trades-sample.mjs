/** One-off analysis of pasted trade report — run: node scripts/analyze-trades-sample.mjs */

const RAW = `20/5/2026, 3:25:46 pm	1	PE	23600	276.65	276.44	closed	-14	up	session_start_carry_direction_from_prior
20/5/2026, 3:12:27 pm	4	CE	23700	294.4	290.98	closed	-1778	up	martingale_flip_after_loss_round
20/5/2026, 3:02:43 pm	3	PE	23600	281.5	275.1	closed	-1664	sideways	martingale_flip_after_loss_round
20/5/2026, 2:45:28 pm	2	CE	23750	271.48	263.86	closed	-991	down	martingale_flip_after_loss_round
20/5/2026, 2:30:10 pm	1	PE	23600	277	271.35	closed	-367	up	session_start_carry_direction_from_prior
20/5/2026, 11:03:05 am	1	CE	23600	291.33	290.52	closed	-53	up	fresh_r1_after_take_profit_auto_chain
20/5/2026, 10:55:46 am	2	CE	23600	278.43	285.97	closed	980	sideways	martingale_flip_after_loss_round
20/5/2026, 10:46:23 am	1	PE	23450	269.54	262.88	closed	-433	up	fresh_r1_after_take_profit_auto_chain
20/5/2026, 10:41:42 am	2	PE	23500	280.57	289.18	closed	1119	sideways	martingale_flip_after_loss_round
20/5/2026, 10:39:42 am	1	CE	23600	293.15	286.49	closed	-433	up	fresh_r1_after_take_profit_auto_chain
20/5/2026, 10:32:24 am	1	CE	23600	280.25	287.8	closed	491	sideways	fresh_r1_after_take_profit_auto_chain
20/5/2026, 10:30:24 am	5	CE	23550	291.94	299.73	closed	8102	up	martingale_flip_after_loss_round
20/5/2026, 10:04:27 am	4	PE	23450	281.67	274.26	closed	-3853	sideways	martingale_flip_after_loss_round
20/5/2026, 9:47:03 am	3	CE	23600	270.53	261.02	closed	-2473	down	martingale_flip_after_loss_round
20/5/2026, 9:44:00 am	2	PE	23450	279.19	271.21	closed	-1037	sideways	martingale_flip_after_loss_round
20/5/2026, 9:37:42 am	1	CE	23600	268.5	261.71	closed	-441	down	fresh_r1_after_take_profit_auto_chain
20/5/2026, 9:33:02 am	1	CE	23550	281.45	288.5	closed	458	sideways	fresh_r1_after_take_profit_auto_chain
20/5/2026, 9:28:24 am	2	CE	23500	291.14	300.09	closed	1163	up	martingale_flip_after_loss_round
20/5/2026, 9:25:13 am	1	PE	23400	279.1	272.96	closed	-399	sideways	session_start_carry_direction_from_prior
19/5/2026, 10:44:23 am	5	CE	23800	290.73	279.39	closed	-11794	up	martingale_flip_after_loss_round
19/5/2026, 10:37:01 am	4	PE	23700	290.25	282.17	closed	-4202	down	martingale_flip_after_loss_round
19/5/2026, 10:28:00 am	3	CE	23800	286.75	280.99	closed	-1498	sideways	martingale_flip_after_loss_round
19/5/2026, 10:20:00 am	2	PE	23700	292	285.16	closed	-889	down	martingale_flip_after_loss_round
19/5/2026, 10:12:43 am	1	CE	23800	285.39	279.34	closed	-393	sideways	fresh_r1_after_take_profit_auto_chain
19/5/2026, 10:10:45 am	4	CE	23800	273.05	280.26	closed	3749	down	martingale_flip_after_loss_round
19/5/2026, 10:08:02 am	3	PE	23650	278.89	272.74	closed	-1599	up	martingale_flip_after_loss_round
19/5/2026, 10:06:23 am	2	CE	23800	271.95	266.45	closed	-715	down	martingale_flip_after_loss_round
19/5/2026, 9:52:23 am	1	PE	23650	281.49	274.38	closed	-462	sideways	fresh_r1_after_take_profit_auto_chain
19/5/2026, 9:47:01 am	2	PE	23700	292.91	301.28	closed	1088	down	martingale_flip_after_loss_round
19/5/2026, 9:44:24 am	1	CE	23800	285.8	278.96	closed	-445	sideways	fresh_r1_after_take_profit_auto_chain
19/5/2026, 9:41:42 am	1	CE	23800	273.87	280.85	closed	454	down	fresh_r1_after_take_profit_auto_chain
19/5/2026, 9:39:04 am	2	CE	23750	282.2	291.95	closed	1268	sideways	martingale_flip_after_loss_round
19/5/2026, 9:36:05 am	1	PE	23600	273.66	264.6	closed	-589	up	fresh_r1_after_take_profit_auto_chain
19/5/2026, 9:35:08 am	1	PE	23650	284.05	293.05	closed	585	sideways	fresh_r1_after_take_profit_auto_chain
19/5/2026, 9:34:24 am	2	PE	23650	271.27	279.14	closed	1023	up	martingale_flip_after_loss_round
19/5/2026, 9:25:11 am	1	CE	23800	283.7	276.02	closed	-499	sideways	session_start_carry_direction_from_prior
18/5/2026, 10:32:23 am	2	PE	23300	273.36	103.05	closed	-22140	up	martingale_flip_after_loss_round
18/5/2026, 10:18:00 am	1	CE	23450	269.68	263.44	closed	-406	down	fresh_r1_after_take_profit_auto_chain
18/5/2026, 10:02:23 am	2	CE	23400	277.52	287.56	closed	1305	sideways	martingale_flip_after_loss_round
18/5/2026, 9:54:24 am	1	PE	23300	289.39	283.31	closed	-395	down	fresh_r1_after_take_profit_auto_chain
18/5/2026, 9:49:00 am	3	PE	23300	278.06	285.04	closed	1815	sideways	martingale_flip_after_loss_round
18/5/2026, 9:43:42 am	2	CE	23450	266.4	256.91	closed	-1234	down	martingale_flip_after_loss_round
18/5/2026, 9:39:23 am	1	PE	23300	276.41	270.22	closed	-402	sideways	fresh_r1_after_take_profit_auto_chain
18/5/2026, 9:26:45 am	2	PE	23350	286.89	295.83	closed	1162	down	martingale_flip_after_loss_round
18/5/2026, 9:25:09 am	1	CE	23450	282.3	275.75	closed	-426	sideways	session_start_carry_direction_from_prior
15/5/2026, 3:25:42 pm	1	PE	23600	290.68	290.68	closed	0	down	session_start_carry_direction_from_prior
15/5/2026, 3:21:02 pm	2	CE	23700	278.35	275.85	closed	-325	sideways	martingale_flip_after_loss_round
15/5/2026, 3:16:41 pm	1	PE	23550	270.99	265.05	closed	-386	up	fresh_r1_after_take_profit_auto_chain
15/5/2026, 3:08:23 pm	2	PE	23600	280.43	290.02	closed	1247	sideways	martingale_flip_after_loss_round
15/5/2026, 3:05:43 pm	1	CE	23750	271.33	264.46	closed	-447	down	fresh_r1_after_take_profit_auto_chain
15/5/2026, 3:01:59 pm	2	CE	23700	283.07	290.82	closed	1008	sideways	martingale_flip_after_loss_round
15/5/2026, 2:50:23 pm	1	PE	23600	292.75	286.04	closed	-436	down	fresh_r1_after_take_profit_auto_chain
15/5/2026, 2:47:59 pm	1	PE	23600	277.34	286.84	closed	618	up	fresh_r1_after_take_profit_auto_chain
15/5/2026, 2:30:08 pm	1	PE	23650	288.8	297.14	closed	542	down	session_start_carry_direction_from_prior
15/5/2026, 11:07:32 am	1	PE	23700	279.68	281.58	closed	123	up	fresh_r1_after_take_profit_auto_chain
15/5/2026, 11:04:02 am	1	PE	23750	287.59	298.12	closed	684	sideways	session_start_carry_direction_from_prior
15/5/2026, 10:23:24 am	5	CE	23850	292.17	285.66	closed	-6770	up	martingale_flip_after_loss_round
15/5/2026, 10:09:23 am	4	PE	23750	287.66	281.1	closed	-3411	sideways	martingale_flip_after_loss_round
15/5/2026, 10:05:43 am	3	CE	23850	293.35	286.1	closed	-1885	up	martingale_flip_after_loss_round
15/5/2026, 10:02:42 am	2	PE	23750	287.52	280.36	closed	-931	sideways	martingale_flip_after_loss_round
15/5/2026, 9:47:41 am	1	CE	23850	291.12	285.27	closed	-380	up	fresh_r1_after_take_profit_auto_chain
15/5/2026, 9:42:23 am	3	CE	23850	275.4	284.59	closed	2389	down	martingale_flip_after_loss_round
15/5/2026, 9:31:29 am	2	PE	23700	277.81	271.74	closed	-789	up	martingale_flip_after_loss_round
15/5/2026, 9:29:01 am	1	CE	23850	275.7	269.45	closed	-406	down	fresh_r1_after_take_profit_auto_chain
15/5/2026, 9:25:09 am	1	CE	23800	287.03	295.02	closed	519	sideways	session_start_carry_direction_from_prior
14/5/2026, 3:25:44 pm	1	PE	23650	288.12	287.83	closed	-19	down	session_start_carry_direction_from_prior
14/5/2026, 3:06:02 pm	3	PE	23650	284.88	286.87	closed	517	sideways	martingale_flip_after_loss_round
14/5/2026, 2:59:42 pm	2	CE	23750	294.23	286.62	closed	-989	up	martingale_flip_after_loss_round
14/5/2026, 2:50:02 pm	1	PE	23650	284.17	277	closed	-466	sideways	fresh_r1_after_take_profit_auto_chain
14/5/2026, 2:41:43 pm	2	PE	23700	295.56	303.95	closed	1091	down	martingale_flip_after_loss_round
14/5/2026, 2:30:12 pm	1	CE	23800	286.16	277.47	closed	-565	sideways	session_start_carry_direction_from_prior
14/5/2026, 10:58:23 am	1	PE	23400	285.74	281.87	closed	-252	down	fresh_r1_after_take_profit_auto_chain
14/5/2026, 10:47:43 am	1	PE	23450	292.58	303.77	closed	727	down	fresh_r1_after_take_profit_auto_chain
14/5/2026, 10:44:02 am	2	PE	23450	280.13	287.79	closed	996	sideways	martingale_flip_after_loss_round
14/5/2026, 10:37:43 am	1	CE	23600	272.45	262.76	closed	-630	down	fresh_r1_after_take_profit_auto_chain
14/5/2026, 10:28:43 am	3	CE	23550	284.71	292.16	closed	1937	sideways	martingale_flip_after_loss_round
14/5/2026, 10:22:23 am	2	PE	23450	286.42	280.31	closed	-794	down	martingale_flip_after_loss_round
14/5/2026, 10:18:43 am	1	CE	23550	284.91	278.69	closed	-404	up	fresh_r1_after_take_profit_auto_chain
14/5/2026, 10:02:24 am	2	CE	23500	289.01	301.24	closed	1590	up	martingale_flip_after_loss_round
14/5/2026, 9:59:42 am	1	PE	23400	280.48	274.74	closed	-373	sideways	fresh_r1_after_take_profit_auto_chain
14/5/2026, 9:54:08 am	1	PE	23450	289.22	299.24	closed	651	down	fresh_r1_after_take_profit_auto_chain
14/5/2026, 9:49:02 am	3	PE	23450	274.39	283.53	closed	2376	up	martingale_flip_after_loss_round
14/5/2026, 9:47:06 am	2	CE	23600	270.81	263.97	closed	-889	down	martingale_flip_after_loss_round
14/5/2026, 9:43:24 am	1	PE	23450	277.16	270.26	closed	-449	sideways	fresh_r1_after_take_profit_auto_chain
14/5/2026, 9:39:42 am	2	PE	23500	288.77	297.02	closed	1073	down	martingale_flip_after_loss_round
14/5/2026, 9:25:09 am	1	CE	23600	286.43	278.64	closed	-506	up	session_start_carry_direction_from_prior`;

function parseTimeBucket(entryIst) {
  const m = entryIst.match(/(\d+):(\d+):\d+ (am|pm)/i);
  if (!m) return 'unknown';
  let h = +m[1];
  const min = +m[2];
  if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
  if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
  const mins = h * 60 + min;
  if (mins < 9 * 60 + 35) return 'pre_open';
  if (mins < 10 * 60 + 30) return 'open_925_1030';
  if (mins < 11 * 60 + 20) return 'late_morning';
  if (mins < 14 * 60 + 30) return 'midday_skip';
  if (mins < 15 * 60 + 25) return 'afternoon';
  return 'post_close';
}

function trendAligns(leg, trend) {
  if (trend === 'up') return leg === 'CE';
  if (trend === 'down') return leg === 'PE';
  return null; // sideways neutral
}

function seg(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].map(([k, g]) => {
    const wins = g.filter((x) => x.pnl > 0).length;
    const n = g.length;
    const pnl = g.reduce((s, x) => s + x.pnl, 0);
    return { k, n, wins, wr: (100 * wins) / n, pnl, avg: pnl / n };
  }).sort((a, b) => b.wr - a.wr || b.pnl - a.pnl);
}

const rows = RAW.trim().split('\n').map((line) => {
  const p = line.split('\t');
  const entry = p[0];
  const day = entry.split(',')[0].trim();
  return {
    day,
    entry,
    r: +p[1],
    leg: p[2],
    entryPx: +p[4],
    exitPx: +p[5],
    pnl: +p[7],
    trend: p[8],
    tag: p[9],
    bucket: parseTimeBucket(entry),
    aligned: trendAligns(p[2], p[8]),
    pctMove: ((+p[5] - +p[4]) / +p[4]) * 100,
    isMartingale: p[9].includes('martingale'),
    isR1Only: +p[1] === 1,
    isFresh: p[9].includes('fresh_r1'),
    isSessionStart: p[9].includes('session_start'),
  };
});

const totalPnl = rows.reduce((s, x) => s + x.pnl, 0);
const wins = rows.filter((x) => x.pnl > 0).length;
console.log('=== GLOBAL ===');
console.log({ trades: rows.length, netPnl: totalPnl, winRate: ((100 * wins) / rows.length).toFixed(1) + '%' });

console.log('\n=== BY ROUND ===');
console.table(seg(rows, (x) => 'R' + x.r).map((x) => ({ ...x, wr: x.wr.toFixed(1) + '%' })));

console.log('\n=== BY TIME BUCKET ===');
console.table(seg(rows, (x) => x.bucket).map((x) => ({ ...x, wr: x.wr.toFixed(1) + '%' })));

console.log('\n=== BY TAG (short) ===');
console.table(
  seg(rows, (x) => (x.isMartingale ? 'martingale' : x.isFresh ? 'fresh_r1' : 'session_start')).map((x) => ({
    ...x,
    wr: x.wr.toFixed(1) + '%',
  })),
);

console.log('\n=== TREND x LEG (alignment) ===');
const aligned = rows.filter((x) => x.aligned === true);
const misaligned = rows.filter((x) => x.aligned === false);
const sideways = rows.filter((x) => x.aligned === null);
for (const [label, g] of [
  ['ALIGNED (CE+up / PE+down)', aligned],
  ['MISALIGNED', misaligned],
  ['SIDEWAYS trend', sideways],
]) {
  const w = g.filter((x) => x.pnl > 0).length;
  console.log(label, g.length, 'trades', 'WR', g.length ? ((100 * w) / g.length).toFixed(1) : '-', 'PnL', g.reduce((s, x) => s + x.pnl, 0));
}

console.log('\n=== HIGH-PROB CANDIDATES (filters, n>=3) ===');
const filters = [
  { name: 'R1 only (all)', f: (x) => x.r === 1 },
  { name: 'R1 fresh_r1 only', f: (x) => x.r === 1 && x.isFresh },
  { name: 'R2 martingale only', f: (x) => x.r === 2 && x.isMartingale },
  { name: 'R1 aligned trend', f: (x) => x.r === 1 && x.aligned === true },
  { name: 'R2 aligned martingale', f: (x) => x.r === 2 && x.isMartingale && x.aligned === true },
  { name: 'open_925_1030 + R1', f: (x) => x.bucket === 'open_925_1030' && x.r === 1 },
  { name: 'open_925_1030 + R2 mart', f: (x) => x.bucket === 'open_925_1030' && x.r === 2 && x.isMartingale },
  { name: 'down trend + PE (any R)', f: (x) => x.trend === 'down' && x.leg === 'PE' },
  { name: 'up trend + CE (any R)', f: (x) => x.trend === 'up' && x.leg === 'CE' },
  { name: 'R1 down+PE', f: (x) => x.r === 1 && x.trend === 'down' && x.leg === 'PE' },
  { name: 'R2 mart down+PE', f: (x) => x.r === 2 && x.isMartingale && x.trend === 'down' && x.leg === 'PE' },
  { name: 'R2 mart sideways', f: (x) => x.r === 2 && x.isMartingale && x.trend === 'sideways' },
  { name: 'NO afternoon', f: (x) => x.bucket !== 'afternoon' },
  { name: 'NO martingale R3+', f: (x) => !(x.isMartingale && x.r >= 3) },
  { name: 'R1 OR R2 mart only (no R3+)', f: (x) => x.r === 1 || (x.r === 2 && x.isMartingale) },
  { name: 'late_morning R1', f: (x) => x.bucket === 'late_morning' && x.r === 1 },
  { name: 'session_start only', f: (x) => x.isSessionStart },
  { name: 'First trade of day 9:25-9:40 R1', f: (x) => x.bucket === 'open_925_1030' && x.r === 1 && /9:(2[5-9]|[3-3]\d|40)/.test(x.entry) },
];

const ranked = filters
  .map(({ name, f }) => {
    const g = rows.filter(f);
    const w = g.filter((x) => x.pnl > 0).length;
    const n = g.length;
    if (n < 3) return null;
    return {
      name,
      n,
      wr: (100 * w) / n,
      pnl: g.reduce((s, x) => s + x.pnl, 0),
      avg: g.reduce((s, x) => s + x.pnl, 0) / n,
    };
  })
  .filter(Boolean)
  .sort((a, b) => b.wr - a.wr || b.pnl - a.pnl);

console.table(ranked.map((x) => ({ ...x, wr: x.wr.toFixed(1) + '%', pnl: Math.round(x.pnl), avg: Math.round(x.avg) })));

console.log('\n=== DAILY: first R1 of morning (9:25-10:00) ===');
const byDay = new Map();
for (const r of rows) {
  if (!byDay.has(r.day)) byDay.set(r.day, []);
  byDay.get(r.day).push(r);
}
for (const [day, trades] of [...byDay.entries()].sort()) {
  const morning = trades
    .filter((t) => t.bucket === 'open_925_1030' && t.r === 1)
    .sort((a, b) => a.entry.localeCompare(b.entry));
  const first = morning[0];
  if (first) {
    console.log(day, first.leg, first.trend, first.pnl, first.tag.slice(0, 25), first.entry.split(',')[1]);
  }
}

console.log('\n=== SESSION CHAINS: martingale depth per calendar day ===');
for (const [day, trades] of [...byDay.entries()].sort()) {
  const maxR = Math.max(...trades.map((t) => t.r));
  const dayPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const martLoss = trades.filter((t) => t.isMartingale && t.r >= 3 && t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  console.log(day, 'maxR', maxR, 'dayPnl', dayPnl, 'R3+martLoss', martLoss);
}

console.log('\n=== SIM: trade only best filter per day ===');
// Pick: open window R2 mart aligned OR R1 aligned - one shot
let simPnl = 0;
let simTrades = 0;
for (const [, trades] of byDay) {
  const candidates = trades.filter(
    (t) =>
      t.bucket === 'open_925_1030' &&
      ((t.r === 2 && t.isMartingale && t.aligned === true) || (t.r === 1 && t.isFresh && t.aligned === true)),
  );
  if (!candidates.length) continue;
  // take first chronologically
  candidates.sort((a, b) => a.entry.localeCompare(b.entry));
  const pick = candidates[0];
  simPnl += pick.pnl;
  simTrades++;
  console.log('  pick', pick.day, pick.entry.split(',')[1], 'R' + pick.r, pick.leg, pick.trend, pick.pnl);
}
console.log('Sim 1 trade/day (open aligned R1 fresh or R2 mart):', { simTrades, simPnl });

console.log('\n=== SIM STRATEGIES (full sample) ===');
const strategies = [
  {
    name: 'A: Only R2 mart + sideways (max 1/day)',
    pick: (dayTrades) => {
      const c = dayTrades.filter((t) => t.r === 2 && t.isMartingale && t.trend === 'sideways');
      c.sort((a, b) => a.entry.localeCompare(b.entry));
      return c[0] || null;
    },
  },
  {
    name: 'B: Only R2 mart + (down+PE OR sideways)',
    pick: (dayTrades) => {
      const c = dayTrades.filter(
        (t) => t.r === 2 && t.isMartingale && (t.trend === 'sideways' || (t.trend === 'down' && t.leg === 'PE')),
      );
      c.sort((a, b) => a.entry.localeCompare(b.entry));
      return c[0] || null;
    },
  },
  {
    name: 'C: R1 fresh only 9:33-10:35, no martingale ever',
    pick: (dayTrades) => {
      const c = dayTrades.filter((t) => t.isFresh && t.r === 1 && t.bucket !== 'afternoon');
      c.sort((a, b) => a.entry.localeCompare(b.entry));
      return c[0] || null;
    },
  },
  {
    name: 'D: Skip day if any R4+ happened prior day',
    pick: (dayTrades, ctx) => {
      if (ctx.priorDayMaxR >= 4) return null;
      const c = dayTrades.filter((t) => t.r === 2 && t.isMartingale && t.trend === 'sideways');
      c.sort((a, b) => a.entry.localeCompare(b.entry));
      return c[0] || null;
    },
  },
  {
    name: 'E: R2 sideways OR R3 sideways (no R4+)',
    pick: (dayTrades) => {
      const c = dayTrades.filter((t) => t.isMartingale && t.trend === 'sideways' && t.r >= 2 && t.r <= 3);
      c.sort((a, b) => a.entry.localeCompare(b.entry));
      return c[0] || null;
    },
  },
  {
    name: 'F: NO up+CE any trade; max 1 R2 mart/day',
    pick: (dayTrades) => {
      const c = dayTrades.filter((t) => !(t.trend === 'up' && t.leg === 'CE') && t.r === 2 && t.isMartingale);
      c.sort((a, b) => a.entry.localeCompare(b.entry));
      return c[0] || null;
    },
  },
];

const sortedDays = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const strat of strategies) {
  let pnl = 0;
  let n = 0;
  let wins = 0;
  let priorDayMaxR = 0;
  for (const [day, dayTrades] of sortedDays) {
    const ctx = { priorDayMaxR };
    const pick = strat.pick(dayTrades, ctx);
    priorDayMaxR = Math.max(...dayTrades.map((t) => t.r));
    if (!pick) continue;
    pnl += pick.pnl;
    n++;
    if (pick.pnl > 0) wins++;
  }
  console.log(strat.name, { trades: n, winRate: n ? ((100 * wins) / n).toFixed(1) + '%' : '-', netPnl: pnl, avg: n ? Math.round(pnl / n) : 0 });
}

console.log('\n=== R2 SIDEWAYS MART — list ===');
rows
  .filter((t) => t.r === 2 && t.isMartingale && t.trend === 'sideways')
  .forEach((t) => console.log(t.day, t.entry.split(',')[1], t.leg, t.pnl));

console.log('\n=== BLOCK up+CE: remaining PnL ===');
const noUpCe = rows.filter((t) => !(t.trend === 'up' && t.leg === 'CE'));
console.log('If never traded up+CE:', noUpCe.length, 'trades', noUpCe.reduce((s, t) => s + t.pnl, 0));

console.log('\n=== BLOCK R3+ only: remaining PnL ===');
const noDeep = rows.filter((t) => !(t.isMartingale && t.r >= 3));
console.log('If stopped at R2 max:', noDeep.length, 'trades', noDeep.reduce((s, t) => s + t.pnl, 0));
