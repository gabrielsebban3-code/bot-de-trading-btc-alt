// Labo 2 : la stratégie Setups rendue générique (unité d'entrée E, unité de tendance T), pour tester
// l'intraday, l'ajout de paires et des filtres de marché, avec la méthode stricte du labo perp-setups.
// Usage : node scripts/lab/lab2.mjs <dossier CSV Binance> <mode>   mode = tf | pairs | filters
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2], MODE = process.argv[3] || 'tf';
const H = 3600_000, D = 24 * H;
const TF = { '15m': H / 4, '1h': H, '4h': 4 * H, '1d': D };
const COST = 2 * (0.0005 + 0.0003);
const DEV = [Date.UTC(2020, 0, 1), Date.UTC(2023, 0, 1)], VAL = [Date.UTC(2023, 0, 1), Date.UTC(2025, 0, 1)], TEST = [Date.UTC(2025, 0, 1), Date.UTC(2027, 0, 1)];
const PERIODS = { DEV, VAL, TEST, 'DEV+VAL': [DEV[0], VAL[1]] };

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
function adx(bars, p = 14) {
  const out = new Array(bars.length).fill(null); let tr = 0, pdm = 0, ndm = 0, ad = null;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], q = bars[i - 1];
    const up = b.h - q.h, dn = q.l - b.l;
    const t = Math.max(b.h - b.l, Math.abs(b.h - q.c), Math.abs(b.l - q.c));
    tr = tr - tr / p + t; pdm = pdm - pdm / p + (up > dn && up > 0 ? up : 0); ndm = ndm - ndm / p + (dn > up && dn > 0 ? dn : 0);
    if (i < p) continue;
    const pdi = 100 * pdm / tr, ndi = 100 * ndm / tr, dx = pdi + ndi ? 100 * Math.abs(pdi - ndi) / (pdi + ndi) : 0;
    ad = ad === null ? dx : (ad * (p - 1) + dx) / p; if (i >= 2 * p) out[i] = ad;
  }
  return out;
}
const maxH = (b, f, t) => { let m = -Infinity; for (let k = Math.max(0, f); k < t; k++) m = Math.max(m, b[k].h); return m; };
const minL = (b, f, t) => { let m = Infinity; for (let k = Math.max(0, f); k < t; k++) m = Math.min(m, b[k].l); return m; };

function trendCtx(T) {
  const c = T.map(d => d.c), e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
  const trend = T.map((d, j) => j < 49 ? 0 : (d.c > e50[j] && e20[j] > e50[j]) ? 1 : (d.c < e50[j] && e20[j] < e50[j]) ? -1 : 0);
  // efficacité du mouvement sur 20 périodes : |variation nette| / somme des |variations|
  const eff = T.map((d, j) => { if (j < 20) return null; let s = 0; for (let k = j - 19; k <= j; k++) s += Math.abs(T[k].c - T[k - 1].c); return s ? Math.abs(d.c - T[j - 20].c) / s : 0; });
  return { T, atr: atr(T), trend, e200, adx: adx(T), eff };
}

// Niveaux d'obstacle (même logique que keyLevels du site, en version générique)
function roomOk(dir, E, i, ctx, j, a, P) {
  const p = E[i].c, s = dir;
  const lv = [];
  const w = 5, depth = 120;
  for (let k = Math.max(w, i - depth); k <= i - w - 1; k++) {
    let hi = true, lo = true;
    for (let q = k - w; q <= k + w; q++) { if (q === k) continue; if (E[q].h >= E[k].h) hi = false; if (E[q].l <= E[k].l) lo = false; }
    if (hi) lv.push(E[k].h); if (lo) lv.push(E[k].l);
  }
  const T = ctx.T;
  if (j >= 0) { lv.push(T[j].h, T[j].l); if (j >= 8) { lv.push(maxH(T, j - 7, j), minL(T, j - 7, j)); } }
  const n = P.pocBars, from = Math.max(0, i - n), lo = minL(E, from, i), hi = maxH(E, from, i);
  if (hi > lo) { const vol = new Array(48).fill(0); for (let k = from; k < i; k++) { const b = E[k]; vol[Math.min(47, Math.floor(((b.h + b.l + b.c) / 3 - lo) / (hi - lo) * 48))] += b.v; } lv.push(lo + (vol.indexOf(Math.max(...vol)) + 0.5) / 48 * (hi - lo)); }
  const step = 10 ** Math.floor(Math.log10(p)) / 2;
  for (let r = Math.floor((p - 10 * a) / step) * step; r <= p + 10 * a; r += step) if (r > 0) lv.push(r);
  const first = lv.map(x => (x - p) * s).filter(d => d > 0.1 * a).sort((x, y) => x - y)[0];
  return first === undefined || first - 0.1 * a >= 2 * 1.5 * a;
}

function evalTrade(dir, entry, sl, tp, E, i, ctx, P) {
  const s = dir, R = Math.abs(entry - sl); let stop = sl, half = false;
  for (let k = i + 1; k < E.length; k++) {
    const b = E[k];
    if (s > 0 ? b.l <= stop : b.h >= stop) return { k, r: half ? (P.partialR + 0) / 2 : -1 };
    if (!half && (s > 0 ? b.h >= tp : b.l <= tp)) { half = true; stop = entry; }
    if ((b.t + P.E) % P.T === 0) {
      const jd = ctx.idx.get(b.t + P.E - P.T);
      if (jd !== undefined && jd >= P.exitN) {
        const lvl = s > 0 ? minL(ctx.T, jd - P.exitN, jd) : maxH(ctx.T, jd - P.exitN, jd);
        if (s > 0 ? b.c < lvl : b.c > lvl) { const rest = s * (b.c - entry) / R; return { k, r: half ? (P.partialR + rest) / 2 : rest }; }
      }
    }
  }
  return null;
}

// Balayage d'une paire. filter(dir, t, j) -> booléen (filtre de marché optionnel)
function scan(sym, E, ctx, P, filter = null) {
  const A = atr(E), c = E.map(b => b.c), e12 = ema(c, 12), e26 = ema(c, 26), line = e12.map((x, k) => x - e26[k]), sg = ema(line, 9), hist = line.map((x, k) => x - sg[k]);
  const out = []; let busy = -1, j = -1;
  const rb = P.rangeBars;
  for (let i = 1; i < E.length; i++) {
    while (j + 1 < ctx.T.length && ctx.T[j + 1].t + P.T <= E[i].t + P.E) j++;
    if (i <= busy || i < 60 || !A[i] || j < 49 || !ctx.atr[j]) continue;
    const tr = ctx.trend[j]; if (!tr) continue;
    const b = E[i], pc = E[i - 1].c;
    let hit = null;
    const hi20 = maxH(ctx.T, j - 19, j + 1), lo20 = minL(ctx.T, j - 19, j + 1);
    if (tr > 0 && b.c > hi20 && pc <= hi20) hit = 'range20';
    else if (tr < 0 && b.c < lo20 && pc >= lo20) hit = 'range20';
    if (!hit && i >= rb) { const h = maxH(E, i - rb, i), l = minL(E, i - rb, i); if ((tr > 0 && b.c > h && pc <= h) || (tr < 0 && b.c < l && pc >= l)) hit = 'range10'; }
    if (!hit && i >= 35 && ((tr > 0 && hist[i - 1] <= 0 && hist[i] > 0) || (tr < 0 && hist[i - 1] >= 0 && hist[i] < 0))) hit = 'macd';
    if (!hit) continue;
    if (P.room && !roomOk(tr, E, i, ctx, j, A[i], P)) continue;
    if (filter && !filter(tr, b.t, j)) continue;
    const entry = b.c, R = P.stopAtr * ctx.atr[j], sl = entry - tr * R, tp = entry + tr * P.partialR * R;
    const f = evalTrade(tr, entry, sl, tp, E, i, ctx, P);
    if (!f) break;
    out.push({ sym, t: b.t, exitT: E[f.k].t, det: hit, dir: tr, r: f.r, rn: f.r - COST * entry / R, stopPct: R / entry, holdH: (E[f.k].t - b.t) / H });
    busy = f.k;
  }
  return { trades: out, A };
}

// Entrées au hasard dans le sens de la tendance, même gestion
function randomMean(list, P, from, to, sims = 150) {
  const res = [];
  for (let s = 0; s < sims; s++) {
    let sum = 0, n = 0;
    for (const x of list) {
      const want = x.trades.filter(t => t.t >= from && t.t < to).length; if (!want) continue;
      const { E, ctx } = x; const cand = x.cand ?? (x.cand = (() => { const a = []; let j = -1; for (let i = 60; i < E.length; i++) { while (j + 1 < ctx.T.length && ctx.T[j + 1].t + P.T <= E[i].t + P.E) j++; if (j >= 49 && ctx.atr[j] && ctx.trend[j] && E[i].t >= from && E[i].t < to) a.push([i, j]); } return a; })());
      const p = want / cand.length * 1.6; let busy = -1, got = 0;
      for (const [i, j] of cand) {
        if (i <= busy || Math.random() > p) continue;
        const tr = ctx.trend[j], entry = E[i].c, R = P.stopAtr * ctx.atr[j];
        const f = evalTrade(tr, entry, entry - tr * R, entry + tr * P.partialR * R, E, i, ctx, P); if (!f) break;
        sum += f.r - COST * entry / R; n++; busy = f.k; if (++got >= want) break;
      }
    }
    if (n) res.push(sum / n);
  }
  res.sort((a, b) => a - b); return res;
}

function stats(tr) {
  const n = tr.length; if (!n) return null;
  const rs = tr.map(t => t.rn), mean = rs.reduce((a, b) => a + b, 0) / n;
  const bs = []; for (let k = 0; k < 1000; k++) { let s = 0; for (let q = 0; q < n; q++) s += rs[(Math.random() * n) | 0]; bs.push(s / n); } bs.sort((a, b) => a - b);
  let eq = 0, pk = 0, dd = 0; for (const t of [...tr].sort((a, b) => a.exitT - b.exitT)) { eq += t.rn; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const gp = rs.filter(r => r > 0).reduce((a, b) => a + b, 0), gl = -rs.filter(r => r < 0).reduce((a, b) => a + b, 0);
  const years = {}; for (const t of tr) { const y = new Date(t.t).getUTCFullYear(); years[y] = (years[y] || 0) + t.rn; }
  return { n, mean, lo: bs[25], hi: bs[974], win: rs.filter(r => r > 0).length / n, pf: gl ? gp / gl : 99, sum: mean * n, dd, cost: tr.reduce((a, t) => a + COST / t.stopPct, 0) / n, gross: tr.reduce((a, t) => a + t.r, 0) / n, hold: tr.reduce((a, t) => a + t.holdH, 0) / n, years };
}
const f3 = x => (x >= 0 ? '+' : '') + x.toFixed(3), f1 = x => (x >= 0 ? '+' : '') + x.toFixed(1);
const line = (s, extra = '') => s ? `trades ${s.n} | gagnants ${(s.win * 100).toFixed(0)} % | E[R] net ${f3(s.mean)} (brut ${f3(s.gross)}, frais ${s.cost.toFixed(3)} R) | IC95 [${f3(s.lo)} ; ${f3(s.hi)}] | PF ${s.pf.toFixed(2)} | total ${f1(s.sum)} R | DD ${s.dd.toFixed(1)} R | durée moy ${s.hold.toFixed(0)} h${extra}` : 'aucun trade';
const yrs = s => s ? Object.entries(s.years).map(([y, v]) => `${y} ${f1(v)}`).join(' · ') : '';

const SYMS = [...new Set(fs.readdirSync(DIR).filter(f => f.endsWith('.csv')).map(f => f.split('-')[0]))].sort();
const params = (e, t, stopAtr = 0.75, partialR = 5, room = true) => ({ E: TF[e], T: TF[t], rangeBars: Math.round(10 * TF[t] / TF[e]), pocBars: Math.round(30 * TF[t] / TF[e]), exitN: 7, stopAtr, partialR, room, name: `${e}/${t} stop${stopAtr} moitié${partialR}R${room ? '' : ' sans-marge'}` });

function runVariant(P, eTf, tTf, filter = null, keep = false) {
  const list = [];
  for (const sym of SYMS) {
    const E = load(sym, eTf), T = load(sym, tTf); if (E.length < 500 || T.length < 100) continue;
    const ctx = trendCtx(T); ctx.idx = new Map(T.map((d, k) => [d.t, k]));
    const { trades } = scan(sym, E, ctx, P, filter ? filter(sym, ctx) : null);
    list.push(keep ? { sym, trades, E, ctx } : { sym, trades });
  }
  return list;
}
const inP = (tr, [a, b]) => tr.filter(t => t.t >= a && t.t < b);

if (MODE === 'tf') {
  const grid = [];
  for (const [e, t] of [['4h', '1d'], ['1h', '4h'], ['15m', '1h'], ['1h', '1d']]) for (const st of [0.75, 1.5]) for (const pr of [3, 5]) grid.push([e, t, st, pr]);
  const rows = [];
  for (const [e, t, st, pr] of grid) {
    const P = params(e, t, st, pr);
    const list = runVariant(P, e, t);
    const all = list.flatMap(x => x.trades);
    const dv = stats(inP(all, PERIODS['DEV+VAL'])), ts = stats(inP(all, TEST));
    rows.push({ e, t, st, pr, P, dv, ts });
    console.log(`TF|${P.name}|DEV+VAL: ${line(dv)}`);
    console.log(`TF|${P.name}|TEST   : ${line(ts)}`);
    console.log(`TF|${P.name}|années : ${yrs(stats(all))}`);
  }
  // pour chaque couple d'unités, la variante choisie sur DEV+VAL, puis TEST et hasard
  for (const [e, t] of [['4h', '1d'], ['1h', '4h'], ['15m', '1h'], ['1h', '1d']]) {
    const best = rows.filter(r => r.e === e && r.t === t && r.dv).sort((a, b) => b.dv.mean - a.dv.mean)[0];
    const list = runVariant(best.P, e, t, null, true);
    const rnd = randomMean(list, best.P, TEST[0], TEST[1], e === '15m' ? 40 : 100);
    const pairs = list.map(x => stats(inP(x.trades, TEST))).filter(s => s && s.n >= 10);
    console.log(`CHOIX|${e}/${t}|variante gardée sur DEV+VAL : ${best.P.name}|TEST ${line(best.ts)}|hasard médiane ${f3(rnd[rnd.length >> 1])} 95e ${f3(rnd[Math.floor(rnd.length * 0.95)])} centile ${(rnd.filter(x => x < best.ts.mean).length / rnd.length * 100).toFixed(0)}|paires + ${pairs.filter(s => s.mean > 0).length}/${pairs.length}|trades/mois sur 3 paires ≈ ${(inP(list.filter(x => ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].includes(x.sym)).flatMap(x => x.trades), TEST).length / 22).toFixed(1)}`);
  }
}

if (MODE === 'pairs') {
  const P = params('4h', '1d');
  const list = runVariant(P, '4h', '1d');
  const rk = list.map(x => ({ sym: x.sym, dv: stats(inP(x.trades, PERIODS['DEV+VAL'])), ts: stats(inP(x.trades, TEST)) }));
  for (const r of rk) console.log(`PAIRE|${r.sym}|DEV+VAL ${r.dv ? `${r.dv.n} tr ${f3(r.dv.mean)}` : '-'}|TEST ${r.ts ? `${r.ts.n} tr ${f3(r.ts.mean)}` : '-'}`);
  const elig = rk.filter(r => r.dv && r.dv.n >= 15).sort((a, b) => b.dv.mean - a.dv.mean);
  const half = Math.ceil(elig.length / 2);
  const top = elig.slice(0, half), bot = elig.slice(half);
  const agg = g => stats(list.filter(x => g.some(r => r.sym === x.sym)).flatMap(x => inP(x.trades, TEST)));
  console.log(`SELECTION|moitié haute sur 2020-2024 (${top.map(r => r.sym.replace('USDT', '')).join(' ')})|TEST ${line(agg(top))}`);
  console.log(`SELECTION|moitié basse (${bot.map(r => r.sym.replace('USDT', '')).join(' ')})|TEST ${line(agg(bot))}`);
  const xs = elig.filter(r => r.ts), mx = xs.reduce((a, r) => a + r.dv.mean, 0) / xs.length, my = xs.reduce((a, r) => a + r.ts.mean, 0) / xs.length;
  const cov = xs.reduce((a, r) => a + (r.dv.mean - mx) * (r.ts.mean - my), 0), vx = xs.reduce((a, r) => a + (r.dv.mean - mx) ** 2, 0), vy = xs.reduce((a, r) => a + (r.ts.mean - my) ** 2, 0);
  console.log(`SELECTION|corrélation résultat 2020-2024 vs 2025-2026 par paire : ${(cov / Math.sqrt(vx * vy)).toFixed(2)} (${xs.length} paires)`);
  for (const k of [3, 6, 9]) { const g = elig.filter(r => !['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].includes(r.sym)).slice(0, k); console.log(`SELECTION|BTC ETH SOL + ${k} meilleures (${g.map(r => r.sym.replace('USDT', '')).join(' ')})|TEST ${line(agg([...g, ...rk.filter(r => ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].includes(r.sym))]))}|années ${yrs(agg([...g, ...rk.filter(r => ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].includes(r.sym))]))}`); }
}

if (MODE === 'filters') {
  const P = params('4h', '1d');
  const btcT = load('BTCUSDT', '1d'), btc = trendCtx(btcT); const bIdx = new Map(btcT.map((d, k) => [d.t, k]));
  const btcAt = t => { let k = bIdx.get(Math.floor(t / D) * D - D); return k ?? -1; };
  const F = {
    'aucun': null,
    'BTC du même côté de sa moyenne 200 j': () => (dir, t) => { const k = btcAt(t); return k >= 200 && dir * (btc.T[k].c - btc.e200[k]) > 0; },
    'tendance BTC dans le même sens': () => (dir, t) => { const k = btcAt(t); return k >= 0 && btc.trend[k] === dir; },
    'ADX jour de la paire > 20': () => (dir, t, j) => true && (j >= 0),
    'ADX jour de la paire > 25': () => (dir, t, j) => true,
    'mouvement efficace (> 0,3) sur 20 j': () => (dir, t, j) => true,
  };
  // les filtres qui dépendent de la paire ont besoin de son contexte
  const pairF = {
    'ADX jour de la paire > 20': (sym, ctx) => (dir, t, j) => ctx.adx[j] > 20,
    'ADX jour de la paire > 25': (sym, ctx) => (dir, t, j) => ctx.adx[j] > 25,
    'mouvement efficace (> 0,3) sur 20 j': (sym, ctx) => (dir, t, j) => ctx.eff[j] > 0.3,
  };
  for (const [name, mk] of Object.entries(F)) {
    const filt = pairF[name] ?? (mk ? () => mk() : null);
    const all = runVariant(P, '4h', '1d', filt).flatMap(x => x.trades);
    const dv = stats(inP(all, PERIODS['DEV+VAL'])), ts = stats(inP(all, TEST));
    console.log(`FILTRE|${name}|DEV+VAL ${line(dv)}`);
    console.log(`FILTRE|${name}|TEST ${line(ts)}`);
    console.log(`FILTRE|${name}|années ${yrs(stats(all))}`);
    const three = all.filter(t => ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].includes(t.sym));
    console.log(`FILTRE|${name}|BTC ETH SOL TEST ${line(stats(inP(three, TEST)))}`);
  }
}
