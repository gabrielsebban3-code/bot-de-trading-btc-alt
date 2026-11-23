// Outil « Liquidations » : où sont les vrais prix de liquidation des positions ouvertes sur Hyperliquid.
// Sur Hyperliquid, chaque compte est public : on lit les positions des plus gros comptes et leur prix de
// liquidation exact (pas une estimation). Calculé par le script de données, affiché par js/outils.js.
// Testé dans tests/liquidations.test.mjs.

// Positions d'un compte (réponse « clearinghouseState » d'Hyperliquid) → liste simple pour une crypto.
export function positionsOf(state, coin) {
  const out = [];
  for (const a of state?.assetPositions || []) {
    const p = a?.position;
    if (!p || p.coin !== coin) continue;
    const size = Number(p.szi);
    const liq = Number(p.liquidationPx);
    const value = Math.abs(Number(p.positionValue));
    if (!size || !(value > 0)) continue;
    out.push({ side: size > 0 ? 'long' : 'short', value, entry: Number(p.entryPx), liq: liq > 0 ? liq : null, lev: Number(p.leverage?.value) || null });
  }
  return out;
}

// Regroupe les liquidations par tranche de prix autour du prix actuel.
// step = largeur d'une tranche en % du prix ; range = jusqu'où on regarde, en % au-dessus et en dessous.
// Les longs sont liquidés si le prix baisse (prix de liquidation sous le prix actuel), les shorts s'il monte.
export function liquidationMap(positions, price, { step = 0.5, range = 25 } = {}) {
  const n = Math.round(range / step);
  const buckets = Array.from({ length: 2 * n }, (_, i) => {
    const lo = price * (1 + (i - n) * step / 100);
    return { lo, hi: price * (1 + (i - n + 1) * step / 100), long: 0, short: 0 };
  });
  let longs = 0, shorts = 0, noLiq = 0, far = 0;
  for (const p of positions) {
    if (p.side === 'long') longs += p.value; else shorts += p.value;
    if (p.liq == null) { noLiq += p.value; continue; }
    const i = Math.floor(((p.liq / price - 1) * 100) / step) + n;
    if (i < 0 || i >= buckets.length) { far += p.value; continue; }
    // Un long liquidé au-dessus du prix actuel ou un short en dessous : déjà en train de partir, on le compte quand même.
    buckets[i][p.side] += p.value;
  }
  // Cumul : combien serait liquidé si le prix allait jusqu'à ce niveau (en partant du prix actuel).
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) { acc += buckets[i].long; buckets[i].cumDown = acc; }
  acc = 0;
  for (let i = n; i < buckets.length; i++) { acc += buckets[i].short; buckets[i].cumUp = acc; }
  const below = buckets.slice(0, n).filter(b => b.long > 0);
  const above = buckets.slice(n).filter(b => b.short > 0);
  const top = (list, k) => [...list].sort((a, b) => b[k] - a[k]).slice(0, 3).map(b => ({ price: (b.lo + b.hi) / 2, value: b[k] }));
  return {
    price,
    step,
    range,
    buckets: buckets.map(b => [Math.round((b.lo + b.hi) / 2 * 100) / 100, Math.round(b.long), Math.round(b.short)]),
    longs, shorts, noLiq, far,
    within: (pct, side) => buckets.filter(b => (side === 'long' ? b.lo >= price * (1 - pct / 100) && b.hi <= price : b.lo >= price && b.hi <= price * (1 + pct / 100))).reduce((s, b) => s + b[side], 0),
    topLong: top(below, 'long'),
    topShort: top(above, 'short'),
  };
}

// Résumé à publier (sans fonction) : la carte, les totaux, et ce qui serait liquidé à ±2, 5 et 10 %.
export function liquidationSummary(positions, price, opts) {
  const m = liquidationMap(positions, price, opts);
  const near = [2, 5, 10].map(p => [p, Math.round(m.within(p, 'long')), Math.round(m.within(p, 'short'))]);
  const { within, ...rest } = m;
  return { ...rest, near, accounts: new Set(positions.map(p => p.account)).size };
}
