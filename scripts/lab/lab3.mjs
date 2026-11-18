// Labo 3 : entrées et sorties des trades Setups. Méthode stricte : on choisit sur 2020-2024 (DEV+VAL),
// on vérifie sur 2025-2026 (TEST), on compare à des entrées au hasard. Temporaire, à supprimer avant fusion.
// Usage : node scripts/lab/lab3.mjs <dossier CSV Binance> <1h|4h>
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

// ---------- Préparation d'une paire : signaux bruts (indépendants des règles de sortie) ----------
function prepare(sym) {
  const E = load(sym, ETF), T = load(sym, '1d');
  if (E.length < 2000 || T.length < 200) return null;
  const tc = T.map(d => d.c), e20 = ema(tc, 20), e50 = ema(tc, 50), aT = atr(T);
  const trend = T.map((d, j) => j < 49 ? 0 : (d.c > e50[j] && e20[j] > e50[j]) ? 1 : (d.c < e50[j] && e20[j] < e50[j]) ? -1 : 0);
  const idx = new Map(T.map((d, k) => [d.t, k]));
  const A = atr(E), c = E.map(b => b.c), m12 = ema(c, 12), m26 = ema(c, 26), ml = m12.map((x, k) => x - m26[k]), sg = ema(ml, 9), hist = ml.map((x, k) => x - sg[k]);
  const jAt = new Int32Array(E.length); let j = -1;
  for (let i = 0; i < E.length; i++) { while (j + 1 < T.length && T[j + 1].t + T_MS <= E[i].t + E_MS) j++; jAt[i] = j; }
  const sig = []; // {i, dir, j, det, level, room}
  const dips = []; // entrées sur repli : contact de la moyenne 20 jours puis reprise
  let touched = -1e9;
  for (let i = 60; i < E.length; i++) {
    const jj = jAt[i]; if (jj < 49 || !aT[jj] || !A[i]) continue;
    const tr = trend[jj]; if (!tr) continue;
    const b = E[i], pc = E[i - 1].c;
    const hi20 = maxH(T, jj - 19, jj + 1), lo20 = minL(T, jj - 19, jj + 1);
    let det = null, level = null;
    if (tr > 0 && b.c > hi20 && pc <= hi20) { det = 'range20'; level = hi20; }
    else if (tr < 0 && b.c < lo20 && pc >= lo20) { det = 'range20'; level = lo20; }
    if (!det && i >= RB) { const h = maxH(E, i - RB, i), l = minL(E, i - RB, i); if (tr > 0 && b.c > h && pc <= h) { det = 'range10'; level = h; } else if (tr < 0 && b.c < l && pc >= l) { det = 'range10'; level = l; } }
    if (!det && i >= 35 && ((tr > 0 && hist[i - 1] <= 0 && hist[i] > 0) || (tr < 0 && hist[i - 1] >= 0 && hist[i] < 0))) { det = 'macd'; level = b.c; }
    if (det) sig.push({ i, dir: tr, j: jj, det, level, room: roomOk(tr, E, i, T, jj, A[i]) });
    // repli : le prix touche la moyenne 20 jours (dernière valeur close), puis une bougie clôture au-dessus du plus haut précédent
    const m = e20[jj];
    if (tr > 0 ? b.l <= m : b.h >= m) touched = i;
    if (i - touched <= WIN && i - touched > 0 && (tr > 0 ? b.c > E[i - 1].h && b.c > m : b.c < E[i - 1].l && b.c < m)) { dips.push({ i, dir: tr, j: jj, det: 'repli', level: b.c, room: true }); touched = -1e9; }
  }
  return { sym, E, T, aT, idx, jAt, sig, dips };
}

// ---------- Construction de la liste d'entrées pour un type d'entrée ----------
// renvoie [{i (barre d'entrée), px (prix d'entrée), dir, j, det}]
function entries(p, type) {
  const { E, sig, dips } = p;
  if (type === 'repli') return dips.map(s => ({ ...s, px: E[s.i].c, sig: s.i }));
  let list = sig;
  if (type === 'cassure') list = sig.filter(s => s.room);
  else if (type === 'sans-macd') list = sig.filter(s => s.room && s.det !== 'macd');
  else if (type === 'sans-marge') list = sig;
  else if (type === 'range20') list = sig.filter(s => s.room && s.det === 'range20');
  else if (type === 'retest') list = sig.filter(s => s.room && s.det !== 'macd');
  if (type !== 'retest') return list.map(s => ({ ...s, px: E[s.i].c, sig: s.i }));
  // retest : ordre à cours limité sur le niveau cassé, valable une journée
  const out = [];
  for (const s of list) {
    for (let k = s.i + 1; k <= Math.min(E.length - 1, s.i + WIN); k++) {
      if (s.dir > 0 ? E[k].l <= s.level : E[k].h >= s.level) { out.push({ ...s, i: k, px: s.dir > 0 ? Math.min(s.level, E[k].o) : Math.max(s.level, E[k].o), sig: s.i, sameBar: true }); break; }
    }
  }
  return out;
}

// ---------- Gestion d'un trade ----------
// V = { stopAtr, partR (0 = pas de prise partielle), partF, be, trail: 'donch'|'chand'|'tp', n, k, tpR }
function manage(p, e, V) {
  const { E, T, aT, idx } = p, s = e.dir, entry = e.px, R = V.stopAtr * aT[e.j];
  if (!(R > 0)) return null;
  let stop = entry - s * R, half = false, ext = entry;
  const tp = entry + s * V.partR * R, full = entry + s * V.tpR * R;
  const res = (k, px) => { const rest = s * (px - entry) / R; return { k, r: half ? V.partF * V.partR + (1 - V.partF) * rest : rest, R }; };
  // barre d'entrée : en retest, le stop peut être touché dans la même bougie (on compte la perte, prudent)
  if (e.sameBar && (s > 0 ? E[e.i].l <= stop : E[e.i].h >= stop)) return { k: e.i, r: -1, R };
  for (let k = e.i + 1; k < E.length; k++) {
    const b = E[k];
    if (s > 0 ? b.l <= stop : b.h >= stop) return res(k, s > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o));
    if (V.trail === 'tp' && (s > 0 ? b.h >= full : b.l <= full)) return res(k, full);
    if (V.partR && !half && (s > 0 ? b.h >= tp : b.l <= tp)) { half = true; if (V.be) stop = s > 0 ? Math.max(stop, entry) : Math.min(stop, entry); }
    ext = s > 0 ? Math.max(ext, b.h) : Math.min(ext, b.l);
    if ((b.t + E_MS) % T_MS === 0) {
      const jd = idx.get(b.t + E_MS - T_MS);
      if (jd === undefined) continue;
      if (V.trail === 'donch' && jd >= V.n) {
        const lvl = s > 0 ? minL(T, jd - V.n, jd) : maxH(T, jd - V.n, jd);
        if (s > 0 ? b.c < lvl : b.c > lvl) return res(k, b.c);
      }
      if (V.trail === 'chand' && aT[jd]) {
        const ns = ext - s * V.k * aT[jd];
        stop = s > 0 ? Math.max(stop, ns) : Math.min(stop, ns);
      }
      if (V.maxDays && (b.t - E[e.i].t) / D >= V.maxDays) return res(k, b.c);
    }
  }
  return null;
}

function run(p, list, V) {
  const out = []; let busy = -1;
  for (const e of list) {
    if (e.sig <= busy || e.i <= busy) continue;
    const f = manage(p, e, V); if (!f) break;
    const net = f.r - COST * e.px / f.R;
    out.push({ sym: p.sym, t: p.E[e.i].t, exitT: p.E[f.k].t, r: f.r, rn: net, holdH: (p.E[f.k].t - p.E[e.i].t) / H, det: e.det });
    busy = f.k;
  }
  return out;
}

function stats(tr) {
  const n = tr.length; if (!n) return null;
  const rs = tr.map(t => t.rn), mean = rs.reduce((a, b) => a + b, 0) / n;
  let eq = 0, pk = 0, dd = 0, streak = 0, ls = 0;
  for (const t of [...tr].sort((a, b) => a.exitT - b.exitT)) { eq += t.rn; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); ls = t.rn < 0 ? ls + 1 : 0; streak = Math.max(streak, ls); }
  const bs = []; for (let k = 0; k < 400; k++) { let x = 0; for (let q = 0; q < n; q++) x += rs[(Math.random() * n) | 0]; bs.push(x / n); } bs.sort((a, b) => a - b);
  const years = {}; for (const t of tr) { const y = new Date(t.t).getUTCFullYear(); years[y] = (years[y] || 0) + t.rn; }
  return { n, mean, sum: mean * n, dd, ratio: dd ? mean * n / dd : 0, win: rs.filter(r => r > 0).length / n, hold: tr.reduce((a, t) => a + t.holdH, 0) / n, streak, lo: bs[10], hi: bs[389], years };
}
const f2 = x => (x >= 0 ? '+' : '') + x.toFixed(2), f1 = x => (x >= 0 ? '+' : '') + x.toFixed(1);
const line = s => s ? `${s.n} tr | ${f2(s.mean)} R/tr [${f2(s.lo)};${f2(s.hi)}] | total ${f1(s.sum)} R | DD ${s.dd.toFixed(1)} R | gain/DD ${s.ratio.toFixed(2)} | gagnants ${(s.win * 100).toFixed(0)} % | série ${s.streak} | durée ${(s.hold / 24).toFixed(1)} j` : 'aucun';
const yrs = s => s ? Object.entries(s.years).map(([y, v]) => `${y} ${f1(v)}`).join(' · ') : '';

// ---------- Données ----------
const SYMS = [...new Set(fs.readdirSync(DIR).filter(f => f.endsWith('.csv')).map(f => f.split('-')[0]))].sort();
const PAIRS = SYMS.map(prepare).filter(Boolean);
console.log(`DATA|${ETF}/1d|${PAIRS.length} paires|${PAIRS.map(p => p.sym.replace('USDT', '')).join(' ')}`);
const cacheE = new Map();
const listFor = (p, type) => { const key = p.sym + type; if (!cacheE.has(key)) cacheE.set(key, entries(p, type)); return cacheE.get(key); };
const inP = (tr, [a, b]) => tr.filter(t => t.t >= a && t.t < b);

const BASE = { entry: 'cassure', stopAtr: 0.75, partR: 5, partF: 0.5, be: true, trail: 'donch', n: 7, k: 3, tpR: 0, maxDays: 0 };
const name = V => `${V.entry} · stop ${V.stopAtr} ATR · ${V.partR ? `${Math.round(V.partF * 100)} % à ${V.partR}R${V.be ? ' +BE' : ''}` : 'pas de partiel'} · ${V.trail === 'donch' ? `sortie ${V.n} j` : V.trail === 'chand' ? `stop suiveur ${V.k} ATR` : `objectif ${V.tpR}R`}${V.maxDays ? ` · max ${V.maxDays} j` : ''}`;
function evalV(V) {
  const all = PAIRS.flatMap(p => run(p, listFor(p, V.entry), V));
  return { V, dv: stats(inP(all, DV)), ts: stats(inP(all, TEST)), all };
}
const show = (tag, x) => { console.log(`${tag}|${name(x.V)}|2020-24 ${line(x.dv)}`); console.log(`${tag}|${name(x.V)}|2025-26 ${line(x.ts)}`); };

const base = evalV(BASE); show('BASE', base); console.log(`BASE|années ${yrs(stats(base.all))}`);

// 1) un réglage à la fois, en partant de la méthode actuelle
const AX = {
  entry: ['cassure', 'sans-macd', 'sans-marge', 'range20', 'retest', 'repli'].map(v => ({ entry: v })),
  stop: [0.5, 1, 1.5, 2].map(v => ({ stopAtr: v })),
  part: [{ partR: 0 }, { partR: 2 }, { partR: 3 }, { partR: 8 }, { partR: 3, partF: 0.33 }, { partR: 5, be: false }, { partR: 2, be: false }],
  exit: [3, 5, 10, 15, 20].map(n => ({ n })).concat([2, 3, 4].map(k => ({ trail: 'chand', k })), [2, 3, 5].map(tpR => ({ trail: 'tp', tpR, partR: 0 })), [{ maxDays: 10 }, { maxDays: 20 }]),
};
const best = {};
for (const [ax, opts] of Object.entries(AX)) {
  const rows = [base];
  for (const o of opts) { const x = evalV({ ...BASE, ...o }); rows.push(x); show(`AXE ${ax}`, x); }
  rows.sort((a, b) => (b.dv?.ratio ?? -9) - (a.dv?.ratio ?? -9));
  best[ax] = rows.slice(0, 2).map(x => x.V);
  console.log(`AXE ${ax}|meilleurs sur 2020-24 : ${rows.slice(0, 2).map(x => name(x.V)).join(' / ')}`);
}

// 2) combinaisons des 2 meilleurs réglages de chaque axe, choix sur 2020-24 uniquement
const pick = (V, ax) => ax === 'entry' ? { entry: V.entry } : ax === 'stop' ? { stopAtr: V.stopAtr } : ax === 'part' ? { partR: V.partR, partF: V.partF, be: V.be } : { trail: V.trail, n: V.n, k: V.k, tpR: V.tpR, maxDays: V.maxDays, ...(V.trail === 'tp' ? { partR: 0 } : {}) };
const combos = [];
for (const a of best.entry) for (const b of best.stop) for (const c of best.part) for (const d of best.exit) {
  const V = { ...BASE, ...pick(a, 'entry'), ...pick(b, 'stop'), ...pick(c, 'part'), ...pick(d, 'exit') };
  const key = name(V); if (combos.some(x => name(x.V) === key)) continue;
  const x = evalV(V); combos.push(x); show('COMBO', x);
}
combos.sort((a, b) => (b.dv?.ratio ?? -9) - (a.dv?.ratio ?? -9));
const win = combos[0];
console.log(`CHOIX|${name(win.V)}`);
show('CHOIX', win); console.log(`CHOIX|années ${yrs(stats(win.all))}`);
const top = combos.slice(0, 5).map(x => x.ts?.ratio ?? 0);
console.log(`CHOIX|gain/DD 2025-26 des 5 meilleurs sur 2020-24 : ${top.map(x => x.toFixed(2)).join(' ')} (méthode actuelle ${base.ts.ratio.toFixed(2)})`);

// 3) hasard : mêmes sorties, entrées tirées au hasard dans le sens de la tendance, même nombre de trades
function randomTest(V, sims = 60) {
  const res = [];
  for (let s = 0; s < sims; s++) {
    let sum = 0, n = 0;
    for (const p of PAIRS) {
      const want = inP(run(p, listFor(p, V.entry), V), TEST).length; if (!want) continue;
      const cand = []; for (let i = 60; i < p.E.length; i++) { const jj = p.jAt[i]; if (p.E[i].t >= TEST[0] && jj >= 49 && p.aT[jj]) cand.push(i); }
      const tc = p.T.map(d => d.c), e20 = ema(tc, 20), e50 = ema(tc, 50);
      const pr = want / cand.length * 1.6, list = [];
      for (const i of cand) { if (Math.random() > pr) continue; const jj = p.jAt[i], d = p.T[jj]; const dir = (d.c > e50[jj] && e20[jj] > e50[jj]) ? 1 : (d.c < e50[jj] && e20[jj] < e50[jj]) ? -1 : 0; if (dir) list.push({ i, sig: i, px: p.E[i].c, dir, j: jj }); }
      const tr = run(p, list, V).slice(0, want); for (const t of tr) { sum += t.rn; n++; }
    }
    if (n) res.push(sum / n);
  }
  return res.sort((a, b) => a - b);
}
for (const [tag, x] of [['actuelle', base], ['choisie', win]]) {
  const rnd = randomTest(x.V);
  console.log(`HASARD|${tag}|2025-26 ${f2(x.ts.mean)} R/tr | hasard médiane ${f2(rnd[rnd.length >> 1])} | 95e ${f2(rnd[Math.floor(rnd.length * 0.95)])} | centile ${(rnd.filter(v => v < x.ts.mean).length / rnd.length * 100).toFixed(0)}`);
}
// par paire (TEST)
const per = PAIRS.map(p => ({ s: p.sym, a: stats(inP(base.all.filter(t => t.sym === p.sym), TEST)), b: stats(inP(win.all.filter(t => t.sym === p.sym), TEST)) }));
console.log(`PAIRES|2025-26 total R actuelle → choisie|${per.map(x => `${x.s.replace('USDT', '')} ${f1(x.a?.sum ?? 0)}→${f1(x.b?.sum ?? 0)}`).join(' · ')}`);
console.log(`PAIRES|choisie meilleure sur ${per.filter(x => (x.b?.sum ?? 0) > (x.a?.sum ?? 0)).length}/${per.length} paires`);
