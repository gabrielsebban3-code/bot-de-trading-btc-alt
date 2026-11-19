// Outil « Bougie du mois / de la semaine » : où en est la bougie en cours, et ce qu'ont fait les bougies passées
// qui en étaient au même point. Calculé par le script de données (Node), affiché par js/outils.js.
// Testé dans tests/bougie.test.mjs.
//
// Bougies quotidiennes : [jour, ouverture, haut, bas, clôture], jour = nombre de jours depuis le 1er janvier 1970 (UTC).
// Une « période » = un mois calendaire ou une semaine du lundi au dimanche (UTC).

const DAY = 86_400_000;

// Clé de la période d'un jour : '2026-11' pour un mois, le lundi de la semaine pour une semaine.
export function periodKey(day, kind) {
  const d = new Date(day * DAY);
  if (kind === 'm') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return day - ((d.getUTCDay() + 6) % 7);
}

// Nombre de jours d'une période qui commence le jour `first`.
export function periodLength(first, kind) {
  if (kind === 'w') return 7;
  const d = new Date(first * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).getTime() / DAY - first;
}

// Découpe les bougies en périodes. La dernière peut être en cours (moins de jours que sa longueur).
export function splitPeriods(candles, kind) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const k = periodKey(c[0], kind);
    if (!cur || cur.key !== k) {
      cur = { key: k, first: kind === 'w' ? k : c[0] - new Date(c[0] * DAY).getUTCDate() + 1, rows: [] };
      out.push(cur);
    }
    cur.rows.push(c);
  }
  for (const p of out) p.len = periodLength(p.first, kind);
  // Une période commencée en cours de route (début de l'historique) fausserait l'ouverture : on la retire.
  return out.filter(p => p.rows[0][0] === p.first);
}

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
};
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

// Agitation du marché : écart type des variations quotidiennes (en log) sur les 30 derniers jours.
function volatility(closes, i) {
  const xs = [];
  for (let j = Math.max(1, i - 29); j <= i; j++) xs.push(Math.log(closes[j] / closes[j - 1]));
  if (xs.length < 5) return 0.03;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - m) ** 2))) || 0.03;
}

// Où en est une période après ses `k` premiers jours, et ce qui s'est passé ensuite (si elle est finie).
// Les écarts au plus haut, au plus bas et à l'ouverture sont exprimés en « secousses normales » pour le temps qui reste :
// une baisse de 10 % ne pèse pas pareil en 2013 (BTC très agité) qu'en 2024.
function snapshot(p, k, vol) {
  const rows = p.rows;
  const o = rows[0][1];
  let H = -Infinity, L = Infinity, hDay = 0, lDay = 0;
  for (let j = 0; j < k; j++) {
    if (rows[j][2] > H) { H = rows[j][2]; hDay = j; }
    if (rows[j][3] < L) { L = rows[j][3]; lDay = j; }
  }
  const C = rows[k - 1][4];
  const left = p.len - k;
  const s = vol * Math.sqrt(Math.max(left, 1));
  const snap = { key: p.key, first: p.first, k, left, open: o, high: H, low: L, close: C, hDay, lDay,
    x: [Math.log(C / o) / s, Math.log(H / C) / s, Math.log(C / L) / s] };
  if (rows.length === p.len && left > 0) {
    const fut = rows.slice(k);
    const fh = Math.max(...fut.map(r => r[2]));
    const fl = Math.min(...fut.map(r => r[3]));
    const end = rows.at(-1)[4];
    snap.out = {
      high: fh > H, // a dépassé le plus haut déjà fait
      low: fl < L, // est passé sous le plus bas déjà fait
      green: end > o, // a fini au-dessus de l'ouverture
      up: fh / C - 1, // plus forte hausse d'ici la fin, depuis le prix du jour k
      down: fl / C - 1,
      rest: end / C - 1, // variation du jour k à la clôture
      end: end / o - 1, // variation de toute la période
      path: fut.map(r => r[4] / C), // clôtures suivantes, rapportées au prix du jour k
    };
  }
  return snap;
}

const dist = (a, b) => (a.x[0] - b.x[0]) ** 2 + (a.x[1] - b.x[1]) ** 2 + (a.x[2] - b.x[2]) ** 2;
const share = (list, f) => (list.length ? list.filter(f).length / list.length * 100 : null);

// Les périodes passées les plus proches de `now` parmi `pool` (mêmes jours restants).
function nearest(pool, now, n) {
  return pool.map(s => [dist(s, now), s]).sort((a, b) => a[0] - b[0]).slice(0, n).map(x => x[1]);
}

// Probabilités et fourchettes à partir d'un groupe de périodes passées.
function summarize(list) {
  const o = list.map(s => s.out);
  const ups = o.map(x => x.up).sort((a, b) => a - b);
  const downs = o.map(x => x.down).sort((a, b) => a - b);
  const rests = o.map(x => x.rest).sort((a, b) => a - b);
  return {
    n: list.length,
    high: share(o, x => x.high),
    low: share(o, x => x.low),
    green: share(o, x => x.green),
    restUp: share(o, x => x.rest > 0),
    up: [quantile(ups, 0.25), quantile(ups, 0.5), quantile(ups, 0.75)],
    down: [quantile(downs, 0.75), quantile(downs, 0.5), quantile(downs, 0.25)],
    rest: [quantile(rests, 0.1), quantile(rests, 0.5), quantile(rests, 0.9)],
  };
}

// Test honnête, sans tricher : pour chaque période depuis `testFrom`, on refait le calcul avec seulement les périodes
// d'avant, puis on regarde ce qui s'est vraiment passé.
// - Justesse des % (score de Brier : 0 = parfait, 0,25 = pile ou face) contre « tous les mois » sans tri.
// - Direction : « les périodes proches ont surtout monté ensuite » a-t-il deviné le sens de la fin de période ?
function backtest(done, left, n, testFrom) {
  const pool = done.filter(s => s.left === left);
  const sc = { high: [0, 0], low: [0, 0], green: [0, 0] };
  const calib = [];
  let tests = 0, hits = 0, ups = 0, from = null;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i];
    if (s.first < testFrom) continue;
    const past = pool.slice(0, i);
    if (past.length < n * 2) continue;
    const near = nearest(past, s, n);
    tests++;
    from ??= s.first;
    for (const e of Object.keys(sc)) {
      const base = share(past, x => x.out[e]) / 100;
      const cond = share(near, x => x.out[e]) / 100;
      const y = s.out[e] ? 1 : 0;
      sc[e][0] += (base - y) ** 2;
      sc[e][1] += (cond - y) ** 2;
      if (e === 'high' || e === 'low') calib.push([cond, y]);
    }
    const guessUp = near.filter(x => x.out.rest > 0).length * 2 > near.length;
    if (guessUp === s.out.rest > 0) hits++;
    if (s.out.rest > 0) ups++;
  }
  if (!tests) return null;
  // Calibration : quand on annonçait environ X %, combien de fois c'est arrivé ?
  const buckets = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]].map(([a, b]) => {
    const g = calib.filter(([p]) => p >= a && p < b);
    return { from: a * 100, to: Math.min(b, 1) * 100, n: g.length, said: g.length ? mean(g.map(x => x[0])) * 100 : null, real: g.length ? mean(g.map(x => x[1])) * 100 : null };
  });
  const r = v => Math.round(v / tests * 1000) / 1000;
  return {
    tests,
    from,
    brier: Object.fromEntries(Object.entries(sc).map(([e, [b, c]]) => [e, { all: r(b), similar: r(c) }])),
    calib: buckets,
    direction: { hit: hits / tests * 100, alwaysUp: Math.max(ups, tests - ups) / tests * 100 },
  };
}

// Analyse complète pour la période en cours. `n` = nombre de périodes proches retenues.
export function candleStats(candles, kind, { n = kind === 'm' ? 20 : 40, testFrom = Date.UTC(2016, 0, 1) / DAY, top = 8 } = {}) {
  const periods = splitPeriods(candles, kind);
  if (periods.length < 3) return null;
  const closes = candles.map(c => c[4]);
  const index = new Map(candles.map((c, i) => [c[0], i]));
  const cur = periods.at(-1);
  const k = cur.rows.length;
  if (k >= cur.len) return null; // période finie : la suivante n'a pas encore commencé
  const left = cur.len - k;
  const snapAt = (p, kk) => snapshot(p, kk, volatility(closes, index.get(p.rows[kk - 1][0])));
  const now = snapAt(cur, k);
  // Toutes les périodes finies, prises au même nombre de jours restants que la période en cours.
  const done = [];
  for (const p of periods.slice(0, -1)) {
    if (p.rows.length !== p.len) continue;
    for (let kk = 1; kk < p.len; kk++) done.push(snapAt(p, kk));
  }
  const pool = done.filter(s => s.left === left);
  if (pool.length < n) return null;
  const near = nearest(pool, now, n);
  // Moment du plus haut et du plus bas dans toutes les périodes finies (jour 1 = premier jour).
  const full = periods.slice(0, -1).filter(p => p.rows.length === p.len).map(p => snapAt(p, p.len));
  const timing = which => {
    const days = full.map(s => (which === 'h' ? s.hDay : s.lDay) + 1);
    const maxLen = kind === 'm' ? 31 : 7;
    return Array.from({ length: maxLen }, (_, i) => days.filter(d => d === i + 1).length);
  };
  // Trajet des clôtures d'ici la fin : 1 fois sur 10 en dessous, milieu, 1 fois sur 10 au-dessus.
  const band = Array.from({ length: left }, (_, j) => {
    const v = near.map(s => s.out.path[j]).sort((a, b) => a - b);
    return [cur.first + k + j, quantile(v, 0.1) * now.close, quantile(v, 0.5) * now.close, quantile(v, 0.9) * now.close];
  });
  return {
    kind,
    first: cur.first,
    len: cur.len,
    k,
    left,
    open: now.open,
    high: now.high,
    low: now.low,
    close: now.close,
    highDay: cur.first + now.hDay,
    lowDay: cur.first + now.lDay,
    closes: cur.rows.map(r => [r[0], r[4]]),
    periods: full.length,
    since: full[0]?.first ?? null,
    similar: summarize(near),
    all: summarize(pool),
    // Au même stade, part des périodes dont le plus haut (le plus bas) était déjà fait.
    already: { high: share(pool, s => !s.out.high), low: share(pool, s => !s.out.low) },
    closest: near.slice(0, top).map(s => ({ first: s.first, now: s.close / s.open - 1, end: s.out.end, rest: s.out.rest, high: s.out.high, low: s.out.low })),
    band,
    timing: { high: timing('h'), low: timing('l') },
    test: backtest(done, left, n, testFrom),
  };
}
