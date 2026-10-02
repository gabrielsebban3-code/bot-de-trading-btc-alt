// Logique de l'onglet Setups : niveaux, 5 détecteurs, plan de trade (SL/TP), suivi des résultats.
// Fonctions pures, sans accès réseau, testées dans tests/setups.test.mjs.

export const BAR = 4 * 3600_000;
const DAY = 86_400_000;

export const RULES = {
  backtestBars: 540,      // 90 jours de bougies 4h
  warmup: 60,             // bougies nécessaires avant le premier signal
  atrPeriod: 14,
  stopAtr: 1.5,           // stop = 1,5 ATR
  minRR: 2,               // R:R minimum 1:2
  maxTargetR: 6,          // au-delà, on vise 2R faute de niveau proche
  expiryBars: 30,         // un signal non résolu après 5 jours est « expiré »
  cooldownBars: 6,        // pas deux fois le même signal en 24 h
  showHours: 24,          // durée d'affichage d'un signal
  lookback: 20,           // plus haut / plus bas des 20 dernières bougies
  breakoutVolume: 1.8,    // volume ≥ 1,8× la moyenne
  fvgMinAtr: 0.3,         // gap d'au moins 0,3 ATR
  fvgMaxAge: 30,
  fundingExtreme: 0.0004, // 0,04 % / 8 h, soit 4× le taux normal
  oiRise: 0.10,           // open interest +10 % en 24 h
};

export const DETECTORS = {
  breakout: 'Breakout + volume',
  sweep: 'Liquidity sweep',
  fvg: 'FVG',
  funding: 'Funding/OI extrême',
  levels: 'Niveaux',
};

// ---------- Mise en forme (français) ----------

export function fmtPx(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : Math.min(8, 3 - Math.floor(Math.log10(a)));
  return n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const fmtN = (n, d = 1) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const day = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });

// ---------- Indicateurs ----------

export function atr(bars, period = RULES.atrPeriod) {
  const out = new Array(bars.length).fill(null);
  let prev = null;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (i < period) { prev = (prev ?? 0) + tr; continue; }
    prev = i === period ? (prev + tr) / period : (prev * (period - 1) + tr) / period;
    out[i] = prev;
  }
  return out;
}

const maxH = (bars, from, to) => { let m = -Infinity; for (let k = from; k < to; k++) m = Math.max(m, bars[k].h); return m; };
const minL = (bars, from, to) => { let m = Infinity; for (let k = from; k < to; k++) m = Math.min(m, bars[k].l); return m; };
const avgV = (bars, from, to) => { let s = 0; for (let k = from; k < to; k++) s += bars[k].v; return s / (to - from); };

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = null;
  return values.map(v => (prev = prev === null ? v : v * k + prev * (1 - k)));
}

// Tendance 1D (pour info) à partir des bougies journalières clôturées avant `t`.
export function trend1d(daily, t) {
  const closes = daily.filter(d => d.t + DAY <= t).map(d => d.c);
  if (closes.length < 50) return 'neutre';
  const e20 = ema(closes, 20).at(-1), e50 = ema(closes, 50).at(-1), c = closes.at(-1);
  if (c > e50 && e20 > e50) return 'haussière';
  if (c < e50 && e20 < e50) return 'baissière';
  return 'neutre';
}

// Plus haut / plus bas de la veille et de la semaine précédente (UTC, semaine du lundi).
export function priorLevels(daily, t) {
  const dayStart = Math.floor(t / DAY) * DAY;
  const out = [];
  const prev = daily.find(d => d.t === dayStart - DAY);
  if (prev) out.push({ price: prev.h, label: 'plus haut de la veille', key: 'dh' }, { price: prev.l, label: 'plus bas de la veille', key: 'dl' });
  const dow = (new Date(dayStart).getUTCDay() + 6) % 7;
  const weekStart = dayStart - dow * DAY;
  const week = daily.filter(d => d.t >= weekStart - 7 * DAY && d.t < weekStart);
  if (week.length >= 3) {
    out.push({ price: Math.max(...week.map(d => d.h)), label: 'plus haut de la semaine dernière', key: 'wh' },
      { price: Math.min(...week.map(d => d.l)), label: 'plus bas de la semaine dernière', key: 'wl' });
  }
  return out;
}

export function roundStep(price) {
  return 10 ** Math.floor(Math.log10(price)) / 2;
}

// Niveau où il s'est échangé le plus de volume sur les 180 dernières bougies (30 jours).
export function volumePoc(bars, i, n = 180, bins = 48) {
  const from = Math.max(0, i - n);
  const lo = minL(bars, from, i), hi = maxH(bars, from, i);
  if (!(hi > lo)) return null;
  const vol = new Array(bins).fill(0);
  for (let k = from; k < i; k++) {
    const b = bars[k];
    const tp = (b.h + b.l + b.c) / 3;
    vol[Math.min(bins - 1, Math.floor(((tp - lo) / (hi - lo)) * bins))] += b.v;
  }
  const best = vol.indexOf(Math.max(...vol));
  return lo + ((best + 0.5) / bins) * (hi - lo);
}

// Points pivots confirmés (extrême local sur ±w bougies) avant la bougie i.
function pivots(bars, i, w = 5, depth = 120) {
  const out = [];
  for (let k = Math.max(w, i - depth); k <= i - w - 1; k++) {
    let hi = true, lo = true;
    for (let j = k - w; j <= k + w; j++) {
      if (j === k) continue;
      if (bars[j].h >= bars[k].h) hi = false;
      if (bars[j].l <= bars[k].l) lo = false;
    }
    if (hi) out.push({ price: bars[k].h, label: `sommet du ${day(bars[k].t)}` });
    if (lo) out.push({ price: bars[k].l, label: `creux du ${day(bars[k].t)}` });
  }
  return out;
}

// Tous les niveaux qui peuvent servir de cible ou d'obstacle à la bougie i.
export function keyLevels(bars, i, daily, a) {
  const p = bars[i].c;
  const step = roundStep(p);
  const levels = [...pivots(bars, i), ...priorLevels(daily, bars[i].t)];
  const poc = volumePoc(bars, i);
  if (poc) levels.push({ price: poc, label: 'niveau le plus échangé sur 30 jours', key: 'poc' });
  for (let r = Math.floor((p - 10 * a) / step) * step; r <= p + 10 * a; r += step) {
    if (r > 0) levels.push({ price: Number(r.toPrecision(12)), label: `chiffre rond ${fmtPx(r)}`, key: 'round' });
  }
  return levels;
}

// ---------- Plan de trade : entrée, stop ATR, objectifs sur les niveaux, filtre R:R ----------

export function plan(dir, entry, a, levels) {
  const s = dir === 'long' ? 1 : -1;
  const R = RULES.stopAtr * a;
  const ahead = levels
    .map(l => ({ ...l, dist: (l.price - entry) * s }))
    .filter(l => l.dist > 0.1 * a)
    .sort((x, y) => x.dist - y.dist);
  // Le premier obstacle doit laisser au moins 2R de marge, sinon le trade n'en vaut pas la peine.
  if (ahead.length && ahead[0].dist - 0.1 * a < RULES.minRR * R) return null;
  const tps = [];
  for (const l of ahead) {
    const d = l.dist - 0.1 * a; // on vise juste avant le niveau
    if (d > RULES.maxTargetR * R && !tps.length) break;
    if (!tps.length || d >= tps.at(-1).d + 0.5 * R) tps.push({ d, label: l.label });
    if (tps.length === 3) break;
  }
  if (!tps.length) tps.push({ d: RULES.minRR * R, label: 'objectif 2R (aucun niveau proche)' });
  while (tps.length < 3) {
    const d = tps.at(-1).d + (tps.length === 1 ? 1 : 1.5) * R;
    tps.push({ d, label: `objectif ${fmtN(d / R)}R (aucun autre niveau)` });
  }
  return {
    sl: entry - s * R,
    tp: tps.map(t => entry + s * t.d),
    tpLabels: tps.map(t => t.label),
    rr: Math.round((tps[0].d / R) * 10) / 10,
  };
}

// ---------- Détecteurs (indépendants, une seule idée chacun) ----------

export function detectBreakout(ctx, i) {
  const { bars } = ctx;
  const L = RULES.lookback;
  if (i < L + 1) return null;
  const hi = maxH(bars, i - L, i), lo = minL(bars, i - L, i);
  const vr = bars[i].v / avgV(bars, i - L, i);
  if (!(vr >= RULES.breakoutVolume)) return null;
  const b = bars[i], pc = bars[i - 1].c;
  const vol = `avec un volume ${fmtN(vr)}× la moyenne`;
  if (b.c > hi && pc <= hi) return { dir: 'long', ref: hi, why: `Clôture 4h au-dessus du plus haut des ${L} dernières bougies (${fmtPx(hi)}) ${vol}. Les acheteurs ont pris le dessus sur cette résistance.` };
  if (b.c < lo && pc >= lo) return { dir: 'short', ref: lo, why: `Clôture 4h sous le plus bas des ${L} dernières bougies (${fmtPx(lo)}) ${vol}. Les vendeurs ont cassé ce support.` };
  return null;
}

export function detectSweep(ctx, i) {
  const { bars, daily } = ctx;
  const L = RULES.lookback;
  if (i < L + 1) return null;
  const b = bars[i];
  const range = b.h - b.l;
  if (!(range > 0)) return null;
  const prior = priorLevels(daily, b.t);
  const pick = keys => prior.filter(l => keys.includes(l.key));
  const lows = [...pick(['wl']), ...pick(['dl']), { price: minL(bars, i - L, i), label: `plus bas des ${L} dernières bougies` }];
  const highs = [...pick(['wh']), ...pick(['dh']), { price: maxH(bars, i - L, i), label: `plus haut des ${L} dernières bougies` }];
  const low = lows.find(l => b.l < l.price && b.c > l.price);
  if (low && b.c >= b.l + 0.5 * range) {
    return { dir: 'long', ref: low.price, why: `Mèche sous le ${low.label} (${fmtPx(low.price)}) puis clôture au-dessus. Les stops placés sous ce niveau ont été déclenchés, mais les vendeurs n'ont pas suivi.` };
  }
  const high = highs.find(l => b.h > l.price && b.c < l.price);
  if (high && b.c <= b.h - 0.5 * range) {
    return { dir: 'short', ref: high.price, why: `Mèche au-dessus du ${high.label} (${fmtPx(high.price)}) puis clôture en dessous. Les stops au-dessus ont été pris, mais les acheteurs n'ont pas tenu.` };
  }
  return null;
}

export function detectFvg(ctx, i) {
  const { bars, atr: A } = ctx;
  const b = bars[i];
  for (let c = i - 1; c >= Math.max(2, i - RULES.fvgMaxAge); c--) {
    const a = c - 2, size = A[c] ?? A[i];
    if (!size) continue;
    // Gap haussier : le bas de la bougie c reste au-dessus du haut de la bougie a.
    if (bars[c].l - bars[a].h >= RULES.fvgMinAtr * size) {
      const top = bars[c].l, bottom = bars[a].h;
      if (minL(bars, c + 1, i) <= top) continue; // déjà revisité
      if (b.l <= top && b.c >= bottom) {
        return { dir: 'long', ref: bottom, why: `Le prix revient dans le gap ${fmtPx(bottom)}–${fmtPx(top)} laissé le ${day(bars[c - 1].t)} par une forte hausse. Ces zones servent souvent de support.` };
      }
    }
    if (bars[a].l - bars[c].h >= RULES.fvgMinAtr * size) {
      const bottom = bars[c].h, top = bars[a].l;
      if (maxH(bars, c + 1, i) >= bottom) continue;
      if (b.h >= bottom && b.c <= top) {
        return { dir: 'short', ref: top, why: `Le prix remonte dans le gap ${fmtPx(bottom)}–${fmtPx(top)} laissé le ${day(bars[c - 1].t)} par une forte baisse. Ces zones servent souvent de résistance.` };
      }
    }
  }
  return null;
}

export function detectFunding(ctx, i) {
  const { bars, fundingAt, oiAt } = ctx;
  if (!fundingAt || !oiAt) return null;
  const end = bars[i].t + BAR;
  const f = fundingAt(Math.min(end, ctx.now ?? end));
  const oi = oiAt(bars[i].t), oiPrev = oiAt(bars[i].t - 6 * BAR);
  if (f === null || !oi || !oiPrev) return null;
  const chg = oi / oiPrev - 1;
  if (chg < RULES.oiRise) return null;
  const txt = `Funding à ${f > 0 ? '+' : ''}${fmtN(f * 100, 3)} %/8 h (${fmtN(Math.abs(f) / 0.0001, 0)}× le taux normal) et open interest +${fmtN(chg * 100, 0)} % en 24 h`;
  if (f >= RULES.fundingExtreme) return { dir: 'short', ref: null, why: `${txt} : beaucoup de positions longues à effet de levier. Si le prix cale, leurs liquidations peuvent le faire baisser.` };
  if (f <= -RULES.fundingExtreme) return { dir: 'long', ref: null, why: `${txt} : beaucoup de positions courtes à effet de levier. Si le prix tient, leurs rachats forcés peuvent le faire monter.` };
  return null;
}

export function detectLevels(ctx, i) {
  const { bars, daily, atr: A } = ctx;
  const a = A[i];
  if (!a || i < 2) return null;
  const b = bars[i], pc = bars[i - 1].c;
  const levels = priorLevels(daily, b.t);
  const poc = volumePoc(bars, i);
  if (poc) levels.push({ price: poc, label: 'niveau le plus échangé sur 30 jours' });
  const step = roundStep(b.c);
  for (const r of [Math.floor(b.c / step) * step, Math.ceil(b.c / step) * step]) levels.push({ price: r, label: `chiffre rond ${fmtPx(r)}` });
  const sorted = levels.sort((x, y) => Math.abs(x.price - b.c) - Math.abs(y.price - b.c));
  for (const l of sorted) {
    const L = l.price;
    if (pc > L && b.l <= L + 0.15 * a && b.l >= L - 0.3 * a && b.c >= L + 0.4 * a && b.c > b.o) {
      return { dir: 'long', ref: L, why: `Rebond sur le ${l.label} (${fmtPx(L)}) : le prix l'a touché puis est reparti à la hausse. Ce niveau tient comme support.` };
    }
    if (pc < L && b.h >= L - 0.15 * a && b.h <= L + 0.3 * a && b.c <= L - 0.4 * a && b.c < b.o) {
      return { dir: 'short', ref: L, why: `Rejet sous le ${l.label} (${fmtPx(L)}) : le prix l'a touché puis est reparti à la baisse. Ce niveau tient comme résistance.` };
    }
  }
  return null;
}

const DETECT = { breakout: detectBreakout, sweep: detectSweep, fvg: detectFvg, funding: detectFunding, levels: detectLevels };

// ---------- Résultat d'un signal : TP1 avant le stop ? ----------

export function evaluate(sig, bars, i) {
  const s = sig.dir === 'long' ? 1 : -1;
  const R = Math.abs(sig.entry - sig.sl);
  const last = Math.min(bars.length - 1, i + RULES.expiryBars);
  let best = 0;
  for (let k = i + 1; k <= last; k++) {
    const b = bars[k];
    if (!b.closed) break;
    const hitSl = s > 0 ? b.l <= sig.sl : b.h >= sig.sl;
    const hitTp = s > 0 ? b.h >= sig.tp[0] : b.l <= sig.tp[0];
    if (hitSl) return { outcome: 'sl', at: b.t, r: -1 };
    if (hitTp) {
      for (let j = 1; j < sig.tp.length; j++) if ((s > 0 ? b.h >= sig.tp[j] : b.l <= sig.tp[j])) best = j;
      for (let m = k + 1; m <= last && best < sig.tp.length - 1; m++) {
        const n = bars[m];
        if (!n.closed || (s > 0 ? n.l <= sig.entry : n.h >= sig.entry)) break; // retour à l'entrée : on s'arrête là
        while (best < sig.tp.length - 1 && (s > 0 ? n.h >= sig.tp[best + 1] : n.l <= sig.tp[best + 1])) best++;
      }
      return { outcome: 'tp1', at: b.t, r: sig.rr, tpHit: best + 1 };
    }
    if (k === i + RULES.expiryBars) return { outcome: 'expired', at: b.t, r: Math.round(((b.c - sig.entry) * s / R) * 100) / 100 };
  }
  return { outcome: 'open', at: null, r: null };
}

// ---------- Balayage d'un actif ----------

// Renvoie tous les signaux (passés et en cours) d'un actif, avec leur résultat.
export function scanAsset(asset, { bars, daily, fundingAt = null, oiAt = null, now = Date.now() }) {
  const A = atr(bars);
  const ctx = { bars, daily, atr: A, fundingAt, oiAt, now };
  const signals = [];
  const lastFired = {};
  const start = Math.max(RULES.warmup, bars.length - RULES.backtestBars - 1);
  for (let i = start; i < bars.length; i++) {
    const a = A[i];
    if (!a) continue;
    for (const [key, detect] of Object.entries(DETECT)) {
      const hit = detect(ctx, i);
      if (!hit) continue;
      const cool = lastFired[`${key}:${hit.dir}`];
      if (cool !== undefined && i - cool < RULES.cooldownBars) continue;
      const entry = bars[i].c;
      const p = plan(hit.dir, entry, a, keyLevels(bars, i, daily, a));
      if (!p) continue;
      if (bars[i].closed) lastFired[`${key}:${hit.dir}`] = i;
      const sig = {
        id: `${asset.symbol}-${key}-${hit.dir}-${bars[i].t}`,
        detector: key, symbol: asset.symbol, dir: hit.dir,
        status: bars[i].closed ? 'confirmé' : 'en cours',
        time: bars[i].t, entry, sl: p.sl, tp: p.tp, tpLabels: p.tpLabels, rr: p.rr, atr: a,
        why: hit.why, trend: trend1d(daily, bars[i].t),
      };
      Object.assign(sig, bars[i].closed ? evaluate(sig, bars, i) : { outcome: 'open', at: null, r: null });
      signals.push(sig);
    }
  }
  return signals;
}

// ---------- Statistiques par détecteur ----------

export function detectorStats(history, now = Date.now()) {
  const since = now - 90 * DAY;
  const stats = {};
  for (const key of Object.keys(DETECTORS)) {
    const list = history.filter(s => s.detector === key && s.status === 'confirmé' && s.time >= since);
    const done = list.filter(s => s.outcome !== 'open');
    const wins = done.filter(s => s.outcome === 'tp1').length;
    const losses = done.filter(s => s.outcome === 'sl').length;
    const bySymbol = {};
    for (const s of done) (bySymbol[s.symbol] ??= []).push(s);
    const best = Object.entries(bySymbol)
      .filter(([, l]) => l.length >= 3)
      .map(([sym, l]) => ({ symbol: sym, n: l.length, winRate: l.filter(s => s.outcome === 'tp1').length / l.length }))
      .sort((x, y) => y.winRate - x.winRate || y.n - x.n)[0] || null;
    stats[key] = {
      signals: list.length,
      resolved: done.length,
      wins, losses, expired: done.length - wins - losses,
      open: list.length - done.length,
      winRate: done.length ? wins / done.length : null,
      avgR: done.length ? Math.round((done.reduce((t, s) => t + s.r, 0) / done.length) * 100) / 100 : null,
      best,
      since: list.length ? Math.min(...list.map(s => s.time)) : null,
    };
  }
  return stats;
}

// Fusionne l'historique déjà publié avec les signaux recalculés.
// Les signaux recalculés font foi sur leur période ; plus tôt, on garde l'ancien historique (90 jours max).
export function mergeHistory(previous, fresh, freshStart, now = Date.now()) {
  const since = now - 90 * DAY;
  const kept = (previous || []).filter(s => s.time >= since && s.status === 'confirmé'
    && (freshStart[s.detector] === undefined || s.time < freshStart[s.detector]));
  const ids = new Set(fresh.map(s => s.id));
  return [...kept.filter(s => !ids.has(s.id)), ...fresh].sort((a, b) => b.time - a.time);
}
