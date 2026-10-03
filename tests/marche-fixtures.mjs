// Réponses fictives pour l'onglet Marché (format des vraies API), générées de façon déterministe jusqu'à aujourd'hui.
const DAY = 86_400_000;

function rng(seed) {
  let x = seed;
  return () => ((x = (x * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
}

function walk(start, n, seed, vol) {
  const r = rng(seed);
  let p = start;
  return Array.from({ length: n }, (_, i) => (p *= 1 + (r() - 0.48) * vol + Math.sin(i / 120) * vol * 0.1));
}

export function marcheRoutes(now = Date.now()) {
  const today = Math.floor(now / DAY) * DAY;
  const days = n => Array.from({ length: n }, (_, i) => today - (n - 1 - i) * DAY);
  const candles = {};
  for (const [sym, start, seed] of [['BTC', 30_000, 11], ['ETH', 1_800, 12], ['SOL', 25, 13]]) {
    const t = days(1400), w = walk(start, 1400, seed, 0.035);
    candles[`${sym}-USDT`] = t.map((d, i) => [String(d), '0', '0', '0', String(w[i]), '0', '0', '0', i === t.length - 1 ? '0' : '1']).reverse();
  }
  const r = rng(21);
  const fng = days(2000).map(d => ({ value: String(Math.round(50 + 35 * Math.sin(d / DAY / 40) + (r() - 0.5) * 10)), timestamp: String(d / 1000) })).reverse();
  const st = walk(120e9, 1600, 22, 0.006);
  const tvl = walk(60e9, 1600, 23, 0.02);
  const funding = Array.from({ length: 270 }, (_, k) => ({ fundingTime: String(today - k * 8 * 3600_000), realizedRate: String((r() - 0.35) * 0.0004) }));
  const oi = walk(8e9, 180, 24, 0.03);
  return {
    candles,
    fng,
    stables: days(1600).map((d, i) => ({ date: String(d / 1000), totalCirculatingUSD: { peggedUSD: st[i] } })),
    tvl: days(1600).map((d, i) => ({ date: d / 1000, tvl: tvl[i] })),
    funding,
    oi: days(180).map((d, i) => [String(d), i === 179 ? '0' : String(oi[i]), String(oi[i] * 3)]).reverse(), // OKX : jour en cours parfois à 0
  };
}

const COINS = [
  ['bitcoin', 'btc', 'Bitcoin', 84_000], ['ethereum', 'eth', 'Ethereum', 2_700], ['tether', 'usdt', 'Tether', 1],
  ['ripple', 'xrp', 'XRP', 1.5], ['solana', 'sol', 'Solana', 120], ['usd-coin', 'usdc', 'USDC', 1],
  ['lido-staked-ether', 'steth', 'Lido Staked Ether', 2_700], ['dogecoin', 'doge', 'Dogecoin', 0.09],
];

export function routeMarche(data, url) {
  const u = new URL(url);
  const q = k => u.searchParams.get(k);
  const ok = d => ({ code: '0', msg: '', data: d });
  const p = u.host + u.pathname;
  if (u.host === 'www.okx.com') {
    const c = data.candles[q('instId')];
    if (u.pathname === '/api/v5/market/candles' && c) return ok(c.slice(0, 300));
    if (u.pathname === '/api/v5/market/history-candles' && c) return ok(c.filter(b => Number(b[0]) < Number(q('after'))).slice(0, 100));
    if (u.pathname === '/api/v5/public/funding-rate-history' && q('instId') === 'BTC-USDT-SWAP') {
      const after = Number(q('after') || Infinity);
      return ok(data.funding.filter(f => Number(f.fundingTime) < after).slice(0, 100));
    }
    if (u.pathname === '/api/v5/rubik/stat/contracts/open-interest-volume') return ok(data.oi);
    return undefined;
  }
  if (p === 'api.alternative.me/fng/' && q('limit') === '0') return { data: data.fng };
  if (p === 'stablecoins.llama.fi/stablecoincharts/all') return data.stables;
  if (p === 'api.llama.fi/v2/historicalChainTvl') return data.tvl;
  if (p === 'api.llama.fi/overview/dexs') return { total24h: 7.7e9, change_1d: -4.2 };
  if (p === 'api.llama.fi/overview/derivatives') return { total24h: 26.6e9, change_1d: 3.1 };
  if (p === 'api.llama.fi/overview/fees' && !q('dataType')) return { total24h: 84.9e6, change_1d: 1.2 };
  if (p === 'api.coingecko.com/api/v3/coins/markets' && !q('ids')) {
    return COINS.map(([id, symbol, name, price], i) => ({ id, symbol, name, current_price: price, market_cap: 1.7e12 / (i + 1), total_volume: 2e10 / (i + 1),
      price_change_percentage_24h_in_currency: -2.5 + i * 0.4, price_change_percentage_7d_in_currency: 1 - i, price_change_percentage_30d_in_currency: 4 - i * 1.5 }));
  }
  return undefined;
}
