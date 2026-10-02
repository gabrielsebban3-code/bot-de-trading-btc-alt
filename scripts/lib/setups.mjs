// Logique de l'onglet Setups : suivi de tendance sur BTC, ETH, SOL et le Brent, trades de plusieurs semaines.
// Retenu après backtest (3,5 ans de bougies journalières OKX) : on entre quand le prix clôture au-dessus du plus haut
// (ou sous le plus bas) des 20 derniers jours dans le sens de la tendance, on prend la moitié à 2R, puis on laisse
// courir le reste tant que la tendance tient. Fonctions pures, sans accès réseau, testées dans tests/setups.test.mjs.

const DAY = 86_400_000;
export const BAR = DAY;   // une bougie = un jour

export const RULES = {
  backtestBars: 365,      // 1 an de bougies journalières
  atrPeriod: 14,          // ATR journalier
  breakoutDays: 20,       // entrée : clôture au-delà du plus haut / plus bas des 20 derniers jours
  exitDays: 10,           // sortie : clôture au-delà du plus bas / plus haut des 10 derniers jours
  stopAtr: 2,             // stop de départ = 2 ATR journaliers
  partialR: 2,            // on prend la moitié à 2R et on remonte le stop au prix d'entrée
  minRR: 2,
  showHours: 24,          // un trade terminé reste affiché 24 h
  statsDays: 365,
};

export const DETECTORS = {
  tendance: 'Suivi de tendance',
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
  return { daily, atr: A, trend };
}

// Tendance 1D : clôture et EMA20 au-dessus de l'EMA50 = haussière (inverse = baissière).
export function trend1d(daily, t) {
  const dc = dailyContext(daily.filter(d => d.t + DAY <= t));
  return dc.trend.at(-1) ?? 'neutre';
}

// ---------- Détecteur : clôture au-delà du plus haut / plus bas de 20 jours, dans le sens de la tendance ----------

const highest = (daily, from, to) => { let x = -Infinity; for (let k = Math.max(0, from); k <= to; k++) x = Math.max(x, daily[k].h); return x; };
const lowest = (daily, from, to) => { let x = Infinity; for (let k = Math.max(0, from); k <= to; k++) x = Math.min(x, daily[k].l); return x; };

// Tendance calculée sur les jours fermés jusqu'à la veille, cassure jugée sur la clôture du jour j.
export function detectTrend(dc, j) {
  const N = RULES.breakoutDays, d = dc.daily;
  if (j < N + 1 || !dc.atr[j - 1]) return null;
  const hi = highest(d, j - N, j - 1), lo = lowest(d, j - N, j - 1), trend = dc.trend[j - 1], c = d[j].c;
  if (trend === 'haussière' && c > hi) return { dir: 'long', ref: hi, atrD: dc.atr[j - 1], why: `Clôture journalière au-dessus du plus haut des ${N} derniers jours (${fmtPx(hi)}), dans une tendance haussière. On achète la continuation de la hausse et on reste dedans tant qu'elle dure : la moitié est prise à 2R, le reste suit la tendance jusqu'à ce que le prix clôture sous son plus bas des ${RULES.exitDays} derniers jours.` };
  if (trend === 'baissière' && c < lo) return { dir: 'short', ref: lo, atrD: dc.atr[j - 1], why: `Clôture journalière sous le plus bas des ${N} derniers jours (${fmtPx(lo)}), dans une tendance baissière. On vend la continuation de la baisse et on reste dedans tant qu'elle dure : la moitié est prise à 2R, le reste suit la tendance jusqu'à ce que le prix clôture au-dessus de son plus haut des ${RULES.exitDays} derniers jours.` };
  return null;
}

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

// Niveau de sortie du reste : plus bas (long) ou plus haut (short) des 10 jours fermés avant le jour k.
export function exitLevel(daily, k, dir) {
  const N = RULES.exitDays;
  return dir === 'long' ? lowest(daily, k - N, k - 1) : highest(daily, k - N, k - 1);
}

// ---------- Suivi d'un trade jour après jour ----------
// sl : stop touché avant 2R (−1R) · be : moitié prise, reste sorti au prix d'entrée (+1R)
// exit : sortie de tendance sur clôture (R variable) · open : trade encore en jeu.

export function evaluate(sig, daily, i) {
  const s = sig.dir === 'long' ? 1 : -1;
  const R = Math.abs(sig.entry - sig.sl);
  const P = RULES.partialR;
  let stop = sig.sl, half = false;
  const rOf = px => Math.round((s * (px - sig.entry) / R) * 100) / 100;
  const done = (outcome, at, rest) => ({ outcome, at, r: Math.round((half ? (P + rest) / 2 : rest) * 100) / 100, tpHit: half ? 1 : 0 });
  for (let k = i + 1; k < daily.length; k++) {
    const b = daily[k];
    if (!b.closed) break;
    const hitStop = s > 0 ? b.l <= stop : b.h >= stop;   // le stop compte en premier si tout arrive le même jour
    if (hitStop) return done(half ? 'be' : 'sl', b.t, half ? 0 : -1);
    if (!half && (s > 0 ? b.h >= sig.tp[0] : b.l <= sig.tp[0])) { half = true; stop = sig.entry; }
    const lvl = exitLevel(daily, k, sig.dir);
    if (s > 0 ? b.c < lvl : b.c > lvl) return done('exit', b.t, rOf(b.c));
  }
  // Niveau de sortie du reste, affiché seulement quand il est plus serré que le stop.
  const last = daily.length - 1;
  const lvl = exitLevel(daily, last + (daily[last].closed ? 1 : 0), sig.dir);
  return { outcome: 'open', at: null, r: null, tpHit: half ? 1 : 0, stop, exitAt: (s > 0 ? lvl > stop : lvl < stop) ? lvl : null };
}

// ---------- Balayage d'un actif ----------

// Renvoie tous les signaux (passés et en cours) d'un actif, avec leur résultat.
// Un seul trade à la fois par actif : pas de nouveau signal tant que le précédent est en jeu.
export function scanAsset(asset, { daily, now = Date.now() }) {
  const dc = dailyContext(daily);
  const signals = [];
  let busyUntil = -1;
  for (let j = Math.max(1, daily.length - RULES.backtestBars - 1); j < daily.length; j++) {
    if (j <= busyUntil) continue;
    const hit = detectTrend(dc, j);
    if (!hit) continue;
    const entry = daily[j].c;
    const p = plan(hit.dir, entry, hit.atrD);
    const sig = {
      id: `${asset.symbol}-tendance-${hit.dir}-${daily[j].t}`,
      detector: 'tendance', symbol: asset.symbol, dir: hit.dir,
      status: daily[j].closed ? 'confirmé' : 'en cours',
      time: daily[j].t, confirmedAt: daily[j].t + DAY, entry, sl: p.sl, tp: p.tp, tpLabels: p.tpLabels, rr: p.rr, atr: hit.atrD,
      why: hit.why, trend: dc.trend[j - 1],
    };
    Object.assign(sig, daily[j].closed ? evaluate(sig, daily, j) : { outcome: 'open', at: null, r: null, tpHit: 0 });
    signals.push(sig);
    if (!daily[j].closed) continue;
    busyUntil = sig.at === null ? daily.length : daily.findIndex(b => b.t === sig.at);
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
