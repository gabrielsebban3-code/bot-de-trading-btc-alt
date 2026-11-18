// Test de robustesse de la stratégie de l'onglet Setups avec la méthode du labo perp-setups :
// 20 paires Binance USDT-M, 2020-2026, périodes DEV / VAL / TEST, frais + slippage, entrées au hasard.
// Usage : node scripts/lab/stress-setups.mjs <dossier des CSV Binance>
import fs from 'node:fs';
import path from 'node:path';
import { RULES, scanAsset, plan, exitLevel, dailyContext, lastDay, atr, BAR } from '../lib/setups.mjs';

const DIR = process.argv[2];
const DAY = 86_400_000;
const COST = 2 * (0.0005 + 0.0003); // aller-retour : frais taker 0,05 % + slippage 0,03 % par côté (config du labo)
RULES.backtestBars = 1e9;            // tout l'historique

const PERIODS = [
  ['DEV 2020-2022', Date.UTC(2020, 0, 1), Date.UTC(2023, 0, 1)],
  ['VAL 2023-2024', Date.UTC(2023, 0, 1), Date.UTC(2025, 0, 1)],
  ['TEST 2025-2026', Date.UTC(2025, 0, 1), Date.UTC(2027, 0, 1)],
  ['Période du site (mars 2023 → oct. 2026)', Date.UTC(2023, 2, 1), Date.UTC(2026, 9, 2)],
];

function load(sym, tf) {
  const rows = [];
  for (const f of fs.readdirSync(DIR).filter(f => f.startsWith(`${sym}-${tf}-`) && f.endsWith('.csv')).sort()) {
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      const p = line.split(',');
      if (p.length < 6 || isNaN(+p[0])) continue;
      let t = +p[0]; if (t > 1e14) t = Math.floor(t / 1000);
      rows.push({ t, o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: +p[5], closed: true });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return rows.filter((r, k) => k === 0 || r.t !== rows[k - 1].t);
}

// Même suivi que evaluate() du site, avec l'index des jours construit une seule fois (pour les tirages au hasard).
function evalFast(sig, bars, i, daily, dayIndex) {
  const s = sig.dir === 'long' ? 1 : -1, R = Math.abs(sig.entry - sig.sl), P = RULES.partialR;
  let stop = sig.sl, half = false;
  const rOf = px => s * (px - sig.entry) / R;
  const done = (at, rest) => ({ at, r: half ? (P + rest) / 2 : rest });
  for (let k = i + 1; k < bars.length; k++) {
    const b = bars[k];
    if (s > 0 ? b.l <= stop : b.h >= stop) return done(k, half ? 0 : -1);
    if (!half && (s > 0 ? b.h >= sig.tp[0] : b.l <= sig.tp[0])) { half = true; stop = sig.entry; }
    if ((b.t + BAR) % DAY === 0) {
      const jd = dayIndex.get(b.t + BAR - DAY);
      if (jd !== undefined && jd >= RULES.exitDays) {
        const lvl = exitLevel(daily, jd, sig.dir);
        if (s > 0 ? b.c < lvl : b.c > lvl) return done(k, rOf(b.c));
      }
    }
  }
  return null; // encore ouvert : non compté
}

const net = (r, entry, sl) => r - COST * entry / Math.abs(entry - sl);

function stats(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const rs = trades.map(t => t.rn);
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const win = rs.filter(r => r > 0).length / n;
  const gp = rs.filter(r => r > 0).reduce((a, b) => a + b, 0), gl = -rs.filter(r => r < 0).reduce((a, b) => a + b, 0);
  // IC 95 % par bootstrap
  const bs = [];
  for (let k = 0; k < 2000; k++) { let s = 0; for (let q = 0; q < n; q++) s += rs[(Math.random() * n) | 0]; bs.push(s / n); }
  bs.sort((a, b) => a - b);
  // drawdown en R (1R = 1 % du capital, somme simple), trades rangés par date de sortie
  let eq = 0, peak = 0, dd = 0;
  for (const t of [...trades].sort((a, b) => a.exitT - b.exitT)) { eq += t.rn; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const top3 = [...rs].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  return { n, mean, lo: bs[50], hi: bs[1949], win, pf: gl ? gp / gl : Infinity, sum: mean * n, dd, sumNoTop3: mean * n - top3 };
}

const symbols = [...new Set(fs.readdirSync(DIR).map(f => f.split('-')[0]))].sort();
const all = [], perPair = {}, ctxs = {};
for (const sym of symbols) {
  const bars = load(sym, '4h'), daily = load(sym, '1d');
  if (bars.length < 400 || daily.length < 80) { console.log(`${sym}: pas assez de données`); continue; }
  const sigs = scanAsset({ symbol: sym }, { bars, daily });
  const dayIndex = new Map(daily.map((d, k) => [d.t, k]));
  // contrôle : evalFast doit redonner exactement le r du site
  let mismatch = 0;
  const tr = [];
  for (const sg of sigs) {
    if (sg.outcome === 'open') continue;
    const i = bars.findIndex(b => b.t === sg.time);
    const f = evalFast(sg, bars, i, daily, dayIndex);
    if (!f || Math.abs(f.r - sg.r) > 0.011) mismatch++;
    tr.push({ sym, t: sg.time, exitT: sg.at, dir: sg.dir, det: sg.detector, r: sg.r, rn: net(sg.r, sg.entry, sg.sl) });
  }
  if (mismatch) console.log(`ATTENTION ${sym}: ${mismatch} écarts entre evalFast et evaluate`);
  all.push(...tr); perPair[sym] = tr;
  ctxs[sym] = { bars, daily, dayIndex, dc: dailyContext(daily), A: atr(bars) };
  console.log(`${sym}: ${bars.length} bougies 4h (${new Date(bars[0].t).toISOString().slice(0, 10)} → ${new Date(bars.at(-1).t).toISOString().slice(0, 10)}), ${tr.length} trades clos`);
}

// Entrées au hasard : même nombre de trades par paire et par période, dans le sens de la tendance journalière,
// mêmes stop / moitié à 5R / sortie 7 jours, un trade à la fois. Seule l'entrée (cassures, MACD, marge) change.
function randomRun(sym, from, to, nWanted) {
  const { bars, daily, dayIndex, dc, A } = ctxs[sym];
  const idx = [];
  for (let i = RULES.warmup; i < bars.length; i++) {
    if (bars[i].t < from || bars[i].t >= to || !A[i]) continue;
    const j = lastDay(dc, bars[i].t + BAR);
    if (j < 0 || !dc.atr[j] || dc.trend[j] === 'neutre') continue;
    idx.push([i, j]);
  }
  if (!idx.length || !nWanted) return [];
  const p = nWanted / idx.length * 1.6; // un peu plus de tirages, car un trade en cours bloque les suivants
  const out = []; let busy = -1;
  for (const [i, j] of idx) {
    if (i <= busy || Math.random() > p) continue;
    const dir = dc.trend[j] === 'haussière' ? 'long' : 'short';
    const entry = bars[i].c, pl = plan(dir, entry, dc.atr[j]);
    const f = evalFast({ dir, entry, sl: pl.sl, tp: pl.tp }, bars, i, daily, dayIndex);
    if (!f) break;
    out.push({ rn: net(f.r, entry, pl.sl), exitT: bars[f.at].t });
    busy = f.at;
    if (out.length >= nWanted) break;
  }
  return out;
}

const fmt = (x, d = 3) => (x >= 0 ? '+' : '') + x.toFixed(d);
const SITE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
for (const [label, from, to] of PERIODS) {
  for (const scope of ['20 paires', 'BTC+ETH+SOL']) {
    const pick = t => t.t >= from && t.t < to && (scope === '20 paires' || SITE.includes(t.sym));
    const tr = all.filter(pick);
    const s = stats(tr);
    if (!s.n) continue;
    // hasard
    const sims = [];
    for (let k = 0; k < 200; k++) {
      const rr = [];
      for (const sym of Object.keys(perPair)) {
        if (scope !== '20 paires' && !SITE.includes(sym)) continue;
        rr.push(...randomRun(sym, from, to, perPair[sym].filter(pick).length));
      }
      if (rr.length) sims.push(rr.reduce((a, b) => a + b.rn, 0) / rr.length);
    }
    sims.sort((a, b) => a - b);
    const pct = sims.filter(x => x < s.mean).length / sims.length * 100;
    const pairs = Object.keys(perPair).filter(sym => scope === '20 paires' || SITE.includes(sym)).map(sym => [sym, stats(perPair[sym].filter(pick))]).filter(([, x]) => x.n >= 10);
    const pos = pairs.filter(([, x]) => x.mean > 0).length;
    console.log(`\n=== ${label} — ${scope}`);
    console.log(`RES|${label}|${scope}|trades ${s.n}|gagnants ${(s.win * 100).toFixed(1)} %|E[R] net ${fmt(s.mean)} R|IC95 [${fmt(s.lo)} ; ${fmt(s.hi)}]|PF ${s.pf.toFixed(2)}|total ${fmt(s.sum, 1)} R|sans 3 meilleurs ${fmt(s.sumNoTop3, 1)} R|DD max ${s.dd.toFixed(1)} R|hasard médiane ${fmt(sims[sims.length >> 1])} R, 95e centile ${fmt(sims[Math.floor(sims.length * 0.95)])} R, notre centile ${pct.toFixed(0)}|paires positives ${pos}/${pairs.length}`);
    console.log('PAIRES|' + pairs.map(([sym, x]) => `${sym.replace('USDT', '')} ${fmt(x.mean, 2)} (${x.n})`).join(', '));
  }
}
// par année (20 paires)
for (let y = 2020; y <= 2026; y++) {
  const s = stats(all.filter(t => new Date(t.t).getUTCFullYear() === y));
  if (s.n) console.log(`ANNEE|${y}|trades ${s.n}|E[R] ${fmt(s.mean)}|total ${fmt(s.sum, 1)} R`);
}
for (const d of ['range20', 'range10', 'macd']) {
  const s = stats(all.filter(t => t.det === d && t.t >= Date.UTC(2025, 0, 1)));
  const s2 = stats(all.filter(t => t.det === d));
  console.log(`DETECTEUR|${d}|tout ${s2.n} trades E[R] ${fmt(s2.mean)}|TEST ${s.n} trades E[R] ${s.n ? fmt(s.mean) : '-'}`);
}
