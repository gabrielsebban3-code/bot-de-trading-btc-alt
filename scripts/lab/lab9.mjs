// Labo 9 (23 novembre 2026) : les nouvelles données du marché aident-elles les signaux de l'onglet Setups ?
// Méthode : vrai code du site (scripts/lib/setups.mjs, note des signaux en place), 9 cryptos Binance, frais 0,16 %.
// Pour chaque donnée, on cherche sur 2020-2024 (ou depuis qu'elle existe) le meilleur seuil pour écarter des signaux,
// puis on vérifie sur 2025-2026 (période jamais vue) et face à des filtres au hasard qui écartent autant de signaux.
// Temporaire, à supprimer avant fusion. Usage : node scripts/lab/lab9.mjs <dossier lab-data>
import fs from 'node:fs';
import path from 'node:path';
import { MODES, SCORE, dailyContext, marketOf, scanAsset } from '../lib/setups.mjs';

const DIR = process.argv[2];
const D = 86_400_000, H = 3_600_000;
const DV = [Date.UTC(2020, 0, 1), Date.UTC(2025, 0, 1)], TEST = [Date.UTC(2025, 0, 1), Date.UTC(2027, 0, 1)];
const COST = 0.0016;
const SYMS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'LINK', 'AVAX', 'ADA'];

function csvRows(prefix) {
  const out = [];
  for (const f of fs.readdirSync(DIR).filter(f => f.startsWith(prefix) && f.endsWith('.csv')).sort()) {
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) out.push(line.split(','));
  }
  return out;
}
function load(sym, tf) {
  const rows = [];
  for (const p of csvRows(`${sym}-${tf}-`)) {
    if (p.length < 6 || isNaN(+p[0])) continue;
    let t = +p[0]; if (t > 1e14) t = Math.floor(t / 1000);
    rows.push({ t, o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: +p[5], closed: true });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows.filter((r, k) => k === 0 || r.t !== rows[k - 1].t);
}
// Séries [t, v] triées ; at(series, T) = dernière valeur connue à T.
const sortU = a => a.sort((x, y) => x[0] - y[0]).filter((r, k, s) => k === 0 || r[0] !== s[k - 1][0]);
function at(s, T) {
  if (!s || !s.length || s[0][0] > T) return null;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m][0] <= T) lo = m; else hi = m - 1; }
  return T - s[lo][0] > 3 * D ? null : s[lo][1];
}
function meanBetween(s, A, B) {
  if (!s) return null; let n = 0, m = 0;
  let lo = 0, hi = s.length; while (lo < hi) { const q = (lo + hi) >> 1; if (s[q][0] < A) lo = q + 1; else hi = q; }
  for (let k = lo; k < s.length && s[k][0] <= B; k++) { m += s[k][1]; n++; }
  return n ? m / n : null;
}

// ---------- Données ----------
const DATA = Object.fromEntries(SYMS.map(s => [s, { bars: load(`${s}USDT`, '1h'), daily: load(`${s}USDT`, '1d') }]));
const LAST = Math.max(...SYMS.map(s => DATA[s].bars.at(-1).t));
const metrics = {}, funding = {};
for (const s of SYMS) {
  const oi = [], top = [], crowd = [], taker = [];
  for (const p of csvRows(`${s}USDT-metrics-`)) {
    if (p.length < 8 || !p[0].includes(':')) continue;
    const t = Date.parse(p[0].replace(' ', 'T') + 'Z');
    if (!Number.isFinite(t) || new Date(t).getUTCMinutes() !== 0) continue;
    const num = k => (p[k] === '' ? NaN : +p[k]);
    if (num(3) > 0) oi.push([t, num(3)]);
    if (num(5) > 0) top.push([t, Math.log(num(5))]);
    if (num(6) > 0) crowd.push([t, Math.log(num(6))]);
    if (num(7) > 0) taker.push([t, Math.log(num(7))]);
  }
  metrics[s] = { oi: sortU(oi), top: sortU(top), crowd: sortU(crowd), taker: sortU(taker) };
  const fr = [];
  for (const p of csvRows(`${s}USDT-fundingRate-`)) { if (isNaN(+p[0])) continue; fr.push([+p[0], +p[2]]); }
  funding[s] = sortU(fr);
}
let fng = [];
try { fng = sortU(JSON.parse(fs.readFileSync(path.join(DIR, 'fng.json'), 'utf8')).data.map(x => [+x.timestamp * 1000, +x.value])); } catch { }
const dvol = {};
for (const c of ['BTC', 'ETH']) {
  const pts = [];
  for (const f of fs.readdirSync(DIR).filter(f => f.startsWith(`dvol-${c}-`))) {
    try { for (const r of JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).result.data) pts.push([r[0], r[4]]); } catch { }
  }
  dvol[c] = sortU(pts);
}
const span = s => s && s.length ? `${new Date(s[0][0]).toISOString().slice(0, 10)} → ${new Date(s.at(-1)[0]).toISOString().slice(0, 10)} (${s.length})` : 'vide';
console.log(`DATA|fin bougies ${new Date(LAST).toISOString().slice(0, 10)}`);
console.log(`DATA|metrics BTC oi ${span(metrics.BTC.oi)} · top ${span(metrics.BTC.top)} · ADA oi ${span(metrics.ADA.oi)}`);
console.log(`DATA|funding BTC ${span(funding.BTC)} · peur/avidité ${span(fng)} · DVOL BTC ${span(dvol.BTC)} · ETH ${span(dvol.ETH)}`);

// ---------- Signaux du site (note en place), tous gardés, avec le temps où l'on décide ----------
const market = marketOf(Object.fromEntries(SYMS.map(s => [s, DATA[s].daily])));
const CFG = { ...MODES.swing, backtestBars: 1e9, allSignals: true, keepFeatures: true };
const net = x => x.r - COST * x.entry / Math.abs(x.entry - x.sl);
const sigs = [];
for (const s of SYMS) {
  const { bars, daily } = DATA[s];
  const dc = dailyContext(daily);
  const idx = new Map(bars.map((b, k) => [b.t, k]));
  for (const x of scanAsset({ symbol: s, kind: 'crypto' }, { bars, daily, market }, CFG)) {
    if (x.outcome === 'open' || x.score === null || x.score < SCORE.thr) continue;
    const T = x.time + H, sg = x.dir === 'long' ? 1 : -1, i = idx.get(x.time);
    // Dernière journée fermée
    let j = daily.findIndex(d => d.t + D > T) - 1; if (j < 0) j = daily.length - 1;
    const f = {};
    const m = metrics[s];
    const oiN = at(m.oi, T), oi1 = at(m.oi, T - D), oi7 = at(m.oi, T - 7 * D);
    f.oi1 = oiN && oi1 ? oiN / oi1 - 1 : null;
    f.oi7 = oiN && oi7 ? oiN / oi7 - 1 : null;
    const top = at(m.top, T), crowd = at(m.crowd, T);
    const topLag = at(m.top, Math.floor(T / D) * D - 1);
    f.topLag = topLag === null ? null : sg * topLag;
    f.top = top === null ? null : sg * top;                      // gros traders de notre côté (+) ou contre (−)
    f.crowd = crowd === null ? null : sg * crowd;                // foule de notre côté
    f.topVsCrowd = top === null || crowd === null ? null : sg * (top - crowd);
    const tk = meanBetween(m.taker, T - D, T);
    f.taker = tk === null ? null : sg * tk;                      // acheteurs pressés de notre côté sur 24 h
    const fu = meanBetween(funding[s], T - 7 * D, T);
    f.fund7 = fu === null ? null : sg * fu * 1e4;                // funding 7 j dans notre sens (en points de base)
    const fg = at(fng, T - D);
    f.fng = fg === null ? null : (sg > 0 ? fg : 100 - fg);       // peur/avidité « dans notre sens » (haut = foule déjà de notre côté)
    const dv = at(dvol[s === 'ETH' ? 'ETH' : 'BTC'], T - D), dv7 = at(dvol[s === 'ETH' ? 'ETH' : 'BTC'], T - 8 * D);
    f.dvol = dv;
    f.dvol7 = dv && dv7 ? dv / dv7 - 1 : null;
    f.dvolVsReal = dv && dc.vol[j] ? dv / 100 / (dc.vol[j] * Math.sqrt(365)) : null;
    // Profil de volume des 30 derniers jours (bougies 1h) : volume juste devant le prix, et part du volume derrière.
    if (i >= 720) {
      let lo = Infinity, hi = -Infinity; for (let k = i - 720; k < i; k++) { lo = Math.min(lo, bars[k].l); hi = Math.max(hi, bars[k].h); }
      const B = 60, vol = new Array(B).fill(0);
      for (let k = i - 720; k < i; k++) { const b = bars[k]; vol[Math.min(B - 1, Math.max(0, Math.floor(((b.h + b.l + b.c) / 3 - lo) / (hi - lo) * B)))] += b.v; }
      const tot = vol.reduce((a, b) => a + b, 0), mean = tot / B;
      const binOf = p => Math.min(B - 1, Math.max(0, Math.floor((p - lo) / (hi - lo) * B)));
      const e = binOf(x.entry), far = binOf(x.entry + sg * 3 * x.atr);
      let ahead = 0; for (let k = Math.min(e, far); k <= Math.max(e, far); k++) if ((k - e) * sg > 0) ahead = Math.max(ahead, vol[k] / mean);
      f.vpAhead = (x.entry - hi) * sg > 0 ? 0 : ahead;           // 0 = prix hors de la zone des 30 jours (rien devant)
      let behind = 0; for (let k = 0; k < B; k++) if ((k - e) * sg < 0) behind += vol[k];
      f.vpBehind = behind / tot;
    } else { f.vpAhead = null; f.vpBehind = null; }
    const dt = new Date(T);
    f.weekend = +(dt.getUTCDay() === 0 || dt.getUTCDay() === 6);
    f.dow = (dt.getUTCDay() + 6) % 7;
    f.monthQ = Math.floor(dt.getUTCMonth() / 3);
    f.dom = dt.getUTCDate();
    sigs.push({ ...x, T, f, rn: net(x) });
  }
}
sigs.sort((a, b) => a.time - b.time);
console.log(`SIGNAUX|bien notés ${sigs.length} (2020-24 ${sigs.filter(x => x.time < DV[1]).length}, 2025-26 ${sigs.filter(x => x.time >= TEST[0]).length})`);

// ---------- Rejouer le site : un trade à la fois par paire ----------
function replay(keep, P, sizeOf = () => 1) {
  const busy = {}; const tr = [];
  for (const x of sigs) {
    if (x.time < P[0] || x.time >= P[1]) continue;
    if (busy[x.symbol] !== undefined && x.time <= busy[x.symbol]) continue;
    const k = keep(x); if (!k) continue;
    busy[x.symbol] = x.at;
    tr.push({ ...x, w: x.sz * sizeOf(x) });
  }
  return tr;
}
function stats(tr, P) {
  const byClose = [...tr].sort((a, b) => a.at - b.at);
  let cum = 0, pk = 0, dd = 0; for (const t of byClose) { cum += t.rn * t.w; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); }
  // Capital composé à 1 % avec taille (comme le site)
  let eq = 100, ep = 100, edd = 0; const open = [];
  for (const t of [...tr].sort((a, b) => a.time - b.time)) {
    open.sort((a, b) => a.at - b.at);
    while (open.length && open[0].at <= t.time) { const c = open.shift(); eq += c.amt * c.rn; ep = Math.max(ep, eq); edd = Math.max(edd, 1 - eq / ep); }
    open.push({ at: t.at, amt: eq * 0.01 * t.w, rn: t.rn });
  }
  for (const c of open.sort((a, b) => a.at - b.at)) { eq += c.amt * c.rn; ep = Math.max(ep, eq); edd = Math.max(edd, 1 - eq / ep); }
  const yrs = (Math.min(P[1], LAST) - P[0]) / (365.25 * D);
  return { longs: tr.length ? tr.filter(t => t.dir === 'long').length / tr.length : 0, n: tr.length, totR: cum, perTr: tr.length ? cum / tr.length : 0, ddR: dd, ratio: cum / Math.max(dd, 1), wins: tr.length ? tr.filter(t => t.r > 0).length / tr.length : 0, cagr: (eq / 100) ** (1 / yrs) - 1, edd };
}
const pc = v => `${v >= 0 ? '+' : ''}${Math.round(v * 100)} %`;
const fmt = s => `${s.n} tr (${Math.round(s.longs * 100)} % achats) · ${Math.round(s.wins * 100)} % gagnants · ${s.perTr.toFixed(2)} R/tr · total ${s.totR.toFixed(0)} R · baisse ${s.ddR.toFixed(0)} R · ratio ${s.ratio.toFixed(2)} · 1 % : ${pc(s.cagr)}/an, baisse ${Math.round(s.edd * 100)} %`;

const all = () => true;
const BASE = { dev: stats(replay(all, DV), DV), test: stats(replay(all, TEST), TEST) };
console.log(`BASE|2020-24|${fmt(BASE.dev)}`);
console.log(`BASE|2025-26|${fmt(BASE.test)}`);

// Hasard : écarter une part des signaux au hasard (même part que le filtre testé), 400 tirages.
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
function randomPct(fracKept, P, value, metric) {
  const vals = [];
  for (let k = 0; k < 400; k++) { const pick = new Map(sigs.map(x => [x.id, rnd() < fracKept])); vals.push(stats(replay(x => pick.get(x.id), P), P)[metric]); }
  vals.sort((a, b) => a - b);
  return vals.filter(v => v < value).length / vals.length;
}

// ---------- Chaque donnée en filtre ----------
const FEATS = {
  topLag: 'gros traders (fichier de la veille)', oi1: 'open interest 24 h', oi7: 'open interest 7 j', top: 'gros traders de notre côté', crowd: 'foule de notre côté', topVsCrowd: 'gros traders vs foule',
  taker: 'acheteurs/vendeurs pressés 24 h', fund7: 'funding 7 j dans notre sens', fng: 'peur et avidité dans notre sens',
  dvol: 'volatilité attendue (options)', dvol7: 'volatilité attendue, variation 7 j', dvolVsReal: 'volatilité attendue / réelle',
  vpAhead: 'volume échangé juste devant le prix', vpBehind: 'part du volume derrière le prix', weekend: 'week-end', dow: 'jour de la semaine', monthQ: 'trimestre', dom: 'jour du mois',
};
const QS = [0.2, 0.33, 0.5, 0.67, 0.8];
const summary = [];
for (const [k, label] of Object.entries(FEATS)) {
  const has = x => x.f[k] !== null && x.f[k] !== undefined && Number.isFinite(x.f[k]);
  const first = sigs.find(has)?.time;
  if (!first) { console.log(`FILTRE|${k}|pas de données`); continue; }
  const dvP = [Math.max(DV[0], first), DV[1]];
  // Base sur la même période (la donnée n'existe pas avant first)
  const bDev = stats(replay(all, dvP), dvP);
  const devVals = sigs.filter(x => x.time >= dvP[0] && x.time < dvP[1] && has(x)).map(x => x.f[k]).sort((a, b) => a - b);
  if (devVals.length < 40) { console.log(`FILTRE|${k}|trop peu de signaux (${devVals.length})`); continue; }
  const cands = [];
  const uniq = [...new Set(QS.map(q => devVals[Math.floor(q * (devVals.length - 1))]))];
  for (const thr of uniq) for (const side of ['>=', '<=']) {
    const keep = x => !has(x) || (side === '>=' ? x.f[k] >= thr : x.f[k] <= thr);
    const sd = stats(replay(keep, dvP), dvP);
    if (sd.n < bDev.n * 0.3) continue;
    cands.push({ thr, side, keep, sd });
  }
  if (k === 'dow' || k === 'monthQ') for (let v = 0; v < (k === 'dow' ? 7 : 4); v++) {
    const keep = x => x.f[k] !== v; const sd = stats(replay(keep, dvP), dvP); cands.push({ thr: v, side: '!=', keep, sd });
  }
  cands.sort((a, b) => b.sd.ratio - a.sd.ratio);
  const best = cands[0];
  if (!best) continue;
  const st = stats(replay(best.keep, TEST), TEST);
  const frac = st.n / Math.max(1, BASE.test.n);
  const pctR = randomPct(Math.min(1, frac), TEST, st.ratio, 'ratio');
  // Variante : on garde tous les signaux mais on divise la taille par 2 quand la donnée est « mauvaise ».
  const half = x => (best.keep(x) ? 1 : 0.5);
  const hd = stats(replay(all, dvP, half), dvP), ht = stats(replay(all, TEST, half), TEST);
  const better = best.sd.ratio > bDev.ratio && st.ratio > BASE.test.ratio && st.perTr > BASE.test.perTr && pctR >= 0.95;
  console.log(`FILTRE|${k} (${label})|garder si ${side(best)}|depuis ${new Date(dvP[0]).toISOString().slice(0, 7)}`);
  console.log(`  réglage|base ${fmt(bDev)}`);
  console.log(`  réglage|filtre ${fmt(best.sd)}`);
  console.log(`  2025-26|filtre ${fmt(st)} | hasard : bat ${Math.round(pctR * 100)} % des tirages`);
  console.log(`  moitié taille si mauvais|réglage ratio ${hd.ratio.toFixed(2)} (base ${bDev.ratio.toFixed(2)}) · 2025-26 ${fmt(ht)}`);
  console.log(`  VERDICT|${better ? 'AIDE' : 'n’aide pas'}`);
  summary.push({ k, label, rule: side(best), devRatio: best.sd.ratio, devBase: bDev.ratio, testRatio: st.ratio, testBase: BASE.test.ratio, testPer: st.perTr, n: st.n, pctR, halfTest: ht.ratio, better });
  function side(b) { return `${k} ${b.side} ${Number(b.thr.toPrecision(3))}`; }
}
console.log('RESUME|donnée|règle|ratio réglage (base)|ratio 2025-26 (base)|R/tr 2025-26|trades|hasard|moitié taille 2025-26|verdict');
for (const s of summary) console.log(`RESUME|${s.label}|${s.rule}|${s.devRatio.toFixed(2)} (${s.devBase.toFixed(2)})|${s.testRatio.toFixed(2)} (${s.testBase.toFixed(2)})|${s.testPer.toFixed(2)}|${s.n}|${Math.round(s.pctR * 100)} %|${s.halfTest.toFixed(2)}|${s.better ? 'AIDE' : 'non'}`);

// ---------- Ce que vaut chaque donnée en moyenne (sans seuil choisi) : R moyen par tiers ----------
for (const [k, label] of Object.entries(FEATS)) {
  if (k === 'dow' || k === 'monthQ' || k === 'dom' || k === 'weekend') continue;
  const xs = sigs.filter(x => x.f[k] !== null && Number.isFinite(x.f[k]));
  if (xs.length < 60) continue;
  const v = xs.map(x => x.f[k]).sort((a, b) => a - b), q1 = v[Math.floor(v.length / 3)], q2 = v[Math.floor(2 * v.length / 3)];
  const g = (lo, hi, P) => { const z = xs.filter(x => x.f[k] >= lo && x.f[k] < hi && x.time >= P[0] && x.time < P[1]); return z.length ? `${(z.reduce((a, x) => a + x.rn, 0) / z.length).toFixed(2)} (${z.length})` : '—'; };
  console.log(`TIERS|${label}|bas <${q1.toPrecision(3)} : réglage ${g(-Infinity, q1, DV)} · 2025-26 ${g(-Infinity, q1, TEST)}|milieu : ${g(q1, q2, DV)} · ${g(q1, q2, TEST)}|haut ≥${q2.toPrecision(3)} : ${g(q2, Infinity, DV)} · ${g(q2, Infinity, TEST)}`);
}

// ---------- Labo 9b : solidité du filtre « gros traders » ----------
for (const k of ['top', 'topLag']) {
  const has = x => Number.isFinite(x.f[k]);
  const first = sigs.find(has).time, dvP = [first, DV[1]];
  const bD = stats(replay(all, dvP), dvP);
  console.log(`9B|${k}|base réglage ${fmt(bD)}`);
  for (const thr of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7]) {
    const keep = x => !has(x) || x.f[k] <= thr;
    const half = x => (keep(x) ? 1 : 0.5);
    const a = stats(replay(keep, dvP), dvP), b = stats(replay(keep, TEST), TEST), h = stats(replay(all, TEST, half), TEST), hd = stats(replay(all, dvP, half), dvP);
    console.log(`9B|${k} <= ${thr}|réglage ${fmt(a)}|2025-26 ${fmt(b)}|moitié taille : réglage ratio ${hd.ratio.toFixed(2)} ${pc(hd.cagr)}/an baisse ${Math.round(hd.edd * 100)} % · 2025-26 ratio ${h.ratio.toFixed(2)} ${pc(h.cagr)}/an baisse ${Math.round(h.edd * 100)} %`);
  }
  // Hasard à sens égal : on écarte au hasard autant d'achats et de ventes que le filtre (seuil 0,45)
  for (const P of [dvP, TEST]) {
    const keep = x => !has(x) || x.f[k] <= 0.45;
    const inP = sigs.filter(x => x.time >= P[0] && x.time < P[1]);
    const kl = inP.filter(x => x.dir === 'long'), ks = inP.filter(x => x.dir === 'short');
    const fl = kl.filter(keep).length / kl.length, fs = ks.filter(keep).length / ks.length;
    const real = stats(replay(keep, P), P).ratio; const vals = [];
    for (let r = 0; r < 400; r++) { const pick = new Map(inP.map(x => [x.id, rnd() < (x.dir === 'long' ? fl : fs)])); vals.push(stats(replay(x => pick.get(x.id), P), P).ratio); }
    console.log(`9B|${k} hasard à sens égal ${P === TEST ? '2025-26' : 'réglage'}|garde ${Math.round(fl * 100)} % des achats, ${Math.round(fs * 100)} % des ventes|bat ${Math.round(vals.filter(v => v < real).length / vals.length * 100)} % des tirages`);
  }
  // Par année, par sens
  const keep = x => !has(x) || x.f[k] <= 0.45;
  for (const y of [2021, 2022, 2023, 2024, 2025, 2026]) {
    const P = [Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1)];
    const b = stats(replay(all, P), P), f = stats(replay(keep, P), P);
    console.log(`9B|${k} ${y}|sans ${b.n} tr ${b.totR.toFixed(0)} R baisse ${b.ddR.toFixed(0)} R|avec ${f.n} tr ${f.totR.toFixed(0)} R baisse ${f.ddR.toFixed(0)} R`);
  }
  for (const d of ['long', 'short']) {
    const xs = sigs.filter(x => x.dir === d && has(x));
    const g = (c, P) => { const z = xs.filter(x => c(x) && x.time >= P[0] && x.time < P[1]); return `${z.length ? (z.reduce((a, x) => a + x.rn, 0) / z.length).toFixed(2) : '—'} (${z.length})`; };
    console.log(`9B|${k} ${d}|gros traders peu de notre côté : réglage ${g(keep, dvP)} · 2025-26 ${g(keep, TEST)}|très de notre côté : réglage ${g(x => !keep(x), dvP)} · 2025-26 ${g(x => !keep(x), TEST)}`);
  }
}

// ---------- Vrai code du site avec la règle des gros traders (valeur de 23 h UTC chaque jour) ----------
{
  const { RULES } = await import('../lib/setups.mjs');
  const gros = {};
  for (const s of SYMS) gros[s] = metrics[s].top.filter(([t]) => new Date(t).getUTCHours() === 23).map(([t, v]) => [Math.floor(t / D) * D, Math.round(Math.exp(v) * 1e4) / 1e4]);
  const mk = { ...market, gros };
  for (const mode of ['off', 'half', 'skip']) {
    const tr = SYMS.flatMap(s => scanAsset({ symbol: s, kind: 'crypto' }, { ...DATA[s], market: mk }, { ...MODES.swing, backtestBars: 1e9, grosMode: mode })).filter(x => x.outcome !== 'open').map(x => ({ ...x, rn: net(x), w: x.sz }));
    for (const [nm, P] of [['2022-24', [Date.UTC(2022, 0, 1), DV[1]]], ['2025-26', TEST]]) console.log(`SITE|${mode}|${nm}|${fmt(stats(tr.filter(x => x.time >= P[0] && x.time < P[1]), P))}`);
  }
  console.log(`SITE|seuil ${RULES.grosMax}`);
}
