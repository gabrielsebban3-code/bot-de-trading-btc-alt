// Labo 4 : concepts intraday (bougies 1h, trade fermé dans la journée ou presque). Temporaire, à supprimer avant fusion.
// Méthode : réglages choisis sur 2020-2024, vérifiés sur 2025-2026, frais 0,16 % aller-retour, comparés à des
// entrées au hasard (même sens, même stop, même durée). Usage : node scripts/lab/lab4.mjs <dossier CSV Binance>
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];
const H = 3600_000, D = 24 * H;
const COST = 2 * (0.0005 + 0.0003);       // ordres au marché
const COST_MAKER = 2 * (0.0002 + 0.0001);  // ordres limites (pas toujours exécutés : borne optimiste)
const DV = [Date.UTC(2020, 0, 1), Date.UTC(2025, 0, 1)], TEST = [Date.UTC(2025, 0, 1), Date.UTC(2027, 0, 1)];

function loadCsv(sym, tf) {
  const rows = [];
  for (const f of fs.readdirSync(DIR).filter(f => f.startsWith(`${sym}-${tf}-`) && f.endsWith('.csv')).sort()) {
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      const p = line.split(',');
      if (p.length < 6 || isNaN(+p[0])) continue;
      let t = +p[0]; if (t > 1e14) t = Math.floor(t / 1000);
      rows.push({ t, o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: +p[5], qv: +p[7] || 0 });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return rows.filter((r, k) => k === 0 || r.t !== rows[k - 1].t);
}
function loadFunding(sym) {
  const out = [];
  for (const f of fs.readdirSync(DIR).filter(f => f.startsWith(`${sym}-fundingRate-`) && f.endsWith('.csv')).sort()) {
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      const p = line.split(','); if (p.length < 3 || isNaN(+p[0])) continue;
      out.push({ t: Math.round(+p[0] / H) * H, f: +p[p.length - 1] });
    }
  }
  return out.sort((a, b) => a.t - b.t);
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
function rsi(c, p) {
  const out = new Array(c.length).fill(null); let up = 0, dn = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    if (i <= p) { up += Math.max(d, 0); dn += Math.max(-d, 0); if (i === p) { up /= p; dn /= p; out[i] = dn ? 100 - 100 / (1 + up / dn) : 100; } continue; }
    up = (up * (p - 1) + Math.max(d, 0)) / p; dn = (dn * (p - 1) + Math.max(-d, 0)) / p; out[i] = dn ? 100 - 100 / (1 + up / dn) : 100;
  }
  return out;
}
const sma = (c, p) => c.map((_, i) => { if (i < p - 1) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) s += c[k]; return s / p; });

// ---------- Préparation ----------
function prepare(sym) {
  const E = loadCsv(sym, '1h'), T = loadCsv(sym, '1d');
  if (E.length < 5000 || T.length < 200) return null;
  const tc = T.map(d => d.c), e20 = ema(tc, 20), e50 = ema(tc, 50);
  const trendT = T.map((d, j) => j < 49 ? 0 : (d.c > e50[j] && e20[j] > e50[j]) ? 1 : (d.c < e50[j] && e20[j] < e50[j]) ? -1 : 0);
  const c = E.map(b => b.c), A = atr(E), R2 = rsi(c, 2), S5 = sma(c, 5), S20 = sma(c, 20);
  const trend = new Int8Array(E.length); let j = -1;
  for (let i = 0; i < E.length; i++) { while (j + 1 < T.length && T[j + 1].t + D <= E[i].t + H) j++; trend[i] = j >= 0 ? trendT[j] : 0; }
  // VWAP ancré à 00 h UTC
  const vwap = new Array(E.length).fill(null); let pv = 0, vv = 0;
  for (let i = 0; i < E.length; i++) { const b = E[i]; if (b.t % D === 0) { pv = 0; vv = 0; } const tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v; vwap[i] = vv ? pv / vv : null; }
  const fund = loadFunding(sym), fAt = new Map(fund.map(x => [x.t, x.f]));
  const idx = new Map(E.map((b, k) => [b.t, k]));
  return { sym, E, A, R2, S5, S20, trend, vwap, fund, fAt, idx };
}

// ---------- Simulation d'un trade ----------
// sortie : stop (prioritaire dans la même bougie), objectif, condition de sortie, ou clôture après maxBars
function sim(p, i, dir, stopDist, { target = null, maxBars = 24, exitIf = null } = {}) {
  const { E } = p, s = dir, entry = E[i].c, stop = entry - s * stopDist, tp = target;
  for (let k = i + 1; k < Math.min(E.length, i + 1 + maxBars); k++) {
    const b = E[k];
    if (s > 0 ? b.l <= stop : b.h >= stop) return { k, px: s > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o) };
    if (tp !== null && (s > 0 ? b.h >= tp : b.l <= tp)) return { k, px: s > 0 ? Math.max(tp, b.o) : Math.min(tp, b.o) };
    if (exitIf && exitIf(k)) return { k, px: b.c };
  }
  const k = Math.min(E.length - 1, i + maxBars); return k > i ? { k, px: E[k].c } : null;
}
function mk(p, i, dir, stopDist, f) {
  const e = p.E[i].c, r = dir * (f.px - e) / stopDist;
  return { sym: p.sym, t: p.E[i].t, i, k: f.k, dir, stopDist, bars: f.k - i, r, rn: r - COST * e / stopDist, rm: r - COST_MAKER * e / stopDist, ret: dir * (f.px - e) / e };
}

// ---------- Concepts ----------
const CONCEPTS = {
  // A. Cassure du range d'ouverture d'une session (Asie 0 h, Europe 7 h, US 13 h UTC)
  orb: {
    grid: () => { const g = []; for (const S of [0, 7, 13]) for (const N of [1, 2, 3]) for (const filt of ['tendance', 'les deux sens']) for (const tgt of [0, 2]) g.push({ S, N, filt, tgt }); return g; },
    name: v => `ouverture ${({ 0: 'Asie', 7: 'Europe', 13: 'US' })[v.S]} · range ${v.N} h · ${v.filt} · ${v.tgt ? `objectif ${v.tgt}R` : 'fin de session'}`,
    run(p, v) {
      const { E } = p, out = [];
      for (let i = 0; i < E.length - 12; i++) {
        if (new Date(E[i].t).getUTCHours() !== v.S || E[i].t % H) continue;
        const r0 = i, r1 = i + v.N; if (r1 >= E.length) break;
        let hi = -Infinity, lo = Infinity; for (let k = r0; k < r1; k++) { hi = Math.max(hi, E[k].h); lo = Math.min(lo, E[k].l); }
        const end = i + 8;
        for (let k = r1; k < Math.min(end, E.length - 1); k++) {
          const d = E[k].c > hi ? 1 : E[k].c < lo ? -1 : 0; if (!d) continue;
          if (v.filt === 'tendance' && p.trend[k] !== d) break;
          const sd = d > 0 ? E[k].c - lo : hi - E[k].c; if (!(sd > 0)) break;
          const f = sim(p, k, d, sd, { target: v.tgt ? E[k].c + d * v.tgt * sd : null, maxBars: end - k }); if (f) out.push(mk(p, k, d, sd, f));
          break;
        }
        i = end - 1;
      }
      return out;
    },
  },
  // B. Retour à la moyenne : RSI 2 périodes très bas (haut), dans le sens de la tendance jour ou non
  rsi2: {
    grid: () => { const g = []; for (const x of [5, 10, 20]) for (const k of [1.5, 3]) for (const filt of ['tendance', 'les deux sens']) g.push({ x, k, filt }); return g; },
    name: v => `RSI 2 < ${v.x} (> ${100 - v.x}) · stop ${v.k} ATR 1h · ${v.filt} · sortie au-dessus de la moyenne 5 h`,
    run(p, v) {
      const { E, A, R2, S5 } = p, out = []; let busy = -1;
      for (let i = 30; i < E.length - 1; i++) {
        if (i <= busy || !A[i] || R2[i] === null) continue;
        const d = R2[i] < v.x ? 1 : R2[i] > 100 - v.x ? -1 : 0; if (!d) continue;
        if (v.filt === 'tendance' && p.trend[i] !== d) continue;
        const f = sim(p, i, d, v.k * A[i], { maxBars: 24, exitIf: k => d > 0 ? E[k].c > S5[k] : E[k].c < S5[k] }); if (!f) break;
        out.push(mk(p, i, d, v.k * A[i], f)); busy = f.k;
      }
      return out;
    },
  },
  // C. Écart au VWAP du jour : retour vers le VWAP
  vwap: {
    grid: () => { const g = []; for (const dev of [1.5, 2.5, 3.5]) for (const k of [1, 2]) for (const filt of ['tendance', 'les deux sens']) g.push({ dev, k, filt }); return g; },
    name: v => `écart au VWAP > ${v.dev} ATR 1h · stop ${v.k} ATR · ${v.filt} · objectif VWAP`,
    run(p, v) {
      const { E, A, vwap } = p, out = []; let busy = -1;
      for (let i = 30; i < E.length - 1; i++) {
        if (i <= busy || !A[i] || vwap[i] === null || new Date(E[i].t).getUTCHours() < 3) continue;
        const dev = (E[i].c - vwap[i]) / A[i], d = dev < -v.dev ? 1 : dev > v.dev ? -1 : 0; if (!d) continue;
        if (v.filt === 'tendance' && p.trend[i] !== d) continue;
        const dayEnd = Math.floor(E[i].t / D) * D + D, mb = Math.max(1, Math.round((dayEnd - E[i].t) / H) - 1);
        const f = sim(p, i, d, v.k * A[i], { target: vwap[i], maxBars: mb }); if (!f) break;
        out.push(mk(p, i, d, v.k * A[i], f)); busy = f.k;
      }
      return out;
    },
  },
  // D. Heures de la journée : on tient 1 à 3 heures précises, choisies sur 2020-2024 (toutes paires confondues)
  heures: {
    grid: () => [{ n: 1, hold: 1 }, { n: 3, hold: 1 }, { n: 1, hold: 3 }, { n: 2, hold: 2 }],
    name: v => `les ${v.n} meilleures et pires heures de 2020-2024 · tenir ${v.hold} h`,
    prepAll(pairs, v) {
      const m = Array.from({ length: 24 }, () => ({ s: 0, n: 0 }));
      for (const p of pairs) for (let i = 1; i + v.hold < p.E.length; i++) { const t = p.E[i].t; if (t < DV[0] || t >= DV[1]) continue; const h = new Date(t).getUTCHours(); m[h].s += (p.E[i + v.hold - 1].c - p.E[i - 1].c) / p.E[i - 1].c; m[h].n++; }
      const ord = m.map((x, h) => ({ h, r: x.n ? x.s / x.n : 0 })).sort((a, b) => b.r - a.r);
      v.longH = ord.slice(0, v.n).map(x => x.h); v.shortH = ord.slice(-v.n).map(x => x.h);
      v.label = `achat ${v.longH.join(',')} h · vente ${v.shortH.join(',')} h UTC`;
    },
    run(p, v) {
      const { E, A } = p, out = []; let busy = -1;
      for (let i = 30; i + v.hold < E.length; i++) {
        if (i <= busy || !A[i]) continue;
        const h = new Date(E[i].t + H).getUTCHours(); // on entre à la clôture de i, donc pendant l'heure suivante
        const d = v.longH.includes(h) ? 1 : v.shortH.includes(h) ? -1 : 0; if (!d) continue;
        const f = sim(p, i, d, 2 * A[i], { maxBars: v.hold }); if (!f) break;
        out.push(mk(p, i, d, 2 * A[i], f)); busy = f.k;
      }
      return out;
    },
  },
  // E. Funding extrême : contre la foule (ou avec elle), tenu 8 h
  funding: {
    grid: () => { const g = []; for (const q of [0.9, 0.95, 0.99]) for (const side of ['contre la foule', 'avec la foule']) for (const k of [1.5, 3]) g.push({ q, side, k }); return g; },
    name: v => `funding au-delà du centile ${Math.round(v.q * 100)} des 90 derniers jours · ${v.side} · stop ${v.k} ATR 1h · tenir 8 h`,
    run(p, v) {
      const { E, A, fund, idx } = p, out = []; let busy = -1;
      for (let n = 270; n < fund.length; n++) {
        const win = fund.slice(n - 270, n).map(x => x.f).sort((a, b) => a - b);
        const hi = win[Math.floor(win.length * v.q)], lo = win[Math.floor(win.length * (1 - v.q))];
        const f0 = fund[n].f; let d = f0 > hi && f0 > 0 ? -1 : f0 < lo && f0 < 0 ? 1 : 0; if (!d) continue;
        if (v.side === 'avec la foule') d = -d;
        const i = idx.get(fund[n].t - H); if (i === undefined || i <= busy || !A[i]) continue;
        const f = sim(p, i, d, v.k * A[i], { maxBars: 8 }); if (!f) continue;
        out.push(mk(p, i, d, v.k * A[i], f)); busy = f.k;
      }
      return out;
    },
  },
};

// ---------- Statistiques ----------
function stats(tr, key = 'rn') {
  const n = tr.length; if (!n) return null;
  const rs = tr.map(t => t[key]), mean = rs.reduce((a, b) => a + b, 0) / n;
  let eq = 0, pk = 0, dd = 0; for (const t of [...tr].sort((a, b) => a.t - b.t)) { eq += t[key]; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const bs = []; for (let k = 0; k < 300; k++) { let x = 0; for (let q = 0; q < n; q++) x += rs[(Math.random() * n) | 0]; bs.push(x / n); } bs.sort((a, b) => a - b);
  const years = {}; for (const t of tr) { const y = new Date(t.t).getUTCFullYear(); years[y] = (years[y] || 0) + t[key]; }
  const gross = tr.reduce((a, t) => a + t.r, 0) / n, cost = tr.reduce((a, t) => a + (t.r - t.rn), 0) / n;
  return { n, mean, lo: bs[7], hi: bs[292], sum: mean * n, dd, win: rs.filter(r => r > 0).length / n, gross, cost, bars: tr.reduce((a, t) => a + t.bars, 0) / n, ret: tr.reduce((a, t) => a + t.ret, 0) / n, years };
}
const f2 = x => (x >= 0 ? '+' : '') + x.toFixed(2), f1 = x => (x >= 0 ? '+' : '') + x.toFixed(1);
const line = s => s ? `${s.n} tr | net ${f2(s.mean)} R/tr [${f2(s.lo)};${f2(s.hi)}] (brut ${f2(s.gross)}, frais ${s.cost.toFixed(2)} R) | mouvement moyen ${(s.ret * 100).toFixed(3)} % vs frais 0,16 % | total ${f1(s.sum)} R | DD ${s.dd.toFixed(1)} R | gagnants ${(s.win * 100).toFixed(0)} % | durée ${s.bars.toFixed(1)} h` : 'aucun';
const yrs = s => s ? Object.entries(s.years).map(([y, v]) => `${y} ${f1(v)}`).join(' · ') : '';
const inP = (tr, [a, b]) => tr.filter(t => t.t >= a && t.t < b);

// hasard : pour chaque trade, une autre heure au hasard de la même période et de la même paire, même sens, même stop en ATR, même durée max
function randomTest(pairs, trades, sims = 40) {
  const byP = new Map(pairs.map(p => [p.sym, p])), res = [];
  for (let s = 0; s < sims; s++) {
    let sum = 0, n = 0;
    for (const t of trades) {
      const p = byP.get(t.sym), lo = p.idx.get(Math.max(TEST[0], p.E[30].t)) ?? 30, i = lo + Math.floor(Math.random() * (p.E.length - lo - 30));
      if (!p.A[i] || !p.A[t.i]) continue;
      const sd = t.stopDist / p.A[t.i] * p.A[i], f = sim(p, i, t.dir, sd, { maxBars: Math.max(1, t.bars) }); if (!f) continue;
      sum += mk(p, i, t.dir, sd, f).rn; n++;
    }
    if (n) res.push(sum / n);
  }
  return res.sort((a, b) => a - b);
}

// ---------- Exécution ----------
const SYMS = [...new Set(fs.readdirSync(DIR).filter(f => f.includes('-1h-')).map(f => f.split('-')[0]))].sort();
const PAIRS = SYMS.map(prepare).filter(Boolean);
console.log(`DATA|${PAIRS.length} paires|funding : ${PAIRS.filter(p => p.fund.length).length} paires`);
const summary = [];
for (const [cn, C] of Object.entries(CONCEPTS)) {
  const rows = [];
  for (const v of C.grid()) {
    if (C.prepAll) C.prepAll(PAIRS, v);
    const all = PAIRS.flatMap(p => C.run(p, v));
    const dv = stats(inP(all, DV)), ts = stats(inP(all, TEST));
    const nm = C.name(v) + (v.label ? ` (${v.label})` : '');
    console.log(`${cn}|${nm}|2020-24 ${line(dv)}`);
    console.log(`${cn}|${nm}|2025-26 ${line(ts)}`);
    rows.push({ v, nm, all, dv, ts });
  }
  const ok = rows.filter(r => r.dv && r.dv.n >= 200).sort((a, b) => b.dv.mean - a.dv.mean);
  if (!ok.length) { console.log(`CHOIX|${cn}|aucune variante avec assez de trades`); continue; }
  const w = ok[0], tsT = inP(w.all, TEST), rnd = randomTest(PAIRS, tsT);
  const perPair = PAIRS.map(p => stats(tsT.filter(t => t.sym === p.sym))).filter(s => s && s.n >= 10);
  const mk2 = stats(tsT, 'rm');
  console.log(`CHOIX|${cn}|${w.nm}`);
  console.log(`CHOIX|${cn}|2020-24 ${line(w.dv)}`);
  console.log(`CHOIX|${cn}|2025-26 ${line(w.ts)}`);
  console.log(`CHOIX|${cn}|2025-26 avec ordres limites (frais 0,06 %) : ${mk2 ? f2(mk2.mean) : '-'} R/tr | paires positives ${perPair.filter(s => s.mean > 0).length}/${perPair.length} | hasard médiane ${f2(rnd[rnd.length >> 1] ?? 0)} · 95e ${f2(rnd[Math.floor(rnd.length * 0.95)] ?? 0)} · centile ${(rnd.filter(x => x < (w.ts?.mean ?? -9)).length / Math.max(1, rnd.length) * 100).toFixed(0)}`);
  console.log(`CHOIX|${cn}|années ${yrs(stats(w.all))}`);
  console.log(`CHOIX|${cn}|variantes positives sur 2025-26 : ${rows.filter(r => r.ts && r.ts.mean > 0).length}/${rows.length} · top 3 de 2020-24 sur 2025-26 : ${ok.slice(0, 3).map(r => f2(r.ts?.mean ?? 0)).join(' ')}`);
  summary.push(`${cn}: ${f2(w.ts?.mean ?? 0)} R/tr sur 2025-26 (${w.ts?.n ?? 0} trades)`);
}
console.log(`RESUME|${summary.join(' | ')}`);
