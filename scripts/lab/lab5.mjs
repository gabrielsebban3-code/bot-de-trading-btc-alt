// Labo 5 : réglages de portefeuille autour de la méthode Setups en ligne (1h, tendance jour, sortie 10 jours).
// Méthode stricte : choix sur 2020-2024, vérification sur 2025-2026. Temporaire, à supprimer avant fusion.
// Usage : node scripts/lab/lab5.mjs <dossier CSV Binance>
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2], ETF = process.argv[3] || '1h';
const H = 3600_000, D = 24 * H;
const TF = { '1h': H, '4h': 4 * H, '1d': D };
const COST = 2 * (0.0005 + 0.0003);
const DV = [Date.UTC(2020, 0, 1), Date.UTC(2025, 0, 1)], TEST = [Date.UTC(2025, 0, 1), Date.UTC(2027, 0, 1)];
const E_MS = TF[ETF], T_MS = D;
const RB = Math.round(10 * T_MS / E_MS), POC = Math.round(30 * T_MS / E_MS), WIN = Math.round(T_MS / E_MS);

function load(sym, tf) {
  const rows = [];
  for (const f of fs.readdirSync(DIR).filter(f => f.startsWith(`${sym}-${tf}-`) && f.endsWith('.csv')).sort()) {
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      const p = line.split(',');
      if (p.length < 6 || isNaN(+p[0])) continue;
      let t = +p[0]; if (t > 1e14) t = Math.floor(t / 1000);
      rows.push({ t, o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: +p[5] });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return rows.filter((r, k) => k === 0 || r.t !== rows[k - 1].t);
}
const ema = (vals, p) => { const k = 2 / (p + 1); let prev = null; return vals.map(v => (prev = prev === null ? v : v * k + prev * (1 - k))); };
function atr(bars, period = 14) {
  const out = new Array(bars.length).fill(null); let prev = null;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c, tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (i < period) { prev = (prev ?? 0) + tr; continue; }
    prev = i === period ? (prev + tr) / period : (prev * (period - 1) + tr) / period; out[i] = prev;
  }
  return out;
}
const maxH = (b, f, t) => { let m = -Infinity; for (let k = Math.max(0, f); k < t; k++) m = Math.max(m, b[k].h); return m; };
const minL = (b, f, t) => { let m = Infinity; for (let k = Math.max(0, f); k < t; k++) m = Math.min(m, b[k].l); return m; };

function roomOk(dir, E, i, T, j, a) {
  const p = E[i].c, s = dir, lv = [], w = 5, depth = 120;
  for (let k = Math.max(w, i - depth); k <= i - w - 1; k++) {
    let hi = true, lo = true;
    for (let q = k - w; q <= k + w; q++) { if (q === k) continue; if (E[q].h >= E[k].h) hi = false; if (E[q].l <= E[k].l) lo = false; }
    if (hi) lv.push(E[k].h); if (lo) lv.push(E[k].l);
  }
  if (j >= 0) { lv.push(T[j].h, T[j].l); if (j >= 8) lv.push(maxH(T, j - 7, j), minL(T, j - 7, j)); }
  const from = Math.max(0, i - POC), lo = minL(E, from, i), hi = maxH(E, from, i);
  if (hi > lo) { const vol = new Array(48).fill(0); for (let k = from; k < i; k++) { const b = E[k]; vol[Math.min(47, Math.floor(((b.h + b.l + b.c) / 3 - lo) / (hi - lo) * 48))] += b.v; } lv.push(lo + (vol.indexOf(Math.max(...vol)) + 0.5) / 48 * (hi - lo)); }
  const step = 10 ** Math.floor(Math.log10(p)) / 2;
  for (let r = Math.floor((p - 10 * a) / step) * step; r <= p + 10 * a; r += step) if (r > 0) lv.push(r);
  const first = lv.map(x => (x - p) * s).filter(d => d > 0.1 * a).sort((x, y) => x - y)[0];
  return first === undefined || first - 0.1 * a >= 2 * 1.5 * a;
}

// ---------- Signaux de la méthode en ligne (cassure 20 j, cassure 10 j, MACD, avec marge avant le prochain niveau) ----------
function prepare(sym) {
  const E = load(sym, ETF), T = load(sym, '1d');
  if (E.length < 2000 || T.length < 200) return null;
  const tc = T.map(d => d.c), e20 = ema(tc, 20), e50 = ema(tc, 50), aT = atr(T);
  const trend = T.map((d, j) => j < 49 ? 0 : (d.c > e50[j] && e20[j] > e50[j]) ? 1 : (d.c < e50[j] && e20[j] < e50[j]) ? -1 : 0);
  const idx = new Map(T.map((d, k) => [d.t, k]));
  const A = atr(E), c = E.map(b => b.c), m12 = ema(c, 12), m26 = ema(c, 26), ml = m12.map((x, k) => x - m26[k]), sg = ema(ml, 9), hist = ml.map((x, k) => x - sg[k]);
  const jAt = new Int32Array(E.length); let j = -1;
  for (let i = 0; i < E.length; i++) { while (j + 1 < T.length && T[j + 1].t + T_MS <= E[i].t + E_MS) j++; jAt[i] = j; }
  // volatilité réalisée 30 jours (écart-type des variations journalières)
  const volN = W => T.map((d, k) => { if (k < W + 1) return null; let s = 0, s2 = 0; for (let q = k - W + 1; q <= k; q++) { const r = Math.log(T[q].c / T[q - 1].c); s += r; s2 += r * r; } return Math.sqrt(Math.max(0, s2 / W - (s / W) ** 2)); });
  const vol = volN(30), vol14 = volN(14), vol60 = volN(60);
  const sig = [];
  for (let i = 60; i < E.length; i++) {
    const jj = jAt[i]; if (jj < 49 || !aT[jj] || !A[i]) continue;
    const tr = trend[jj]; if (!tr) continue;
    const b = E[i], pc = E[i - 1].c;
    const hi20 = maxH(T, jj - 19, jj + 1), lo20 = minL(T, jj - 19, jj + 1);
    let det = null;
    if (tr > 0 && b.c > hi20 && pc <= hi20) det = 'range20';
    else if (tr < 0 && b.c < lo20 && pc >= lo20) det = 'range20';
    if (!det && i >= RB) { const h = maxH(E, i - RB, i), l = minL(E, i - RB, i); if ((tr > 0 && b.c > h && pc <= h) || (tr < 0 && b.c < l && pc >= l)) det = 'range10'; }
    if (!det && i >= 35 && ((tr > 0 && hist[i - 1] <= 0 && hist[i] > 0) || (tr < 0 && hist[i - 1] >= 0 && hist[i] < 0))) det = 'macd';
    if (det && roomOk(tr, E, i, T, jj, A[i])) sig.push({ i, dir: tr, j: jj, det, px: b.c });
  }
  return { sym, E, T, aT, idx, jAt, sig, trend, vol, vol14, vol60 };
}

// ---------- Gestion d'un trade (règles en ligne) + renfort éventuel ----------
// add = 0 : pas de renfort ; sinon on ajoute une 2e position quand le trade atteint +add R, stop de cette 2e position au prix d'entrée du trade
function manage(p, e, add) {
  const { E, T, aT, idx } = p, s = e.dir, entry = e.px, R = 0.75 * aT[e.j];
  if (!(R > 0)) return null;
  let stop = entry - s * R, half = false;
  const tp = entry + s * 5 * R, addPx = entry + s * add * R;
  let u2 = null; // {k, px, done:{k,px}}
  const fin = (k, px) => {
    const rest = s * (px - entry) / R;
    if (u2 && !u2.done) u2.done = { k, px };
    return { k, r: half ? 0.5 * 5 + 0.5 * rest : rest, R, u2 };
  };
  for (let k = e.i + 1; k < E.length; k++) {
    const b = E[k];
    if (u2 && !u2.done && (s > 0 ? b.l <= entry : b.h >= entry)) u2.done = { k, px: s > 0 ? Math.min(entry, b.o) : Math.max(entry, b.o) };
    if (s > 0 ? b.l <= stop : b.h >= stop) return fin(k, s > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o));
    if (add && !u2 && (s > 0 ? b.h >= addPx : b.l <= addPx)) u2 = { k, px: s > 0 ? Math.max(addPx, b.o) : Math.min(addPx, b.o) };
    if (!half && (s > 0 ? b.h >= tp : b.l <= tp)) { half = true; stop = s > 0 ? Math.max(stop, entry) : Math.min(stop, entry); }
    if ((b.t + E_MS) % T_MS === 0) {
      const jd = idx.get(b.t + E_MS - T_MS);
      if (jd !== undefined && jd >= 10) {
        const lvl = s > 0 ? minL(T, jd - 10, jd) : maxH(T, jd - 10, jd);
        if (s > 0 ? b.c < lvl : b.c > lvl) return fin(k, b.c);
      }
    }
  }
  return null;
}

// liste des trades d'une paire (un seul trade ouvert à la fois par paire, comme sur le site)
function trades(p, add = 0) {
  const out = []; let busy = -1;
  for (const e of p.sig) {
    if (e.i <= busy) continue;
    const f = manage(p, e, add); if (!f) break;
    const costR = COST * e.px / f.R;
    const t = { sym: p.sym, t: p.E[e.i].t, exitT: p.E[f.k].t, rn: f.r - costR, dir: e.dir, j: e.j, det: e.det, vol: p.vol[e.j], vol14: p.vol14[e.j], vol60: p.vol60[e.j], px: e.px, R: f.R };
    if (f.u2) { const R2 = add * f.R; t.u2 = { t: p.E[f.u2.k].t, exitT: p.E[f.u2.done.k].t, rn: e.dir * (f.u2.done.px - f.u2.px) / R2 - COST * f.u2.px / R2 }; }
    out.push(t); busy = f.k;
  }
  return out;
}

// ---------- Funding (taux de financement Binance) ----------
function loadFunding(sym) {
  const rows = [];
  for (const f of fs.readdirSync(DIR).filter(f => f.startsWith(`${sym}-fundingRate-`) && f.endsWith('.csv')).sort()) {
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      const q = line.split(','); if (q.length < 3 || isNaN(+q[0])) continue;
      rows.push([+q[0], +q[2]]);
    }
  }
  return rows.sort((a, b) => a[0] - b[0]);
}
function fundingAvg(rows, t, days = 7) {
  let lo = 0, hi = rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m][0] < t) lo = m + 1; else hi = m; }
  let s = 0, n = 0; for (let k = lo - 1; k >= 0 && rows[k][0] >= t - days * D; k--) { s += rows[k][1]; n++; }
  return n ? s / n : null;
}

// ---------- Simulation du capital (intérêts composés, 100 au départ) ----------
// o : { risk (% par trade), maxOpen, maxSide, mult(t, state) → multiplicateur de risque ou 0 pour ignorer, add (risque du renfort en % ou 0) }
function simulate(list, [a, b], o) {
  const risk = o.risk ?? 1;
  const ev = [];
  for (const t of list) if (t.t >= a && t.t < b) ev.push({ time: t.t, kind: 1, t });
  ev.sort((x, y) => x.time - y.time || (x.t.sym < y.t.sym ? -1 : 1));
  const queue = [...ev]; // les fermetures sont insérées au fil de l'eau
  let eq = 100, peak = 100, dd = 0, n = 0, wins = 0;
  const open = []; const closes = []; const years = {}; let ylast = 100, ycur = null;
  const rec = [];
  const closeUntil = time => {
    closes.sort((x, y) => x.time - y.time);
    while (closes.length && closes[0].time <= time) {
      const c = closes.shift();
      eq += c.amt * c.rn; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
      rec.push(c.rn);
      if (c.main) { const id = open.indexOf(c.main); if (id >= 0) open.splice(id, 1); }
      const y = new Date(c.time).getUTCFullYear();
      if (ycur !== null && y !== ycur) { years[ycur] = eq / ylast - 1; ylast = eq; }
      ycur = y;
    }
  };
  for (const e of queue) {
    closeUntil(e.time);
    const t = e.t;
    if (o.maxOpen && open.length >= o.maxOpen) continue;
    if (o.maxSide && open.filter(x => x.dir === t.dir).length >= o.maxSide) continue;
    const m = o.mult ? o.mult(t, { eq, peak, rec }) : 1;
    if (!(m > 0)) continue;
    const amt = eq * risk / 100 * m;
    open.push(t); n++; if (t.rn > 0) wins++;
    closes.push({ time: t.exitT, amt, rn: t.rn, main: t });
    if (o.add && t.u2) closes.push({ time: t.u2.exitT, amt: eq * o.add / 100 * m, rn: t.u2.rn });
  }
  closeUntil(Infinity);
  if (ycur !== null) years[ycur] = eq / ylast - 1;
  const yrsN = (Math.min(b, LAST) - a) / (365.25 * D);
  const cagr = (eq / 100) ** (1 / yrsN) - 1;
  return { n, eq, cagr, dd, mar: dd ? cagr / dd : 0, win: n ? wins / n : 0, years, worstYear: Math.min(...Object.values(years)) };
}
const pc = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(0) + ' %';
const fmt = s => `${s.n} tr | ${pc(s.cagr)}/an | pire baisse ${(s.dd * 100).toFixed(0)} % | gain/baisse ${s.mar.toFixed(2)} | ${Object.entries(s.years).map(([y, v]) => `${y} ${pc(v)}`).join(' · ')}`;

// ---------- Données ----------
const SYMS = [...new Set(fs.readdirSync(DIR).filter(f => /-1h-/.test(f) && f.endsWith('.csv')).map(f => f.split('-')[0]))].sort();
const PAIRS = SYMS.map(prepare).filter(Boolean);
let LAST = 0; for (const p of PAIRS) LAST = Math.max(LAST, p.E[p.E.length - 1].t);
const SITE = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'LINK', 'AVAX', 'ADA'].map(s => s + 'USDT');
const FUND = new Map(PAIRS.map(p => [p.sym, loadFunding(p.sym)]));
console.log(`DATA|${PAIRS.length} paires|${PAIRS.map(p => p.sym.replace('USDT', '')).join(' ')}|funding ${[...FUND.values()].filter(r => r.length).length} paires|fin ${new Date(LAST).toISOString().slice(0, 10)}`);

const TR0 = new Map(PAIRS.map(p => [p.sym, trades(p, 0)]));
const site = PAIRS.filter(p => SITE.includes(p.sym));
const L = (pairs, map = TR0) => pairs.flatMap(p => map.get(p.sym));
const base = L(site);
const show = (tag, label, list, o) => {
  const d = simulate(list, DV, o), t = simulate(list, TEST, o);
  console.log(`${tag}|${label}|2020-24 ${fmt(d)}`);
  console.log(`${tag}|${label}|2025-26 ${fmt(t)}`);
  return { label, d, t, o, list };
};
const choose = (tag, rows) => {
  const ref = rows[0];
  const best = [...rows].sort((x, y) => y.d.mar - x.d.mar)[0];
  // contrôle hasard : on retire au hasard la même part de trades (ou on change le risque au hasard), 200 fois
  let cent = null;
  if (best !== ref && best.list.length === base.length && best.t.n < ref.t.n) {
    const frac = best.t.n / ref.t.n, sims = [];
    for (let k = 0; k < 200; k++) sims.push(simulate(base, TEST, { ...best.o, mult: () => Math.random() < frac ? 1 : 0, maxOpen: best.o.maxOpen, maxSide: best.o.maxSide }).mar);
    cent = sims.filter(v => v < best.t.mar).length / sims.length * 100;
  }
  const keep = best !== ref && best.t.mar > ref.t.mar && best.t.cagr >= ref.t.cagr * 0.9 && (cent === null || cent >= 90);
  console.log(`CHOIX ${tag}|meilleur sur 2020-24 : ${best.label}|2025-26 gain/baisse ${best.t.mar.toFixed(2)} contre ${ref.t.mar.toFixed(2)} (base), ${pc(best.t.cagr)}/an contre ${pc(ref.t.cagr)}${cent !== null ? ` | mieux que ${cent.toFixed(0)} % des tirages au hasard` : ''}|${keep ? 'TIENT' : 'NE TIENT PAS'}`);
  return { best, keep };
};

// 0) Base : 9 paires du site, 1 % par trade, sans limite
const B = show('BASE', '9 paires, 1 %/trade', base, { risk: 1 });

// 1) Risque par trade (ce n'est pas un réglage à optimiser : c'est le compromis gain / baisse)
for (const r of [0.5, 1, 1.5, 2, 3, 5]) show('RISQUE', `${r} %/trade`, base, { risk: r });

// 2) Nombre de trades ouverts en même temps, et dans le même sens
{
  const rows = [B];
  for (const mo of [2, 3, 4, 6]) rows.push(show('PLAFOND', `max ${mo} trades ouverts`, base, { risk: 1, maxOpen: mo }));
  for (const ms of [2, 3, 4]) rows.push(show('PLAFOND', `max ${ms} dans le même sens`, base, { risk: 1, maxSide: ms }));
  // à risque total égal : max N trades mais risque plus gros par trade
  for (const [mo, r] of [[3, 2], [4, 1.5], [2, 3]]) rows.push(show('PLAFOND', `max ${mo} ouverts à ${r} %`, base, { risk: r, maxOpen: mo }));
  choose('plafond', rows);
}

// 3) Taille selon la volatilité
{
  const rows = [B];
  const medVol = (() => { const v = base.filter(t => t.t < DV[1]).map(t => t.vol).filter(Boolean).sort((a, b) => a - b); return v[v.length >> 1]; })();
  for (const cap of [1.5, 2]) rows.push(show('VOLAT', `risque × vol. médiane / vol. de la paire (borné ${1 / cap}-${cap})`, base, { risk: 1, mult: t => t.vol ? Math.min(cap, Math.max(1 / cap, medVol / t.vol)) : 1 }));
  for (const cap of [1.5, 2]) rows.push(show('VOLAT', `risque × vol. de la paire / médiane (borné ${1 / cap}-${cap})`, base, { risk: 1, mult: t => t.vol ? Math.min(cap, Math.max(1 / cap, t.vol / medVol)) : 1 }));
  // volatilité du marché : BTC
  const btc = PAIRS.find(p => p.sym === 'BTCUSDT');
  const btcVol = t => { const j = btc.idx.get(Math.floor(t / D) * D - D); return j !== undefined ? btc.vol[j] : null; };
  const bv = base.filter(t => t.t < DV[1]).map(t => btcVol(t.t)).filter(Boolean).sort((a, b) => a - b), bmed = bv[bv.length >> 1];
  rows.push(show('VOLAT', 'risque réduit quand le BTC est très agité', base, { risk: 1, mult: t => { const v = btcVol(t.t); return v && v > 1.5 * bmed ? 0.5 : 1; } }));
  rows.push(show('VOLAT', 'risque réduit quand le BTC est calme', base, { risk: 1, mult: t => { const v = btcVol(t.t); return v && v < 0.7 * bmed ? 0.5 : 1; } }));
  choose('volatilité', rows);
}

// 4) Frein après pertes / accélération après gains
{
  const rows = [B];
  for (const x of [0.15, 0.25]) rows.push(show('FREIN', `risque ÷ 2 quand le capital est ${x * 100} % sous son plus haut`, base, { risk: 1, mult: (t, s) => s.eq < s.peak * (1 - x) ? 0.5 : 1 }));
  for (const nb of [20, 40]) rows.push(show('FREIN', `risque ÷ 2 si les ${nb} derniers trades perdent`, base, { risk: 1, mult: (t, s) => { const r = s.rec.slice(-nb); return r.length === nb && r.reduce((a, b) => a + b, 0) < 0 ? 0.5 : 1; } }));
  for (const nb of [20, 40]) rows.push(show('FREIN', `risque × 1,5 si les ${nb} derniers trades gagnent`, base, { risk: 1, mult: (t, s) => { const r = s.rec.slice(-nb); return r.length === nb && r.reduce((a, b) => a + b, 0) > 0 ? 1.5 : 1; } }));
  choose('frein', rows);
}

// 5) Filtre BTC pour les altcoins
{
  const rows = [B];
  const btc = PAIRS.find(p => p.sym === 'BTCUSDT');
  const btcTrend = t => { const j = btc.idx.get(Math.floor(t / D) * D - D); return j !== undefined ? btc.trend[j] : 0; };
  rows.push(show('BTC', 'altcoins seulement dans le sens de la tendance BTC', base, { risk: 1, mult: t => t.sym === 'BTCUSDT' || btcTrend(t.t) === t.dir ? 1 : 0 }));
  rows.push(show('BTC', 'altcoins à moitié de risque contre la tendance BTC', base, { risk: 1, mult: t => t.sym === 'BTCUSDT' || btcTrend(t.t) === t.dir ? 1 : 0.5 }));
  choose('btc', rows);
}

// 6) Funding
{
  const rows = [B];
  const fa = t => fundingAvg(FUND.get(t.sym) || [], t.t);
  for (const th of [0.0002, 0.0003, 0.0005]) rows.push(show('FUNDING', `ignorer les trades dans le sens de la foule (funding 7 j > ${(th * 100).toFixed(2)} %)`, base, { risk: 1, mult: t => { const f = fa(t); return f !== null && f * t.dir > th ? 0 : 1; } }));
  rows.push(show('FUNDING', 'risque × 1,5 quand la foule est contre nous (funding de sens opposé)', base, { risk: 1, mult: t => { const f = fa(t); return f !== null && f * t.dir < 0 ? 1.5 : 1; } }));
  rows.push(show('FUNDING', 'ignorer quand la foule est contre nous', base, { risk: 1, mult: t => { const f = fa(t); return f !== null && f * t.dir < 0 ? 0 : 1; } }));
  choose('funding', rows);
}

// 7) Renfort sur trade gagnant
{
  const rows = [B];
  for (const add of [2, 3]) {
    const map = new Map(PAIRS.map(p => [p.sym, trades(p, add)]));
    for (const r2 of [0.5, 1]) rows.push(show('RENFORT', `ajout à +${add}R, risque ${r2} %`, L(site, map), { risk: 1, add: r2 }));
  }
  choose('renfort', rows);
}

// 8) Choix des paires parmi les 20 (sans regarder l'avenir : chaque 1er janvier, on garde les meilleures des 2 années passées)
{
  const all = L(PAIRS);
  const rows = [B, show('PAIRES', `les ${PAIRS.length} paires`, all, { risk: 1 })];
  const sumR = (sym, a, b) => (TR0.get(sym) || []).filter(t => t.exitT >= a && t.exitT < b).reduce((s, t) => s + t.rn, 0);
  for (const K of [5, 9, 12]) {
    const pickYear = new Map();
    for (let y = 2021; y <= 2026; y++) {
      const a = Date.UTC(y - 1, 0, 1), b = Date.UTC(y, 0, 1);
      const elig = PAIRS.filter(p => p.E[0].t <= a + 90 * D);
      pickYear.set(y, new Set(elig.map(p => [p.sym, sumR(p.sym, a, b)]).sort((x, y2) => y2[1] - x[1]).slice(0, K).map(x => x[0])));
    }
    rows.push(show('PAIRES', `${K} meilleures paires de l'année passée`, all, { risk: 1, mult: t => { const s = pickYear.get(new Date(t.t).getUTCFullYear()); return s && s.has(t.sym) ? 1 : 0; } }));
  }
  choose('paires', rows);
  // paire par paire sur 2025-26 (en R)
  console.log(`PAIRES|2025-26 total R par paire|${PAIRS.map(p => `${p.sym.replace('USDT', '')} ${(TR0.get(p.sym).filter(t => t.t >= TEST[0]).reduce((s, t) => s + t.rn, 0)).toFixed(1)}`).join(' · ')}`);
}

// 9b) Sens des trades (pour savoir si un filtre ne fait que garder les achats)
show('SENS', 'achats seulement', base.filter(t => t.dir > 0), { risk: 1 });
show('SENS', 'ventes seulement', base.filter(t => t.dir < 0), { risk: 1 });

// 9) Par type de signal
{
  const rows = [B];
  for (const d of ['range20', 'range10', 'macd']) rows.push(show('SIGNAL', `sans ${d}`, base.filter(t => t.det !== d), { risk: 1 }));
  choose('signal', rows);
}

// ---------- 10) Vérifications des deux réglages qui tiennent ----------
{
  const med = (list, k) => { const v = list.filter(t => t.t < DV[1]).map(t => t[k]).filter(Boolean).sort((a, b) => a - b); return v[v.length >> 1]; };
  const inv = (list, k = 'vol', cap = 2) => { const m = med(list, k); return t => t[k] ? Math.min(cap, Math.max(1 / cap, m / t[k])) : 1; };
  const R = (tag, label, list, o) => show('ROBUSTE ' + tag, label, list, o);
  // a) fenêtre de volatilité : le résultat ne doit pas dépendre d'un seul réglage
  for (const k of ['vol14', 'vol', 'vol60']) R('fenêtre', `taille inverse à la volatilité ${k === 'vol' ? 30 : k.slice(3)} j`, base, { risk: 1, mult: inv(base, k) });
  // b) contrôle hasard : on mélange les mêmes multiplicateurs entre les trades (200 fois)
  const ctrlMix = (list, o, P) => {
    const f = o.mult, mults = list.map(f), real = simulate(list, P, o).mar, sims = [];
    for (let k = 0; k < 200; k++) { const sh = [...mults].sort(() => Math.random() - 0.5), m = new Map(list.map((t, q) => [t, sh[q]])); sims.push(simulate(list, P, { ...o, mult: t => m.get(t) }).mar); }
    return sims.filter(v => v < real).length / 2;
  };
  const oV = { risk: 1, mult: inv(base) };
  console.log(`ROBUSTE hasard|taille selon la volatilité mieux que ${ctrlMix(base, oV, DV).toFixed(0)} % des mélanges (2020-24), ${ctrlMix(base, oV, TEST).toFixed(0)} % (2025-26)`);
  // c) contrôle hasard pour « sans MACD » : retirer au hasard le même nombre de trades
  const noM = base.filter(t => t.det !== 'macd');
  const ctrlDrop = P => { const real = simulate(noM, P, { risk: 1 }).mar, frac = noM.length / base.length, sims = []; for (let k = 0; k < 200; k++) sims.push(simulate(base.filter(() => Math.random() < frac), P, { risk: 1 }).mar); return sims.filter(v => v < real).length / 2; };
  console.log(`ROBUSTE hasard|sans MACD mieux que ${ctrlDrop(DV).toFixed(0)} % des retraits au hasard (2020-24), ${ctrlDrop(TEST).toFixed(0)} % (2025-26)`);
  // d) gain moyen par type de signal, en R, sur les 20 paires
  const all = L(PAIRS);
  for (const d of ['range20', 'range10', 'macd']) for (const [P, nm] of [[DV, '2020-24'], [TEST, '2025-26']]) {
    for (const [lst, u] of [[base, '9 paires'], [all, '20 paires']]) { const x = lst.filter(t => t.det === d && t.t >= P[0] && t.t < P[1]); console.log(`ROBUSTE signal|${d}|${nm}|${u}|${x.length} tr | ${(x.reduce((a, t) => a + t.rn, 0) / x.length).toFixed(2)} R/trade`); }
  }
  // e) mêmes réglages sur les 20 paires
  R('20 paires', 'base', all, { risk: 1 });
  R('20 paires', 'taille selon la volatilité', all, { risk: 1, mult: inv(all) });
  R('20 paires', 'sans MACD', all.filter(t => t.det !== 'macd'), { risk: 1 });
  R('20 paires', 'les deux', all.filter(t => t.det !== 'macd'), { risk: 1, mult: inv(all) });
  // f) combinaison sur les 9 paires du site, et niveaux de risque
  for (const r of [0.5, 0.75, 1]) R('combo', `9 paires, sans MACD + taille selon la volatilité, ${r} %`, noM, { risk: r, mult: inv(base) });
  R('combo', '9 paires, taille selon la volatilité seule, 0.75 %', base, { risk: 0.75, mult: inv(base) });
  // g) pour le site : multiplicateur par paire (médiane de sa volatilité 2020-24 → idée du réglage fixe par paire)
  const per = site.map(p => { const v = TR0.get(p.sym).filter(t => t.t < DV[1]).map(t => t.vol).filter(Boolean).sort((a, b) => a - b); return [p.sym, v[v.length >> 1]]; });
  const m0 = med(base.filter(t => t.t < DV[1]), 'vol');
  console.log(`ROBUSTE paires|multiplicateur moyen par paire|${per.map(([s2, v]) => `${s2.replace('USDT', '')} ×${Math.min(2, Math.max(0.5, m0 / v)).toFixed(2)}`).join(' · ')}`);
  const fixed = new Map(per.map(([s2, v]) => [s2, Math.min(2, Math.max(0.5, m0 / v))]));
  R('combo', '9 paires, multiplicateur fixe par paire (calé sur 2020-24)', base, { risk: 1, mult: t => fixed.get(t.sym) });
}

// ---------- 11) Chiffres pour la bêta ----------
{
  const v = base.filter(t => t.t < DV[1]).map(t => t.vol).filter(Boolean).sort((a, b) => a - b), ref = v[v.length >> 1];
  console.log(`BETA|volatilité de référence (médiane 30 j, 2020-24) = ${ref.toFixed(5)}`);
  const mult = t => t.vol ? Math.min(2, Math.max(0.5, ref / t.vol)) : 1;
  const ts = base.filter(t => t.t >= TEST[0]);
  const ms = ts.map(mult);
  console.log(`BETA|multiplicateur 2025-26 : moyenne ${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(2)} | ×0,5 ${ms.filter(m => m <= 0.5).length} | ×2 ${ms.filter(m => m >= 2).length} | <0,8 ${ms.filter(m => m < 0.8).length} | >1,25 ${ms.filter(m => m > 1.25).length} sur ${ms.length}`);
  for (const r of [0.5, 0.75, 1]) {
    const d = simulate(base, DV, { risk: r, mult }), t = simulate(base, TEST, { risk: r, mult }), f = simulate(base, TEST, { risk: r });
    const perT = ts.reduce((a, x) => a + x.rn * r * mult(x), 0) / ts.length;
    console.log(`BETA|base ${r} %|2025-26 avec taille : ${pc(t.cagr)}/an, pire baisse ${(t.dd * 100).toFixed(0)} %, ${perT.toFixed(2)} % du capital par trade en moyenne | sans taille : ${pc(f.cagr)}/an, pire baisse ${(f.dd * 100).toFixed(0)} % | 2020-24 avec taille : ${pc(d.cagr)}/an, pire baisse ${(d.dd * 100).toFixed(0)} %`);
  }
}
