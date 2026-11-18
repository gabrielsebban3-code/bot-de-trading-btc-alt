// Chiffres honnêtes pour l'onglet Setups : la vraie librairie du site (scripts/lib/setups.mjs) sur les bougies
// Binance 2020-2026, modes swing (1h / jour) et court (1h / 4h), frais + slippage déduits.
// Usage : node scripts/lab/honest.mjs <dossier CSV Binance>
import fs from 'node:fs';
import path from 'node:path';
import { MODES, scanAsset } from '../lib/setups.mjs';

const DIR = process.argv[2];
const COST = 2 * (0.0005 + 0.0003);
const SITE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT', 'LINKUSDT', 'AVAXUSDT', 'ADAUSDT'];
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
const f2 = x => (x >= 0 ? '+' : '') + x.toFixed(2);
function stats(tr, months) {
  const n = tr.length; if (!n) return 'aucun trade';
  const rs = tr.map(t => t.rn), mean = rs.reduce((a, b) => a + b, 0) / n;
  let eq = 0, pk = 0, dd = 0, streak = 0, maxStreak = 0;
  for (const t of [...tr].sort((a, b) => a.at - b.at)) { eq += t.rn; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); streak = t.rn < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
  const years = {}; for (const t of tr) { const y = new Date(t.time).getUTCFullYear(); years[y] = (years[y] || 0) + t.rn; }
  const halfHit = tr.filter(t => t.tpHit).length / n;
  return `trades ${n} (${(n / months).toFixed(1)}/mois) | gagnants ${(rs.filter(r => r > 0).length / n * 100).toFixed(0)} % | moitié prise ${(halfHit * 100).toFixed(0)} % | E[R] net ${f2(mean)} | total ${f2(mean * n)} R | baisse max ${dd.toFixed(1)} R | pire série ${maxStreak} pertes | durée moy ${(tr.reduce((a, t) => a + (t.at - t.time), 0) / n / 86400e3).toFixed(1)} j | années ${Object.entries(years).map(([y, v]) => `${y} ${f2(v)}`).join(' · ')}`;
}
const syms = [...new Set(fs.readdirSync(DIR).filter(f => f.includes('-1h-')).map(f => f.split('-')[0]))].sort();
for (const [mode, tTf] of [['swing', '1d'], ['court', '4h']]) {
  const cfg = { ...MODES[mode], backtestBars: 1e9 };
  const all = [];
  for (const sym of syms) {
    const bars = load(sym, '1h'), daily = load(sym, tTf);
    if (bars.length < 2000) continue;
    for (const s of scanAsset({ symbol: sym }, { bars, daily }, cfg)) {
      if (s.outcome === 'open') continue;
      all.push({ ...s, sym, rn: s.r - COST * s.entry / Math.abs(s.entry - s.sl) });
    }
  }
  for (const [label, from, to, months] of [['2020-2024', Date.UTC(2020, 0, 1), Date.UTC(2025, 0, 1), 60], ['2025-2026', Date.UTC(2025, 0, 1), Date.UTC(2026, 10, 1), 22], ['12 derniers mois', Date.UTC(2025, 10, 1), Date.UTC(2026, 10, 1), 12]]) {
    const inP = all.filter(t => t.time >= from && t.time < to);
    console.log(`HONNETE|${mode}|${label}|9 paires du site|${stats(inP.filter(t => SITE.includes(t.sym)), months)}`);
    console.log(`HONNETE|${mode}|${label}|20 paires|${stats(inP, months)}`);
  }
  for (const d of ['range20', 'range10', 'macd']) {
    const x = all.filter(t => t.detector === d && SITE.includes(t.sym));
    console.log(`DETECT|${mode}|${d}|${x.length} trades|E[R] ${x.length ? f2(x.reduce((a, t) => a + t.rn, 0) / x.length) : '-'}`);
  }
  for (const sym of SITE) { const x = all.filter(t => t.sym === sym && t.time >= Date.UTC(2025, 0, 1)); console.log(`PAIRE|${mode}|${sym}|2025-2026 ${x.length} trades E[R] ${x.length ? f2(x.reduce((a, t) => a + t.rn, 0) / x.length) : '-'}`); }
}
