// Réponses d'API fictives, au format des vraies API (DefiLlama, CoinGecko, Binance, OKX).
// Servent aux tests et à générer des données d'exemple (npm run sample).

const DAY = 86_400;
const END = Math.floor(Date.UTC(2026, 8, 30) / 1000);

// Série journalière de 120 jours : base × tendance, avec une petite oscillation.
function series(base, growthPerDay, seed = 1) {
  return Array.from({ length: 120 }, (_, i) => {
    const t = END - (119 - i) * DAY;
    const v = base * (1 + growthPerDay) ** i * (1 + 0.15 * Math.sin(i * 0.7 + seed));
    return [t, Math.round(v)];
  });
}
const sumLast = (s, from, to) => s.slice(s.length - to, s.length - from).reduce((a, [, v]) => a + v, 0);

// [slug, nom, parent, chaîne, catégorie, revenu/jour, croissance/jour, gecko_id, ticker, mcap, circulant/total, levées, reversé aux détenteurs]
const P = [
  ['nebula-dex-v2', 'Nebula DEX V2', 'parent#nebula-dex', 'Base', 'Dexs', 30_000, 0.004, 'nebula-dex', 'NBL', 640e6, 0.62, [['Paradigm'], ['Coinbase Ventures']], 0.4],
  ['nebula-dex-cl', 'Nebula DEX CL', 'parent#nebula-dex', 'Base', 'Dexs', 12_000, 0.006, null, '-', null, null, null, 0.4],
  ['orbit-lend', 'Orbit Lend', null, 'Solana', 'Lending', 18_000, 0.003, 'orbit-lend', 'ORB', 380e6, 0.24, [['Multicoin'], []], 0],
  ['tidal-perps', 'Tidal Perps', null, 'Arbitrum', 'Derivatives', 14_000, 0.009, 'tidal-perps', 'TIDE', 210e6, 0.41, [[], ['Jump Crypto']], 0.25],
  ['quartz-yield', 'Quartz Yield', null, 'Ethereum', 'Yield', 6_000, -0.004, 'quartz-yield', 'QTZ', 95e6, 0.7, null, 0],
  ['ember-swap', 'Ember Swap', null, 'Solana', 'Dexs', 3_500, 0.012, 'ember-swap', 'EMB', 42e6, 0.18, null, 0.3],
  ['harbor-rwa', 'Harbor RWA', null, 'Ethereum', 'RWA', 9_000, 0.002, 'harbor-rwa', 'HRB', 520e6, 0.35, [['a16z crypto'], ['Circle Ventures']], 0],
  ['lumen-bridge', 'Lumen Bridge', null, 'Optimism', 'Bridge', 2_400, 0.001, 'lumen-bridge', 'LMN', 28e6, 0.55, null, 0],
  // Exclus : déjà sur Binance, trop gros, sans token, revenus trop faibles.
  ['big-chain', 'Big Chain', null, 'Ethereum', 'Dexs', 200_000, 0.001, 'big-chain', 'BIG', 4e9, 0.8, null, 0],
  ['listed-dex', 'Listed DEX', null, 'BSC', 'Dexs', 25_000, 0.002, 'listed-dex', 'LST', 300e6, 0.6, null, 0],
  ['no-token-app', 'No Token App', null, 'Base', 'Dexs', 20_000, 0.003, null, '-', null, null, null, 0],
  ['tiny-farm', 'Tiny Farm', null, 'Polygon', 'Yield', 300, 0.0, 'tiny-farm', 'TINY', 2e6, 0.9, null, 0],
];

const charts = Object.fromEntries(P.map(([slug, , , , , base, g], i) => [slug, series(base, g, i)]));

export function fixtures() {
  const feeEntry = (p, holders) => {
    const [slug, name, parent, chain, category, , , , , , , , share] = p;
    const s = charts[slug];
    const k = holders ? share : 1;
    return {
      defillamaId: String(1000 + P.indexOf(p)), name, displayName: name, slug, parentProtocol: parent || undefined,
      category, chains: [chain], total30d: Math.round(sumLast(s, 0, 30) * k), total60dto30d: Math.round(sumLast(s, 30, 60) * k),
    };
  };
  const routes = {
    'api.llama.fi/overview/fees?dailyRevenue': { protocols: P.map(p => feeEntry(p, false)) },
    'api.llama.fi/overview/fees?dailyHoldersRevenue': { protocols: P.filter(p => p[12] > 0).map(p => feeEntry(p, true)) },
    'api.llama.fi/protocols': P.map((p, i) => ({
      id: String(1000 + i), name: p[1], slug: p[0], symbol: p[8], gecko_id: p[7], parentProtocol: p[2] || undefined, mcap: p[9], category: p[4], chains: [p[3]],
    })),
    'api.llama.fi/lite/protocols2': { parentProtocols: [{ id: 'parent#nebula-dex', name: 'Nebula DEX', gecko_id: 'nebula-dex', symbol: 'NBL' }] },
    'data-api.binance.vision/api/v3/exchangeInfo': {
      symbols: [{ baseAsset: 'BTC', status: 'TRADING' }, { baseAsset: 'ETH', status: 'TRADING' }, { baseAsset: 'LST', status: 'TRADING' }],
    },
    'www.binance.com/bapi': { data: [{ symbol: 'EMB' }] },
    'www.okx.com/api/v5/public/instruments': { data: [{ baseCcy: 'ORB' }, { baseCcy: 'TIDE' }, { baseCcy: 'BTC' }] },
    'api.coingecko.com/api/v3/coins/markets': P.filter(p => p[7]).map(p => ({
      id: p[7], symbol: p[8].toLowerCase(), name: p[1], current_price: 1.23, price_change_percentage_24h: 2.5,
      market_cap: p[9], fully_diluted_valuation: p[9] / p[10], total_volume: p[9] * 0.05,
      circulating_supply: 1e8 * p[10], total_supply: 1e8, max_supply: 1e8,
    })),
    'api.coingecko.com/api/v3/search/trending': { coins: [{ item: { id: 'tidal-perps' } }] },
    'api.coingecko.com/api/v3/global': { data: { market_cap_percentage: { btc: 57.8 } } },
    'api.alternative.me/fng': { data: [{ value: '68', value_classification: 'Greed' }] },
  };
  for (const [slug, s] of Object.entries(charts)) routes[`api.llama.fi/summary/fees/${slug}`] = { totalDataChart: s };
  const details = {
    'nebula-dex': 0, 'orbit-lend': 2, 'tidal-perps': 3, 'quartz-yield': 4, 'ember-swap': 5, 'harbor-rwa': 6, 'lumen-bridge': 7,
  };
  for (const [slug, i] of Object.entries(details)) {
    const p = P[i];
    routes[`api.llama.fi/protocol/${slug}`] = {
      url: `https://${slug}.example`, twitter: slug.replace(/-/g, ''),
      tvl: Array.from({ length: 60 }, (_, d) => ({ date: END - (59 - d) * DAY, totalLiquidityUSD: p[5] * 2000 * (1 + p[6] * 1.5) ** d })),
      raises: p[11] ? [{ amount: 12, leadInvestors: p[11][0], otherInvestors: p[11][1] }] : [],
    };
  }
  return routes;
}

// Associe une URL à une route : le chemin, plus le dataType pour les vues d'ensemble DefiLlama.
export function route(routes, url) {
  const u = new URL(url);
  const path = u.host + u.pathname.replace(/\/$/, '');
  if (u.pathname.startsWith('/overview/fees')) return routes[`${path}?${u.searchParams.get('dataType')}`];
  if (u.host === 'www.binance.com') return routes['www.binance.com/bapi'];
  return routes[path];
}
