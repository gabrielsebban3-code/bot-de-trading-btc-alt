// Indicateur Jambe : découpe le prix en jambes haussières et baissières avec deux moyennes mobiles (9 et 21 bougies).
// Jambe haussière tant que la moyenne 9 est au-dessus de la 21, baissière sinon. Pour chaque jambe : début, fin,
// et l'extrême atteint (plus haut d'une jambe haussière, plus bas d'une baissière). Fonctions pures, testées.
// Bougies : { t, o, h, l, c } fermées, dans l'ordre du temps.

export const LEG = { fast: 9, slow: 21 };
const DAY = 86_400_000;

// Résultats des tests (octobre 2026, BTC, ETH et SOL depuis 2023, frais compris) selon l'unité de temps :
// part moyenne de chaque montée de 30 % ou plus gardée, écart moyen au creux à l'entrée et au sommet à la sortie,
// changements de sens par an, gain moyen 2023-2024 puis 2025-2026 en restant dans les jambes haussières.
export const LEG_TESTS = {
  h4: { capture: 0.41, entry: 0.12, exit: -0.09, switches: 50, gain: [2.15, -0.39], hold: [4.66, -0.21] },
  d1: { capture: 0.46, entry: 0.19, exit: -0.14, switches: 7.5, gain: [3.61, 0.40], hold: [8.13, -0.23] },
  w1: { capture: 0.41, entry: 0.37, exit: -0.33, switches: 1.4, gain: [1.88, -0.21], hold: [6.77, -0.22] },
};

export function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = null;
  return values.map(v => (prev = prev === null ? v : v * k + prev * (1 - k)));
}

// Bougies hebdomadaires (semaine du lundi, UTC) à partir des journalières.
export function toWeeks(daily) {
  const out = [];
  for (const b of daily) {
    const w = Math.floor((b.t / DAY + 3) / 7); // le 1er janvier 1970 était un jeudi
    const last = out.at(-1);
    if (last && last.w === w) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v = (last.v || 0) + (b.v || 0); }
    else out.push({ w, t: (w * 7 - 3) * DAY, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
  }
  return out.map(({ w, ...b }) => b);
}

export function legsOf(bars, { fast = LEG.fast, slow = LEG.slow } = {}) {
  if (bars.length < slow + 2) return null;
  const c = bars.map(b => b.c);
  const f = ema(c, fast), s = ema(c, slow);
  const dir = f.map((x, k) => (x > s[k] ? 1 : -1));
  const legs = [];
  for (let k = slow; k < bars.length; k++) {
    if (k === slow || dir[k] !== dir[k - 1]) legs.push({ dir: dir[k] > 0 ? 'up' : 'down', from: k, to: k });
    else legs.at(-1).to = k;
  }
  for (const l of legs) {
    let x = l.from;
    for (let k = l.from; k <= l.to; k++) if (l.dir === 'up' ? bars[k].h > bars[x].h : bars[k].l < bars[x].l) x = k;
    l.ext = { i: x, t: bars[x].t, price: l.dir === 'up' ? bars[x].h : bars[x].l };
    l.start = { t: bars[l.from].t, price: bars[l.from].c };
    l.end = { t: bars[l.to].t, price: bars[l.to].c };
    l.move = l.end.price / l.start.price - 1;
  }
  return { fast: f, slow: s, dir, legs };
}

// Résumé de la jambe en cours, pour la carte de la paire.
export function legSummary(bars) {
  const r = legsOf(bars);
  if (!r) return null;
  const cur = r.legs.at(-1), prev = r.legs.at(-2);
  const price = bars.at(-1).c;
  return {
    dir: cur.dir, since: cur.start, move: price / cur.start.price - 1,
    // Le creux d'une jambe haussière est l'extrême de la jambe baissière d'avant (et inversement).
    origin: prev ? { t: prev.ext.t, price: prev.ext.price } : null,
    fromOrigin: prev ? price / prev.ext.price - 1 : null,
    ext: { t: cur.ext.t, price: cur.ext.price },
    bars: cur.to - cur.from + 1,
    past: r.legs.slice(-5, -1).reverse().map(l => ({ dir: l.dir, from: l.start.t, to: l.end.t, move: l.move })),
  };
}
