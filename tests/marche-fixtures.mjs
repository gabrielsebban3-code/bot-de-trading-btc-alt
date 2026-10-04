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
  // Agenda ForexFactory : dates avec fuseau (heure de New York) ou en UTC ; seules les annonces fortes américaines
  // et les décisions de taux BCE / Banque du Japon restent.
  const iso = ms => new Date(ms).toISOString();
  const agenda = [
    { title: 'FOMC Statement', country: 'USD', date: iso(now - 2 * DAY), impact: 'High', forecast: '', previous: '' },
    { title: 'CPI m/m', country: 'USD', date: `${iso(now + DAY).slice(0, 10)}T08:30:00-04:00`, impact: 'High', forecast: '0.3%', previous: '0.4%' },
    { title: 'Unemployment Claims', country: 'USD', date: iso(now + 2 * DAY), impact: 'Medium', forecast: '230K', previous: '225K' },
    { title: 'German ZEW Economic Sentiment', country: 'EUR', date: iso(now + DAY), impact: 'High', forecast: '', previous: '' },
    { title: 'Main Refinancing Rate', country: 'EUR', date: iso(now + 3 * DAY), impact: 'High', forecast: '2.00%', previous: '2.00%' },
  ];
  return {
    agenda,
    candles,
    fng,
    stables: days(1600).map((d, i) => ({ date: String(d / 1000), totalCirculatingUSD: { peggedUSD: st[i] } })),
    tvl: days(1600).map((d, i) => ({ date: d / 1000, tvl: tvl[i] })),
    funding,
    oi: days(180).map((d, i) => [String(d), i === 179 ? '0' : String(oi[i]), String(oi[i] * 3)]).reverse(), // OKX : jour en cours parfois à 0
  };
}

// Secteurs (catégories CoinGecko), les plus gros d'abord ; un secteur sans capitalisation est ignoré.
const CATEGORIES = [
  { id: 'smart-contract-platform', name: 'Smart Contract Platform', market_cap: 2.1e12, market_cap_change_24h: -0.8, volume_24h: 7e10, top_3_coins_id: ['bitcoin', 'ethereum', 'solana'] },
  { id: 'layer-1', name: 'Layer 1 (L1)', market_cap: 2e12, market_cap_change_24h: -0.6, volume_24h: 6e10, top_3_coins_id: ['bitcoin', 'ethereum', 'ripple'] },
  { id: 'decentralized-finance-defi', name: 'Decentralized Finance (DeFi)', market_cap: 1.1e11, market_cap_change_24h: 1.3, volume_24h: 8e9, top_3_coins_id: ['chainlink', 'uniswap', 'aave'] },
  { id: 'meme-token', name: 'Meme', market_cap: 6e10, market_cap_change_24h: 4.2, volume_24h: 5e9, top_3_coins_id: ['dogecoin', 'shiba-inu', 'pepe'] },
  { id: 'artificial-intelligence', name: 'Artificial Intelligence (AI)', market_cap: 3e10, market_cap_change_24h: null, volume_24h: 3e9, top_3_coins_id: [] },
  { id: 'gaming', name: 'Gaming (GameFi)', market_cap: 0, market_cap_change_24h: 2, volume_24h: 0, top_3_coins_id: [] },
];

const COINS = [
  ['bitcoin', 'btc', 'Bitcoin', 84_000], ['ethereum', 'eth', 'Ethereum', 2_700], ['tether', 'usdt', 'Tether', 1],
  ['ripple', 'xrp', 'XRP', 1.5], ['solana', 'sol', 'Solana', 120], ['usd-coin', 'usdc', 'USDC', 1],
  ['lido-staked-ether', 'steth', 'Lido Staked Ether', 2_700], ['dogecoin', 'doge', 'Dogecoin', 0.09],
  ['figure-heloc', 'figr_heloc', 'Figure Heloc', 1.02], ['leo-token', 'leo', 'LEO Token', 9.5],
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
  // Dérivés de toutes les plateformes chez CoinGecko (volumes et open interest en BTC, parfois en texte ou absents).
  if (p === 'api.coingecko.com/api/v3/derivatives/exchanges') {
    return [{ id: 'binance_futures', name: 'Binance (Futures)', open_interest_btc: 300_000, trade_volume_24h_btc: '900000.5' },
      { id: 'okex_swap', name: 'OKX (Futures)', open_interest_btc: 120_000, trade_volume_24h_btc: '400000' },
      { id: 'petite', name: 'Petite plateforme', open_interest_btc: null, trade_volume_24h_btc: null }];
  }
  // Les plus grosses cryptos, puis 50 altcoins fictifs aux variations variées (pour la saison des altcoins).
  if (p === 'api.coingecko.com/api/v3/coins/markets' && !q('ids')) {
    return [...COINS.map(([id, symbol, name, price], i) => ({ id, symbol, name, current_price: price, market_cap: 1.7e12 / (i + 1), total_volume: 2e10 / (i + 1),
      price_change_percentage_24h_in_currency: -2.5 + i * 0.4, price_change_percentage_7d_in_currency: 1 - i, price_change_percentage_30d_in_currency: 4 - i * 1.5 })),
    ...Array.from({ length: 50 }, (_, k) => ({ id: `alt-${k + 1}`, symbol: `alt${k + 1}`, name: `Altcoin ${k + 1}`, current_price: 1 + k,
      market_cap: 1.7e12 / (k + 11), total_volume: 2e10 / (k + 11), price_change_percentage_24h_in_currency: ((k * 13) % 9) - 4,
      price_change_percentage_7d_in_currency: ((k * 7) % 15) - 7, price_change_percentage_30d_in_currency: ((k * 37) % 41) - 18 }))];
  }
  if (p === 'api.coingecko.com/api/v3/coins/categories') return CATEGORIES;
  // ForexFactory : la semaine en cours ; la suivante n'est pas encore publiée.
  if (p === 'nfs.faireconomy.media/ff_calendar_thisweek.json') return data.agenda;
  return undefined;
}
