// Logique de l'onglet Setups : swing de 2 à 5 jours sur BTC, ETH, SOL et le Brent.
// Un seul détecteur, retenu après backtest (3,5 ans de bougies OKX) : cassure du plus haut/bas de 20 jours
// dans le sens de la tendance journalière. Fonctions pures, sans accès réseau, testées dans tests/setups.test.mjs.

export const BAR = 4 * 3600_000;
const DAY = 86_400_000;

export const RULES = {
  backtestBars: 2190,     // 1 an de bougies 4h
  warmup: 1,              // il faut la bougie 4h précédente pour voir la cassure
  atrPeriod: 14,          // ATR journalier
  breakoutDays: 20,       // plus haut / plus bas des 20 derniers jours
  minVolume: 1,           // volume des dernières 24 h ≥ volume journalier moyen des 20 jours précédents
  stopAtr: 1,             // stop = 1 ATR journalier
  targetsR: [2, 3, 4],    // TP1 à 2R, TP2 à 3R, TP3 à 4R
  minRR: 2,
  expiryBars: 30,         // le trade est clôturé au bout de 5 jours s'il n'a touché ni le stop ni TP1
  cooldownBars: 6,        // 24 h entre deux signaux sur un même actif
  showHours: 24,          // un signal reste affiché 24 h (ou tant que le trade est en jeu)
  statsDays: 365,
};

export const DETECTORS = {
  swing: 'Cassure 20 jours',
};

// ---------- Mise en forme (français) ----------

export function fmtPx(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : Math.min(8, 3 - Math.floor(Math.log10(a)));
  return n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const fmtN = (n, d = 1) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

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

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = null;
  return values.map(v => (prev = prev === null ? v : v * k + prev * (1 - k)));
}

const TRENDS = ['baissière', 'neutre', 'haussière'];

// Indicateurs journaliers calculés une fois : EMA 20/50, ATR, tendance et volume moyen des 20 jours précédents.
export function dailyContext(daily) {
  const closes = daily.map(d => d.c);
  const e20 = ema(closes, 20), e50 = ema(closes, 50), A = atr(daily);
  const trend = daily.map((d, j) => {
    if (j < 49) return 'neutre';
    if (d.c > e50[j] && e20[j] > e50[j]) return 'haussière';
    if (d.c < e50[j] && e20[j] < e50[j]) return 'baissière';
    return 'neutre';
  });
  const volAvg = daily.map((_, j) => (j < 20 ? null : daily.slice(j - 20, j).reduce((t, d) => t + d.v, 0) / 20));
  return { daily, atr: A, trend, volAvg };
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

// ---------- Détecteur : cassure du plus haut/bas de 20 jours dans le sens de la tendance 1D, avec du volume ----------

export function detectSwing(ctx, i) {
  const { bars, dc } = ctx;
  if (i < 1) return null;
  const j = lastDay(dc, bars[i].t + BAR);
  const N = RULES.breakoutDays;
  if (j < N || !dc.atr[j]) return null;
  let hi = -Infinity, lo = Infinity;
  for (let k = j - N + 1; k <= j; k++) { hi = Math.max(hi, dc.daily[k].h); lo = Math.min(lo, dc.daily[k].l); }
  const b = bars[i], pc = bars[i - 1].c, trend = dc.trend[j];
  const up = trend === 'haussière' && b.c > hi && pc <= hi;
  const down = trend === 'baissière' && b.c < lo && pc >= lo;
  if (!up && !down) return null;
  // Une cassure sans volume est souvent un faux départ : on exige au moins le volume d'une journée normale sur 24 h.
  let v24 = 0;
  for (let k = Math.max(0, i - 5); k <= i; k++) v24 += bars[k].v;
  const vr = dc.volAvg[j] ? v24 / dc.volAvg[j] : null;
  if (vr === null || vr < RULES.minVolume) return null;
  const vol = `Volume des dernières 24 h : ${fmtN(vr)}× la moyenne.`;
  if (up) return { dir: 'long', ref: hi, atrD: dc.atr[j], why: `Clôture 4h au-dessus du plus haut des ${N} derniers jours (${fmtPx(hi)}), avec une tendance journalière haussière. Le prix sort de sa zone de range dans le sens de la tendance : c'est le départ typique d'un mouvement de plusieurs jours. ${vol}` };
  return { dir: 'short', ref: lo, atrD: dc.atr[j], why: `Clôture 4h sous le plus bas des ${N} derniers jours (${fmtPx(lo)}), avec une tendance journalière baissière. Le prix casse son support dans le sens de la tendance : c'est le départ typique d'une baisse de plusieurs jours. ${vol}` };
}

// ---------- Plan de trade : stop à 1 ATR journalier, objectifs à 2R, 3R et 4R ----------

export function plan(dir, entry, atrD) {
  const s = dir === 'long' ? 1 : -1;
  const R = RULES.stopAtr * atrD;
  return {
    sl: entry - s * R,
    tp: RULES.targetsR.map(k => entry + s * k * R),
    tpLabels: RULES.targetsR.map(k => `objectif ${fmtN(k, 0)}R`),
    rr: RULES.targetsR[0],
  };
}

// ---------- Résultat d'un signal : TP1, stop, ou sortie au bout de 5 jours ----------

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
// Un seul trade à la fois par actif : pas de nouveau signal tant que le précédent est en jeu.
export function scanAsset(asset, { bars, daily, now = Date.now() }) {
  const dc = dailyContext(daily);
  const ctx = { bars, dc, now };
  const signals = [];
  let busyUntil = -1;
  const start = Math.max(RULES.warmup, bars.length - RULES.backtestBars - 1);
  for (let i = start; i < bars.length; i++) {
    if (i <= busyUntil) continue;
    const hit = detectSwing(ctx, i);
    if (!hit) continue;
    const entry = bars[i].c;
    const p = plan(hit.dir, entry, hit.atrD);
    const j = lastDay(dc, bars[i].t + BAR);
    const sig = {
      id: `${asset.symbol}-swing-${hit.dir}-${bars[i].t}`,
      detector: 'swing', symbol: asset.symbol, dir: hit.dir,
      status: bars[i].closed ? 'confirmé' : 'en cours',
      time: bars[i].t, entry, sl: p.sl, tp: p.tp, tpLabels: p.tpLabels, rr: p.rr, atr: hit.atrD,
      why: hit.why, trend: dc.trend[j],
    };
    Object.assign(sig, bars[i].closed ? evaluate(sig, bars, i) : { outcome: 'open', at: null, r: null });
    signals.push(sig);
    if (!bars[i].closed) continue;
    // Trade en jeu jusqu'à sa sortie (et au moins 24 h) : pas de doublon pendant ce temps.
    const exit = sig.at === null ? bars.length : bars.findIndex(b => b.t === sig.at);
    busyUntil = Math.max(i + RULES.cooldownBars - 1, exit);
  }
  return signals;
}

// ---------- Statistiques par détecteur ----------

// Un trade est gagnant s'il finit en gain : TP1 touché, ou sortie à 5 jours au-dessus de l'entrée.
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
      tp1: done.filter(s => s.outcome === 'tp1').length,
      expired: done.filter(s => s.outcome === 'expired').length,
      open: list.length - done.length,
      winRate: done.length ? wins / done.length : null,
      avgR: done.length ? Math.round((done.reduce((t, s) => t + s.r, 0) / done.length) * 100) / 100 : null,
      totalR: Math.round(done.reduce((t, s) => t + s.r, 0) * 10) / 10,
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
