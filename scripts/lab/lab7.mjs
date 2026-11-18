// Labo 7 : garder seulement les meilleurs signaux (environ 10 par mois) pour viser plus de trades gagnants et un meilleur RR. Base copiée du labo 6.
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
  return { sym, E, T, aT, idx, jAt, sig, dips, trend, vol, vol14, vol60, e20, e50, A, hist };
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

// ================= Labo 7 : sélection des meilleurs signaux =================
const MONTHS = P => (Math.min(P[1], LAST) - P[0]) / (30.44 * D);
const ALL = PAIRS.filter(p => p.T.length > 200);
// tendance de chaque paire par jour (pour BTC et « tout le marché dans le même sens »)
const TRD = new Map(ALL.map(p => [p.sym, new Map(p.T.map((d, k) => [d.t, p.trend[k]]))]));
const rsiD = p => { const c = p.T.map(d => d.c), out = new Array(c.length).fill(50); let g = 0, l = 0; for (let k = 1; k < c.length; k++) { const ch = c[k] - c[k - 1]; g = (g * 13 + Math.max(0, ch)) / 14; l = (l * 13 + Math.max(0, -ch)) / 14; out[k] = l ? 100 - 100 / (1 + g / l) : 100; } return out; };
const FEAT = ['ext50', 'gap', 'slope', 'ext20', 'volx', 'body', 'volreg', 'volabs', 'btc', 'breadth', 'fund', 'mom7', 'rsi', 'hour', 'isR20', 'isR10', 'isMacd'];
for (const p of ALL) {
  const { E, T, aT, e20, e50, A, vol, vol60 } = p, R = rsiD(p), F = FUND.get(p.sym) || [];
  for (const e of p.sig) {
    const j = e.j, s = e.dir, b = E[e.i], dt = T[j].t;
    let vs = 0; for (let q = e.i - 20; q < e.i; q++) vs += E[q].v;
    let br = 0, bn = 0; for (const q of SITE) { const m = TRD.get(q); if (m && m.has(dt)) { br += m.get(dt) * s; bn++; } }
    const fu = F.length ? fundingAvg(F, b.t) : null;
    e.f = {
      ext50: s * (T[j].c - e50[j]) / aT[j], gap: s * (e20[j] - e50[j]) / aT[j], slope: j >= 10 ? s * (e50[j] - e50[j - 10]) / aT[j] : 0,
      ext20: s * (b.c - e20[j]) / aT[j], volx: vs > 0 ? b.v / (vs / 20) : 1, body: s * (b.c - b.o) / A[e.i],
      volreg: vol[j] && vol60[j] ? vol[j] / vol60[j] : 1, volabs: vol[j] ?? 0.04,
      btc: (TRD.get('BTCUSDT')?.get(dt) ?? 0) * s, breadth: bn ? br / bn : 0, fund: fu === null ? 0 : s * fu * 1e4,
      mom7: j >= 7 && vol[j] ? s * Math.log(T[j].c / T[j - 7].c) / vol[j] : 0, rsi: s > 0 ? R[j] : 100 - R[j],
      hour: new Date(b.t).getUTCHours(), isR20: +(e.det === 'range20'), isR10: +(e.det === 'range10'), isMacd: +(e.det === 'macd'),
    };
  }
}
// sorties testées
const EXITS = [
  { k: 'A', name: 'stop 1,5 ATR · objectif 1R · max 5 j', V: { stop: 1.5, tp: 1, maxD: 5 } },
  { k: 'B', name: 'stop 2,5 ATR · objectif 1R · max 5 j', V: { stop: 2.5, tp: 1, maxD: 5 } },
  { k: 'C', name: 'stop 1 ATR · objectif 2R · max 10 j', V: { stop: 1, tp: 2, maxD: 10 } },
  { k: 'D', name: 'stop 1,5 ATR · objectif 1,5R · max 10 j', V: { stop: 1.5, tp: 1.5, maxD: 10 } },
  { k: 'E', name: '75 % à 0,5R puis stop entrée, reste sortie 10 j (stop 1,5 ATR)', V: { stop: 1.5, part: { f: 0.75, at: 0.5 }, trail: true } },
  { k: 'F', name: 'moitié à 1R puis stop entrée, reste sortie 10 j (stop 1,5 ATR)', V: { stop: 1.5, part: { f: 0.5, at: 1 }, trail: true } },
  { k: 'G', name: 'stop 2,5 ATR · objectif 0,5R · max 5 j', V: { stop: 2.5, tp: 0.5, maxD: 5 } },
  { k: 'REF', name: 'méthode actuelle', V: { stop: 0.75, part: { f: 0.5, at: 5 }, trail: true } },
];
// résultat de chaque signal pris seul (sans la règle « un trade à la fois »)
for (const p of ALL) for (const e of p.sig) { e.o = {}; for (const x of EXITS) { const f = manageT(p, e, x.V); e.o[x.k] = f ? f.r - COST * e.px / f.R : null; } }
const inP = (p, e, P) => p.E[e.i].t >= P[0] && p.E[e.i].t < P[1];
const sigsOf = (pairs, P) => pairs.flatMap(p => p.sig.filter(e => inP(p, e, P) && e.o.A !== null).map(e => ({ p, e })));

// 1) chaque critère seul : taux de gagnants par quintile (seuils fixés sur 2020-24)
const SIT = ALL.filter(p => SITE.includes(p.sym));
for (const fk of FEAT.filter(f => !f.startsWith('is'))) {
  const dv = sigsOf(SIT, DV).map(x => x.e.f[fk]).sort((a, b) => a - b), q = [0.2, 0.4, 0.6, 0.8].map(z => dv[Math.floor(z * dv.length)]);
  const bin = v => q.filter(c => v > c).length;
  const cell = (P, ek) => { const g = [[], [], [], [], []]; for (const { e } of sigsOf(SIT, P)) g[bin(e.f[fk])].push(e.o[ek]); return g.map(a => `${(a.filter(r => r > 0).length / (a.length || 1) * 100).toFixed(0)}%/${(a.reduce((s, r) => s + r, 0) / (a.length || 1)).toFixed(2)}`).join(' '); };
  console.log(`Q|${fk}|seuils ${q.map(v => v.toFixed(2)).join(' ')}|A 2020-24 ${cell(DV, 'A')}|A 2025-26 ${cell(TEST, 'A')}|REF 2020-24 ${cell(DV, 'REF')}|REF 2025-26 ${cell(TEST, 'REF')}`);
}
for (const d of ['range20', 'range10', 'macd']) {
  const c = (P, ek) => { const a = sigsOf(SIT, P).filter(x => x.e.det === d).map(x => x.e.o[ek]); return `${a.length} sig ${(a.filter(r => r > 0).length / a.length * 100).toFixed(0)}% ${(a.reduce((s, r) => s + r, 0) / a.length).toFixed(2)}R`; };
  console.log(`Q|signal ${d}|A 2020-24 ${c(DV, 'A')}|A 2025-26 ${c(TEST, 'A')}|REF 2020-24 ${c(DV, 'REF')}|REF 2025-26 ${c(TEST, 'REF')}`);
}

// 2) note par régression logistique apprise sur 2020-24 seulement, une par sortie
function fitLog(X, y, lam = 1e-2, it = 400, lr = 0.3) {
  const n = X.length, m = X[0].length, w = new Array(m + 1).fill(0);
  for (let t = 0; t < it; t++) {
    const g = new Array(m + 1).fill(0);
    for (let i = 0; i < n; i++) { let z = w[m]; for (let k = 0; k < m; k++) z += w[k] * X[i][k]; const pr = 1 / (1 + Math.exp(-z)), d = pr - y[i]; for (let k = 0; k < m; k++) g[k] += d * X[i][k]; g[m] += d; }
    for (let k = 0; k < m; k++) w[k] -= lr * (g[k] / n + lam * w[k]); w[m] -= lr * g[m] / n;
  }
  return w;
}
const hourF = h => [Math.sin(h / 24 * 2 * Math.PI), Math.cos(h / 24 * 2 * Math.PI)];
const rawX = f => [...FEAT.filter(k => k !== 'hour').map(k => f[k]), ...hourF(f.hour)];
const clip = v => Math.max(-4, Math.min(4, v));
function model(pairs, ek, target) {
  const dev = sigsOf(pairs, DV), X0 = dev.map(x => rawX(x.e.f)), m = X0[0].length;
  const mu = [], sd = []; for (let k = 0; k < m; k++) { const c = X0.map(r => r[k]); mu[k] = c.reduce((a, b) => a + b, 0) / c.length; sd[k] = Math.sqrt(c.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / c.length) || 1; }
  const z = r => r.map((v, k) => clip((v - mu[k]) / sd[k]));
  const w = fitLog(X0.map(z), dev.map(x => +(x.e.o[ek] > target)));
  return f => { const r = z(rawX(f)); let s = w[w.length - 1]; for (let k = 0; k < r.length; k++) s += w[k] * r[k]; return s; };
}
const listOf = (pairs, V, keep) => pairs.flatMap(p => tradesV(p, V, p.sig.filter(e => keep(p, e))));
const sumUp = (list, P) => { const w = winOf(list, P), s = simulate(list, P, { risk: 1 }); return { w, s, pm: w.n / MONTHS(P) }; };
const txt7 = r => `${(r.w.w * 100).toFixed(0)} % gagnants | +${r.w.aw.toFixed(2)} R / ${r.w.al.toFixed(2)} R | ${r.pm.toFixed(1)} tr/mois | ${r.w.r >= 0 ? '+' : ''}${r.w.r.toFixed(2)} R/tr | ${pc(r.s.cagr)}/an | pire baisse ${(r.s.dd * 100).toFixed(0)} %`;
// ===== Labo 7b : les deux pistes retenues, vues de plus près (9 paires du site) =====
{
  const featN = [...FEAT.filter(k => k !== 'hour'), 'heure sin', 'heure cos'];
  for (const [ek, target] of [['E', 0], ['REF', 1]]) {
    const x = EXITS.find(z => z.k === ek), sc = model(SIT, ek, target);
    const dvS = sigsOf(SIT, DV).map(o => sc(o.e.f)).sort((a, b) => b - a);
    for (const want of [10, 15, 20, 25, 30, 40]) {
      const thr = dvS[Math.min(dvS.length - 1, Math.round(want * 1.25 * MONTHS(DV)))];
      const L = listOf(SIT, x.V, (p, e) => e.o.A !== null && sc(e.f) >= thr);
      const t = sumUp(L, TEST), d = sumUp(L, DV);
      const yrs = [2020, 2021, 2022, 2023, 2024, 2025, 2026].map(y => { const w = winOf(L, [Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1)]); return `${y} ${(w.w * 100).toFixed(0)}% ${w.r >= 0 ? '+' : ''}${w.r.toFixed(2)}R`; }).join(' · ');
      const risks = [1, 2, 3].map(r => { const a = simulate(L, TEST, { risk: r }), b = simulate(L, DV, { risk: r }); return `risque ${r} % : 2020-24 ${pc(b.cagr)}/an baisse ${(b.dd * 100).toFixed(0)} % · 2025-26 ${pc(a.cagr)}/an baisse ${(a.dd * 100).toFixed(0)} %`; }).join(' | ');
      console.log(`L7B|${ek}${target ? ' gros gain' : ''} ~${want}/mois|2020-24 ${txt7(d)}|2025-26 ${txt7(t)}|${yrs}|${risks}`);
    }
  }
}
const RES = [];
for (const [uname, pairs] of [['9 paires du site', SIT], ['20 paires', ALL]]) {
  for (const x of EXITS) {
    const all = listOf(pairs, x.V, () => true);
    console.log(`L7 TOUT|${uname}|${x.k} ${x.name}|2020-24 ${txt7(sumUp(all, DV))}|2025-26 ${txt7(sumUp(all, TEST))}`);
    for (const target of x.k === 'REF' ? [0, 1] : [0]) {
      const sc = model(pairs, x.k, target);
      const dvS = sigsOf(pairs, DV).map(o => sc(o.e.f)).sort((a, b) => b - a);
      for (const want of [6, 10, 15]) {
        // seuil fixé sur 2020-24 pour garder environ « want » signaux par mois avant la règle « un trade à la fois »
        const thr = dvS[Math.min(dvS.length - 1, Math.round(want * 1.25 * MONTHS(DV)))];
        const L7 = listOf(pairs, x.V, (p, e) => e.o.A !== null && sc(e.f) >= thr);
        const d = sumUp(L7, DV), t = sumUp(L7, TEST);
        // contrôle hasard : autant de signaux pris au hasard, 100 fois, en 2025-26
        const frac = Math.min(1, t.w.n / Math.max(1, sumUp(all, TEST).w.n)), sims = [];
        for (let k = 0; k < 100; k++) { const rl = listOf(pairs, x.V, () => Math.random() < frac * 1.15); const z = winOf(rl, TEST); sims.push([z.w, z.r]); }
        const bw = sims.filter(v => v[0] < t.w.w).length, br = sims.filter(v => v[1] < t.w.r).length;
        const tag = `${x.k}${target ? ' (note visée : gros gain)' : ''} ~${want}/mois`;
        console.log(`L7 NOTE|${uname}|${tag}|2020-24 ${txt7(d)}|2025-26 ${txt7(t)}|mieux que hasard : gagnants ${bw} %, R/tr ${br} %`);
        RES.push({ uname, x, want, target, d, t, bw, br });
      }
    }
  }
}

// 3) règles simples (2 ou 3 critères) choisies sur 2020-24 pour la sortie A et REF
for (const ek of ['A', 'B', 'E', 'REF']) {
  const x = EXITS.find(z => z.k === ek), dev = sigsOf(SIT, DV), cands = [];
  for (const fk of FEAT.filter(f => !f.startsWith('is'))) {
    const v = dev.map(o => o.e.f[fk]).sort((a, b) => a - b);
    for (const z of [0.2, 0.33, 0.5, 0.67, 0.8]) { const c = v[Math.floor(z * v.length)]; cands.push({ fk, op: '>=', c }, { fk, op: '<=', c }); }
  }
  const okR = (r, f) => r.op === '>=' ? f[r.fk] >= r.c : f[r.fk] <= r.c;
  const score = rules => { const a = dev.filter(o => rules.every(r => okR(r, o.e.f))).map(o => o.e.o[ek]); return { n: a.length, w: a.filter(r => r > 0).length / (a.length || 1), r: a.reduce((s, r) => s + r, 0) / (a.length || 1) }; };
  let rules = [];
  for (let step = 0; step < 3; step++) {
    let best = null;
    for (const c of cands) { if (rules.some(r => r.fk === c.fk)) continue; const s = score([...rules, c]); if (s.n / MONTHS(DV) < 10 * 1.25) continue; const val = ek === 'REF' ? s.r : s.w + s.r / 4; if (!best || val > best.val) best = { c, val, s }; }
    if (!best) break; rules.push(best.c);
  }
  const L7 = listOf(SIT, x.V, (p, e) => rules.every(r => okR(r, e.f)));
  console.log(`L7 REGLE|${ek}|${rules.map(r => `${r.fk} ${r.op} ${r.c.toFixed(2)}`).join(' et ')}|2020-24 ${txt7(sumUp(L7, DV))}|2025-26 ${txt7(sumUp(L7, TEST))}`);
}

// bilan : variantes ≥ 75 % de gagnants sur les deux périodes, puis meilleures en gain/baisse sur 2020-24
const ok = RES.filter(r => r.d.w.w >= 0.75 && r.t.w.w >= 0.75);
console.log(`L7 BILAN|${ok.length} variantes notées à 75 % de gagnants sur les deux périodes, dont ${ok.filter(r => r.t.s.cagr > 0.1).length} à plus de +10 %/an en 2025-26`);
for (const r of [...RES].sort((a, b) => b.d.s.mar - a.d.s.mar).slice(0, 8)) console.log(`L7 TOP|${r.uname}|${r.x.k} ~${r.want}/mois${r.target ? ' gros gain' : ''}|2020-24 ${txt7(r.d)} | gain/baisse ${r.d.s.mar.toFixed(2)}|2025-26 ${txt7(r.t)} | gain/baisse ${r.t.s.mar.toFixed(2)}`);
