// Logique de l'onglet Setups : les 5 indicateurs de base sur bougies 4h (BTC, ETH, SOL, Brent),
// gardés seulement quand ils vont dans le sens de la tendance journalière, puis gérés en suivi de tendance :
// stop à 2 ATR journaliers, moitié prise à 2R, reste gardé tant que la tendance tient.
// Choix de Gabriel (questionnaire du 2 octobre 2026). Fonctions pures, testées dans tests/setups.test.mjs.

export const BAR = 4 * 3600_000;
const DAY = 86_400_000;

export const RULES = {
  backtestBars: 2190,     // 1 an de bougies 4h
  warmup: 60,             // bougies nécessaires avant le premier signal
  atrPeriod: 14,
  lookback: 20,           // plus haut / plus bas des 20 dernières bougies 4h
  breakoutVolume: 1.8,    // volume ≥ 1,8× la moyenne
  fvgMinAtr: 0.3,         // gap d'au moins 0,3 ATR
  fvgMaxAge: 30,
  fundingExtreme: 0.0004, // 0,04 % / 8 h, soit 4× le taux normal
  oiRise: 0.10,           // open interest +10 % en 24 h
  stopAtr: 2,             // stop de départ = 2 ATR journaliers
  partialR: 2,            // on prend la moitié à 2R et on remonte le stop au prix d'entrée
  exitDays: 10,           // sortie du reste : clôture journalière au-delà du plus bas / plus haut des 10 jours
  minRR: 2,
  roomAtr: 1.5,           // marge minimale avant le prochain niveau : 2 × 1,5 ATR 4h
  showHours: 24,          // un trade terminé reste affiché 24 h
  statsDays: 365,
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

// ---------- Niveaux ----------

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

// Le premier niveau devant le prix doit laisser au moins 2R de marge (R = 1,5 ATR 4h, comme au départ) :
// sinon le trade bute tout de suite sur une résistance (ou un support pour un short).
export function hasRoom(dir, entry, a, levels) {
  const s = dir === 'long' ? 1 : -1;
  const first = levels.map(l => (l.price - entry) * s).filter(d => d > 0.1 * a).sort((x, y) => x - y)[0];
  return first === undefined || first - 0.1 * a >= RULES.minRR * RULES.roomAtr * a;
}

// ---------- Tendance journalière ----------

// Indicateurs journaliers calculés une fois : EMA 20/50, ATR et tendance.
export function dailyContext(daily) {
  const closes = daily.map(d => d.c);
  const e20 = ema(closes, 20), e50 = ema(closes, 50), A = atr(daily);
  const trend = daily.map((d, j) => {
    if (j < 49) return 'neutre';
    if (d.c > e50[j] && e20[j] > e50[j]) return 'haussière';
    if (d.c < e50[j] && e20[j] < e50[j]) return 'baissière';
    return 'neutre';
  });
  return { daily, atr: A, trend };
}

// Indice de la dernière journée clôturée au temps t (-1 si aucune).
export function lastDay(dc, t) {
  let lo = 0, hi = dc.daily.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (dc.daily[m].t + DAY <= t) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

// Tendance 1D : clôture et EMA20 au-dessus de l'EMA50 = haussière (inverse = baissière).
export function trend1d(daily, t) {
  const dc = dailyContext(daily.filter(d => d.t + DAY <= t));
  return dc.trend.at(-1) ?? 'neutre';
}

// ---------- Indicateurs de base (une idée chacun, sur la bougie 4h) ----------

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
const WANT = { long: 'haussière', short: 'baissière' };

// ---------- Plan de trade : stop à 2 ATR journaliers, moitié à 2R ----------

export function plan(dir, entry, atrD) {
  const s = dir === 'long' ? 1 : -1;
  const R = RULES.stopAtr * atrD;
  return {
    sl: entry - s * R,
    tp: [entry + s * RULES.partialR * R],
    tpLabels: [`prendre la moitié à ${fmtN(RULES.partialR, 0)}R et remonter le stop au prix d'entrée`],
    rr: RULES.partialR,
  };
}

// Niveau de sortie du reste : plus bas (long) ou plus haut (short) des 10 jours clôturés avant le jour k.
export function exitLevel(daily, k, dir) {
  let x = dir === 'long' ? Infinity : -Infinity;
  for (let q = Math.max(0, k - RULES.exitDays); q < k; q++) x = dir === 'long' ? Math.min(x, daily[q].l) : Math.max(x, daily[q].h);
  return x;
}

// ---------- Suivi d'un trade bougie 4h après bougie 4h ----------
// sl : stop touché avant 2R (−1R) · be : moitié prise, reste sorti au prix d'entrée (+1R)
// exit : sortie de tendance sur clôture journalière (R variable) · open : trade encore en jeu.

export function evaluate(sig, bars, i, daily) {
  const s = sig.dir === 'long' ? 1 : -1;
  const R = Math.abs(sig.entry - sig.sl);
  const P = RULES.partialR;
  const dayIndex = new Map(daily.map((d, k) => [d.t, k]));
  let stop = sig.sl, half = false;
  const rOf = px => Math.round((s * (px - sig.entry) / R) * 100) / 100;
  const done = (outcome, at, rest) => ({ outcome, at, r: Math.round((half ? (P + rest) / 2 : rest) * 100) / 100, tpHit: half ? 1 : 0 });
  for (let k = i + 1; k < bars.length; k++) {
    const b = bars[k];
    if (!b.closed) break;
    const hitStop = s > 0 ? b.l <= stop : b.h >= stop;   // le stop compte en premier si tout arrive dans la même bougie
    if (hitStop) return done(half ? 'be' : 'sl', b.t, half ? 0 : -1);
    if (!half && (s > 0 ? b.h >= sig.tp[0] : b.l <= sig.tp[0])) { half = true; stop = sig.entry; }
    // Dernière bougie 4h de la journée UTC : on juge la clôture journalière.
    if ((b.t + BAR) % DAY === 0) {
      const jd = dayIndex.get(b.t + BAR - DAY);
      if (jd !== undefined && jd >= RULES.exitDays) {
        const lvl = exitLevel(daily, jd, sig.dir);
        if (s > 0 ? b.c < lvl : b.c > lvl) return done('exit', b.t, rOf(b.c));
      }
    }
  }
  // Niveau de sortie du reste, affiché seulement quand il est plus serré que le stop.
  const closedDays = daily.filter(d => d.closed !== false).length;
  const lvl = exitLevel(daily, closedDays, sig.dir);
  return { outcome: 'open', at: null, r: null, tpHit: half ? 1 : 0, stop, exitAt: (s > 0 ? lvl > stop : lvl < stop) ? lvl : null };
}

// ---------- Balayage d'un actif ----------

// Renvoie tous les signaux (passés et en cours) d'un actif, avec leur résultat.
// Un signal ne compte que dans le sens de la tendance journalière. Un seul trade à la fois par actif.
export function scanAsset(asset, { bars, daily, fundingAt = null, oiAt = null, now = Date.now() }) {
  const A = atr(bars);
  const dc = dailyContext(daily);
  const ctx = { bars, daily, atr: A, fundingAt, oiAt, now };
  const signals = [];
  let busyUntil = -1;
  const start = Math.max(RULES.warmup, bars.length - RULES.backtestBars - 1);
  for (let i = start; i < bars.length; i++) {
    if (i <= busyUntil || !A[i]) continue;
    const j = lastDay(dc, bars[i].t + BAR);
    if (j < 0 || !dc.atr[j]) continue;
    const trend = dc.trend[j];
    let key = null, hit = null;
    for (const [k, detect] of Object.entries(DETECT)) {
      const h = detect(ctx, i);
      if (h && WANT[h.dir] === trend && hasRoom(h.dir, bars[i].c, A[i], keyLevels(bars, i, daily, A[i]))) { key = k; hit = h; break; }
    }
    if (!hit) continue;
    const entry = bars[i].c;
    const p = plan(hit.dir, entry, dc.atr[j]);
    const sig = {
      id: `${asset.symbol}-${key}-${hit.dir}-${bars[i].t}`,
      detector: key, symbol: asset.symbol, dir: hit.dir,
      status: bars[i].closed ? 'confirmé' : 'en cours',
      time: bars[i].t, confirmedAt: bars[i].t + BAR, entry, sl: p.sl, tp: p.tp, tpLabels: p.tpLabels, rr: p.rr, atr: dc.atr[j],
      why: `${hit.why} Signal pris car la tendance journalière est ${trend}.`, trend,
    };
    Object.assign(sig, bars[i].closed ? evaluate(sig, bars, i, daily) : { outcome: 'open', at: null, r: null, tpHit: 0 });
    signals.push(sig);
    if (!bars[i].closed) continue;
    busyUntil = sig.at === null ? bars.length : bars.findIndex(b => b.t === sig.at);
  }
  return signals;
}

// ---------- Statistiques par détecteur ----------

// Un trade est gagnant s'il finit en gain (r > 0).
export function detectorStats(history, now = Date.now()) {
  const since = now - RULES.statsDays * DAY;
  const stats = {};
  for (const key of Object.keys(DETECTORS)) {
    const list = history.filter(s => s.detector === key && s.status === 'confirmé' && s.time >= since);
    const done = list.filter(s => s.outcome !== 'open');
    const wins = done.filter(s => s.r > 0).length;
    const losses = done.filter(s => s.outcome === 'sl').length;
    const bySymbol = {};
    for (const s of done) (bySymbol[s.symbol] ??= []).push(s);
    const best = Object.entries(bySymbol)
      .filter(([, l]) => l.length >= 3)
      .map(([sym, l]) => ({ symbol: sym, n: l.length, winRate: l.filter(s => s.r > 0).length / l.length }))
      .sort((x, y) => y.winRate - x.winRate || y.n - x.n)[0] || null;
    stats[key] = {
      signals: list.length,
      resolved: done.length,
      wins, losses,
      tp1: done.filter(s => s.tpHit > 0).length,
      exits: done.filter(s => s.outcome !== 'sl').length,
      open: list.length - done.length,
      winRate: done.length ? wins / done.length : null,
      avgR: done.length ? Math.round((done.reduce((t, s) => t + s.r, 0) / done.length) * 100) / 100 : null,
      totalR: Math.round(done.reduce((t, s) => t + s.r, 0) * 10) / 10,
      bestR: done.length ? Math.max(...done.map(s => s.r)) : null,
      avgDays: done.length ? Math.round(done.reduce((t, s) => t + (s.at - s.time) / DAY, 0) / done.length) : null,
      best,
      since: list.length ? Math.min(...list.map(s => s.time)) : null,
    };
  }
  return stats;
}

// Fusionne l'historique déjà publié avec les signaux recalculés.
// Les signaux recalculés font foi sur leur période ; plus tôt, on garde l'ancien historique (1 an max).
// Les signaux d'anciens détecteurs ou d'actifs qui ne sont plus suivis sont retirés.
export function mergeHistory(previous, fresh, freshStart, now = Date.now(), symbols = null) {
  const since = now - RULES.statsDays * DAY;
  const kept = (previous || []).filter(s => s.time >= since && s.status === 'confirmé'
    && DETECTORS[s.detector] && (!symbols || symbols.includes(s.symbol))
    && (freshStart[s.detector] === undefined || s.time < freshStart[s.detector]));
  const ids = new Set(fresh.map(s => s.id));
  return [...kept.filter(s => !ids.has(s.id)), ...fresh].sort((a, b) => b.time - a.time);
}
