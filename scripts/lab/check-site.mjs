// Labo 8 : la note des signaux calculée avec le vrai code du site (scripts/lib/setups.mjs) sur les données Binance.
// 1) tous les signaux (sans la règle « un trade à la fois ») → note apprise sur 2020-2024 seulement ;
// 2) le site rejoué avec cette note → chiffres 2020-24 et 2025-26 pour l'encadré « Ce qu'on peut attendre ».
// Temporaire, à supprimer avant fusion. Usage : node scripts/lab/check-site.mjs <dossier CSV Binance>
import fs from 'node:fs';
import path from 'node:path';
import { MODES, RULES, SCORE, SCORE_FEAT, marketOf, scanAsset, scoreOf } from '../lib/setups.mjs';

const DIR = process.argv[2];
const D = 86_400_000;
const DV = [Date.UTC(2020, 0, 1), Date.UTC(2025, 0, 1)], TEST = [Date.UTC(2025, 0, 1), Date.UTC(2027, 0, 1)];
const COST = 0.0016;
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
const SYMS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'LINK', 'AVAX', 'ADA'];
const DATA = Object.fromEntries(SYMS.map(s => [s, { bars: load(`${s}USDT`, '1h'), daily: load(`${s}USDT`, '1d') }]));
const LAST = Math.max(...SYMS.map(s => DATA[s].bars.at(-1).t));
const market = marketOf(Object.fromEntries(SYMS.map(s => [s, DATA[s].daily])));
const ALLCFG = { ...MODES.swing, backtestBars: 1e9 };
const asset = s => ({ symbol: s, kind: 'crypto' });
const net = x => x.r - COST * x.entry / Math.abs(x.entry - x.sl);
const inP = (x, P) => x.time >= P[0] && x.time < P[1];
const months = P => (Math.min(P[1], LAST) - P[0]) / (30.44 * D);
console.log(`DATA|${SYMS.length} paires|fin ${new Date(LAST).toISOString().slice(0, 10)}`);

// ---------- 1) apprentissage ----------
function fitLog(X, y, lam = 1e-2, it = 400, lr = 0.3) {
  const n = X.length, m = X[0].length, w = new Array(m + 1).fill(0);
  for (let t = 0; t < it; t++) {
    const g = new Array(m + 1).fill(0);
    for (let i = 0; i < n; i++) { let z = w[m]; for (let k = 0; k < m; k++) z += w[k] * X[i][k]; const d = 1 / (1 + Math.exp(-z)) - y[i]; for (let k = 0; k < m; k++) g[k] += d * X[i][k]; g[m] += d; }
    for (let k = 0; k < m; k++) w[k] -= lr * (g[k] / n + lam * w[k]); w[m] -= lr * g[m] / n;
  }
  return w;
}
const allSig = SYMS.flatMap(s => scanAsset(asset(s), { ...DATA[s], market }, { ...ALLCFG, allSignals: true, keepFeatures: true }, null)).filter(x => x.outcome !== 'open' && x.f);
const dev = allSig.filter(x => inP(x, DV));
console.log(`SIGNAUX|tous ${allSig.length} | 2020-24 ${dev.length} | 2025-26 ${allSig.filter(x => inP(x, TEST)).length}`);
const m = SCORE_FEAT.length, mu = [], sd = [];
for (let k = 0; k < m; k++) { const c = dev.map(x => x.f[k]); mu[k] = c.reduce((a, b) => a + b, 0) / c.length; sd[k] = Math.sqrt(c.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / c.length) || 1; }
const Z = f => f.map((v, k) => Math.max(-4, Math.min(4, (v - mu[k]) / sd[k])));
const w = fitLog(dev.map(x => Z(x.f)), dev.map(x => +(net(x) > 1)));
const r4 = v => Math.round(v * 1e4) / 1e4;
const base = { mu: mu.map(r4), sd: sd.map(r4), w: w.slice(0, m).map(r4), b: r4(w[m]) };
const devS = dev.map(x => scoreOf(x.f, base)).sort((a, b) => b - a);
const models = {};
for (const want of [10, 12, 15]) models[want] = { ...base, thr: devS[Math.round(want * 1.25 * months(DV))] };
console.log(`POIDS|${SCORE_FEAT.map((k, i) => `${k} ${base.w[i] >= 0 ? '+' : ''}${base.w[i].toFixed(2)}`).join(' · ')}`);
for (const [want, mo] of Object.entries(models)) console.log(`MODELE ~${want}/mois|${JSON.stringify(mo)}`);
if (SCORE) console.log(`MODELE EN PLACE|seuil ${SCORE.thr}`);

// ---------- 2) le site rejoué ----------
function simulate(list, P, risk, sized) {
  const ev = list.filter(x => inP(x, P)).sort((a, b) => a.time - b.time);
  let eq = 100, pk = 100, dd = 0; const closes = []; const years = {}; let yl = 100, yc = null;
  const flush = t => { closes.sort((a, b) => a.at - b.at); while (closes.length && closes[0].at <= t) { const c = closes.shift(); eq += c.amt * c.rn; pk = Math.max(pk, eq); dd = Math.max(dd, 1 - eq / pk); const y = new Date(c.at).getUTCFullYear(); if (yc !== null && y !== yc) { years[yc] = eq / yl - 1; yl = eq; } yc = y; } };
  for (const x of ev) { flush(x.time); closes.push({ at: x.at, amt: eq * risk / 100 * (sized ? x.sz : 1), rn: net(x) }); }
  flush(Infinity); if (yc !== null) years[yc] = eq / yl - 1;
  const yrs = (Math.min(P[1], LAST) - P[0]) / (365.25 * D);
  return { cagr: (eq / 100) ** (1 / yrs) - 1, dd, years };
}
const pc = x => (x >= 0 ? '+' : '') + Math.round(x * 100) + ' %';
function report(tag, list) {
  for (const [nm, P] of [['2020-24', DV], ['2025-26', TEST]]) {
    const x = list.filter(t => inP(t, P)).sort((a, b) => a.at - b.at);
    const rs = x.map(t => net(t) * t.sz), wins = x.filter(t => t.r > 0).length;
    let cum = 0, pk = 0, ddR = 0, st = 0, streak = 0; for (const t of x) { cum += net(t) * t.sz; pk = Math.max(pk, cum); ddR = Math.max(ddR, pk - cum); st = t.r > 0 ? 0 : st + 1; streak = Math.max(streak, st); }
    const s1 = simulate(list, P, 1, true), s05 = simulate(list, P, 0.5, true), f1 = simulate(list, P, 1, false);
    console.log(`${tag}|${nm}|${x.length} tr | ${(x.length / months(P)).toFixed(1)}/mois | gagnants ${Math.round(wins / x.length * 100)} % | ${(rs.reduce((a, b) => a + b, 0) / x.length).toFixed(2)} R/tr (avec taille) | baisse ${ddR.toFixed(0)} R | série ${streak} | 1 % avec taille ${pc(s1.cagr)}/an baisse ${Math.round(s1.dd * 100)} % (${Object.entries(s1.years).map(([y, v]) => `${y} ${pc(v)}`).join(' · ')}) | 0,5 % ${pc(s05.cagr)}/an baisse ${Math.round(s05.dd * 100)} % | 1 % sans taille ${pc(f1.cagr)}/an baisse ${Math.round(f1.dd * 100)} %`);
  }
}
report('SITE sans note', SYMS.flatMap(s => scanAsset(asset(s), { ...DATA[s], market }, ALLCFG, null)).filter(x => x.outcome !== 'open'));
for (const [want, mo] of Object.entries(models)) report(`SITE note ~${want}`, SYMS.flatMap(s => scanAsset(asset(s), { ...DATA[s], market }, ALLCFG, mo)).filter(x => x.outcome !== 'open'));
if (SCORE) report('SITE note en place', SYMS.flatMap(s => scanAsset(asset(s), { ...DATA[s], market }, ALLCFG)).filter(x => x.outcome !== 'open'));
