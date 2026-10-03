// Heatmap marché : calculs purs (tri des cryptos, couleurs, placement des tuiles), sans accès au DOM.
// Testés dans tests/heatmap.test.mjs.

// Périodes proposées, avec la variation qui donne la couleur la plus franche.
export const PERIODS = {
  '1h': { label: '1 h', key: 'price_change_percentage_1h_in_currency', full: 3 },
  '24h': { label: '24 h', key: 'price_change_percentage_24h_in_currency', full: 8 },
  '7d': { label: '7 j', key: 'price_change_percentage_7d_in_currency', full: 20 },
};

// Stablecoins et versions « emballées » ou stakées d'un autre actif (WBTC, stETH…) : ils doublonneraient BTC et ETH
// ou resteraient gris à 0 %.
const STABLE = /USD|^EUR|^DAI$|^GHO$|^FRAX$|^BUIDL$|^USYC$|^XSGD$/i;
const COPY_NAME = /wrapped|staked|bridged|\bpeg(ged)?\b|restaked/i;
const COPY_SYMBOL = new Set(['WBTC', 'WETH', 'STETH', 'WSTETH', 'WEETH', 'CBBTC', 'CBETH', 'RETH', 'METH', 'CMETH', 'OSETH', 'EZETH', 'RSETH',
  'JITOSOL', 'MSOL', 'BNSOL', 'JUPSOL', 'SOLVBTC', 'LBTC', 'TBTC', 'BTCB', 'CLBTC', 'FBTC', 'EBTC', 'WBETH', 'SAVAX', 'STKAAVE']);

export const isStableOrCopy = c => STABLE.test(c.symbol || '') || COPY_SYMBOL.has(String(c.symbol || '').toUpperCase()) || COPY_NAME.test(c.name || '');

// Réponse de CoinGecko /coins/markets → tuiles : sans stablecoins ni copies, sans market cap inconnue, `top` premières.
export function coins(raw, top = 100) {
  return (Array.isArray(raw) ? raw : [])
    .filter(c => c && c.market_cap > 0 && !isStableOrCopy(c))
    .slice(0, top)
    .map(c => ({
      id: c.id, symbol: String(c.symbol).toUpperCase(), name: c.name, image: c.image,
      price: c.current_price, mcap: c.market_cap, volume: c.total_volume, rank: c.market_cap_rank,
      change: Object.fromEntries(Object.entries(PERIODS).map(([k, p]) => [k, num(c[p.key] ?? (k === '24h' ? c.price_change_percentage_24h : null))])),
    }));
}
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Couleur d'une variation en % : gris à 0, vert ou rouge de plus en plus franc jusqu'à `full` %.
const GREY = [42, 45, 53], GREEN = [22, 163, 74], RED = [220, 38, 38];
export function tileColor(change, full) {
  if (change === null || change === undefined) return `rgb(${GREY.join(', ')})`;
  const t = Math.min(1, Math.abs(change) / full) ** 0.75;
  const to = change >= 0 ? GREEN : RED;
  return `rgb(${GREY.map((g, i) => Math.round(g + (to[i] - g) * t)).join(', ')})`;
}

// Moyenne pondérée par la market cap, et nombre de hausses et de baisses.
export function summary(list, period) {
  let w = 0, s = 0, up = 0, down = 0;
  for (const c of list) {
    const v = c.change[period];
    if (v === null) continue;
    w += c.mcap; s += c.mcap * v;
    if (v > 0) up++; else if (v < 0) down++;
  }
  return { avg: w ? s / w : null, up, down };
}

// Treemap « squarified » (Bruls, Huizing, van Wijk) : des tuiles aussi carrées que possible.
// `values` triées par ordre décroissant ; renvoie un rectangle {x, y, w, h} par valeur, dans le même ordre.
export function squarify(values, x, y, w, h) {
  const total = values.reduce((a, b) => a + b, 0);
  const out = [];
  if (!total || w <= 0 || h <= 0) return values.map(() => ({ x, y, w: 0, h: 0 }));
  const areas = values.map(v => (v / total) * w * h);
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    let row = [areas[i]], j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) row.push(areas[j++]);
    const sum = row.reduce((a, b) => a + b, 0);
    const thick = sum / side;
    let pos = 0;
    for (const a of row) {
      const len = a / thick;
      out.push(w >= h ? { x, y: y + pos, w: thick, h: len } : { x: x + pos, y, w: len, h: thick });
      pos += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    i = j;
  }
  return out;
}

function worst(row, side) {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row), min = Math.min(...row);
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}
