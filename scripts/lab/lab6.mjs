// Labo 6 : viser 3 trades gagnants sur 4 (objectif proche, stop large, prise partielle tôt, repli). Base copiée du labo 5.
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
  const sig = [], dips = []; let touched = -1e9;
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
    // repli : le prix touche la moyenne 20 jours, puis une bougie 1h clôture au-delà du plus haut (plus bas) précédent
    const m = e20[jj];
    if (tr > 0 ? b.l <= m : b.h >= m) touched = i;
    if (i - touched > 0 && i - touched <= 24 && (tr > 0 ? b.c > E[i - 1].h && b.c > m : b.c < E[i - 1].l && b.c < m)) { dips.push({ i, dir: tr, j: jj, det: 'repli', px: b.c }); touched = -1e9; }
  }
  return { sym, E, T, aT, idx, jAt, sig, dips, trend, vol, vol14, vol60 };
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


// ================= Labo 6 =================
// Gestion d'un trade : stop = stop × ATR jour ; objectif = tp R (sortie totale) ; ou prise partielle (part) puis stop au prix d'entrée
// et le reste sur la sortie 10 jours ; durée maximale maxD jours (sortie à la clôture du jour).
function manageT(p, e, V) {
  const { E, T, aT, idx } = p, s = e.dir, entry = e.px, R = V.stop * aT[e.j];
  if (!(R > 0)) return null;
  let stop = entry - s * R, took = false;
  const tgt = V.tp ? entry + s * V.tp * R : null, part = V.part ? entry + s * V.part.at * R : null;
  const res = (k, px) => { const rest = s * (px - entry) / R; return { k, r: took ? V.part.f * V.part.at + (1 - V.part.f) * rest : rest, R }; };
  for (let k = e.i + 1; k < E.length; k++) {
    const b = E[k];
    if (s > 0 ? b.l <= stop : b.h >= stop) return res(k, s > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o));
    if (tgt && (s > 0 ? b.h >= tgt : b.l <= tgt)) return res(k, s > 0 ? Math.max(tgt, b.o) : Math.min(tgt, b.o));
    if (part && !took && (s > 0 ? b.h >= part : b.l <= part)) { took = true; stop = entry + s * (V.part.lock ?? 0) * R; }
    if ((b.t + E_MS) % T_MS === 0) {
      const jd = idx.get(b.t + E_MS - T_MS);
      if (V.trail && jd !== undefined && jd >= 10) { const lvl = s > 0 ? minL(T, jd - 10, jd) : maxH(T, jd - 10, jd); if (s > 0 ? b.c < lvl : b.c > lvl) return res(k, b.c); }
      if (V.maxD && (b.t + E_MS - E[e.i].t) / D >= V.maxD) return res(k, b.c);
    }
  }
  return null;
}
function tradesV(p, V, list = null) {
  const out = []; let busy = -1;
  for (const e of list ?? (V.entry === 'repli' ? p.dips : p.sig)) {
    if (e.i <= busy) continue;
    const f = manageT(p, e, V); if (!f) break;
    out.push({ sym: p.sym, t: p.E[e.i].t, exitT: p.E[f.k].t, rn: f.r - COST * e.px / f.R, dir: e.dir, det: e.det });
    busy = f.k;
  }
  return out;
}
const nameV = V => `${V.entry} · stop ${V.stop} ATR · ${V.tp ? `objectif ${V.tp}R` : ''}${V.part ? `${Math.round(V.part.f * 100)} % à ${V.part.at}R puis stop ${V.part.lock ? `à +${V.part.lock}R` : "à l'entrée"}` : ''}${V.trail ? ' · reste sur sortie 10 j' : ''}${V.maxD ? ` · max ${V.maxD} j` : ''}`;
const winOf = (list, P) => { const x = list.filter(t => t.t >= P[0] && t.t < P[1]); const W = x.filter(t => t.rn > 0), Lo = x.filter(t => t.rn <= 0); return { n: x.length, w: W.length / x.length, r: x.reduce((a, t) => a + t.rn, 0) / x.length, worst: Math.min(...x.map(t => t.rn)), aw: W.reduce((a, t) => a + t.rn, 0) / (W.length || 1), al: Lo.reduce((a, t) => a + t.rn, 0) / (Lo.length || 1) }; };
const line6 = (list, P) => { const w = winOf(list, P), s = simulate(list, P, { risk: 1 }); return { w, s, txt: `${(w.w * 100).toFixed(0)} % gagnants | gain moyen +${w.aw.toFixed(2)} R / perte moyenne ${w.al.toFixed(2)} R | ${w.n} tr | ${w.r >= 0 ? '+' : ''}${w.r.toFixed(2)} R/tr | ${pc(s.cagr)}/an | pire baisse ${(s.dd * 100).toFixed(0)} %` }; };
const rows6 = [];
const run6 = (V, tag = 'L6') => {
  const list = site.flatMap(p => tradesV(p, V));
  const d = line6(list, DV), t = line6(list, TEST);
  console.log(`${tag}|${nameV(V)}|2020-24 ${d.txt}|2025-26 ${t.txt}`);
  const row = { V, d, t, list }; rows6.push(row); return row;
};
// référence : méthode actuelle (cassure, stop 0,75 ATR, moitié à 5R + entrée, reste sortie 10 j)
const ref6 = run6({ entry: 'cassure', stop: 0.75, part: { f: 0.5, at: 5 }, trail: true }, 'REF');
for (const entry of ['cassure', 'repli'])
  for (const stop of [0.75, 1.5, 2.5, 4])
    for (const tp of [0.25, 0.5, 1])
      for (const maxD of [5, 10]) run6({ entry, stop, tp, maxD });
for (const entry of ['cassure', 'repli'])
  for (const stop of [0.75, 1.5, 2.5])
    for (const at of [0.5, 1]) {
      run6({ entry, stop, part: { f: 0.75, at }, trail: true });
      run6({ entry, stop, part: { f: 0.75, at, lock: at / 2 }, trail: true });
    }
// choix : parmi celles à 75 % de gagnants ou plus sur 2020-24, la meilleure gain/baisse sur 2020-24
const ok75 = rows6.filter(r => r !== ref6 && r.d.w.w >= 0.75);
console.log(`L6 BILAN|${ok75.length} variantes sur ${rows6.length - 1} atteignent 75 % de gagnants sur 2020-24 ; ${ok75.filter(r => r.t.w.w >= 0.75).length} restent à 75 % en 2025-26 ; ${ok75.filter(r => r.t.s.cagr > 0).length} gagnent de l'argent en 2025-26`);
ok75.sort((a, b) => b.d.s.mar - a.d.s.mar);
for (const r of ok75.slice(0, 6)) console.log(`L6 TOP|${nameV(r.V)}|2020-24 gain/baisse ${r.d.s.mar.toFixed(2)} | 2025-26 ${r.t.txt} | gain/baisse ${r.t.s.mar.toFixed(2)} | pire trade ${r.t.w.worst.toFixed(2)} R`);
console.log(`L6 REF|méthode actuelle|2025-26 ${ref6.t.txt} | gain/baisse ${ref6.t.s.mar.toFixed(2)}`);
// le meilleur à 75 % face au hasard : mêmes sorties, entrées au hasard dans le sens de la tendance
if (ok75.length) {
  const best = ok75[0], real = best.t.w.r, sims = [];
  for (let k = 0; k < 40; k++) {
    let sum = 0, n = 0;
    for (const p of site) {
      const want = best.list.filter(t => t.sym === p.sym && t.t >= TEST[0]).length; if (!want) continue;
      const cand = []; for (let i = 60; i < p.E.length; i++) { const jj = p.jAt[i]; if (p.E[i].t >= TEST[0] && jj >= 49 && p.aT[jj] && p.trend[jj]) cand.push(i); }
      const pr = want / cand.length * 1.5, list = [];
      for (const i of cand) if (Math.random() < pr) list.push({ i, dir: p.trend[p.jAt[i]], j: p.jAt[i], px: p.E[i].c, det: 'hasard' });
      for (const t of tradesV(p, best.V, list).slice(0, want)) { sum += t.rn; n++; }
    }
    if (n) sims.push(sum / n);
  }
  sims.sort((a, b) => a - b);
  console.log(`L6 HASARD|${nameV(best.V)}|2025-26 ${real.toFixed(2)} R/tr | hasard médiane ${sims[sims.length >> 1].toFixed(2)} | mieux que ${(sims.filter(v => v < real).length / sims.length * 100).toFixed(0)} % des tirages`);
}
// le plus haut taux de gagnants qui gagne encore de l'argent sur les deux périodes
const both = rows6.filter(r => r !== ref6 && r.d.s.cagr > 0 && r.t.s.cagr > 0).sort((a, b) => b.d.w.w - a.d.w.w);
for (const r of both.slice(0, 4)) console.log(`L6 GAGNANT|${nameV(r.V)}|2020-24 ${r.d.txt}|2025-26 ${r.t.txt}`);
