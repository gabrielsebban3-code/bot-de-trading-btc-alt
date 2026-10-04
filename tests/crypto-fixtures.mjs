// Réponses fictives pour les fiches crypto (format des vraies API) : marchés OKX, bougies au comptant, funding en cours,
// comptes long / short, chiffres clés et présentation CoinGecko. Générées de façon déterministe jusqu'à maintenant.
// Les bougies du perpétuel et l'historique du funding de BTC, ETH, SOL et DOGE viennent des réponses des Setups et du Marché.
import { ASSETS } from './setups-fixtures.mjs';
import { fixtures } from './fixtures.mjs';

const H4 = 4 * 3_600_000;
const DAY = 86_400_000;

function rng(seed) {
  let x = seed;
  return () => ((x = (x * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
}

// [id, symbole, nom, prix d'arrivée, graine, paire au comptant sur OKX, levier max du perpétuel]
// DOGE n'a que le perpétuel (bougies du perpétuel), LEO n'est pas sur OKX (courbe CoinGecko).
export const COINS = [
  ['bitcoin', 'BTC', 'Bitcoin', 84_000, 41, true, 100],
  ['ethereum', 'ETH', 'Ethereum', 2_700, 42, true, 100],
  ['ripple', 'XRP', 'XRP', 1.5, 43, true, 75],
  ['solana', 'SOL', 'Solana', 120, 44, true, 50],
  ['dogecoin', 'DOGE', 'Dogecoin', 0.09, 45, false, 50],
  ['leo-token', 'LEO', 'LEO Token', 9.5, 46, false, null],
];
const BY_ID = new Map(COINS.map(c => [c[0], c]));

// Bougies de 4 h sur 1 400 jours (tendances qui changent de sens), puis bougies d'un jour qui les regroupent.
function candles(price, seed, now) {
  const r = rng(seed);
  const n = 1400 * 6;
  const end = Math.floor(now / H4) * H4;
  const raw = [];
  let p = 1;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 900 + seed) * 0.0012;
    const o = p;
    const c = o * (1 + (r() - 0.5) * 0.024 + drift);
    raw.push([end - (n - 1 - i) * H4, o, Math.max(o, c) * (1 + r() * 0.008), Math.min(o, c) * (1 - r() * 0.008), c, (1 + r() * 2) * 1e6]);
    p = c;
  }
  const k = price / raw.at(-1)[4]; // la dernière clôture tombe sur le prix voulu
  const h4 = raw.map(([t, o, h, l, c, v]) => [t, o * k, h * k, l * k, c * k, v * 40]);
  const days = new Map();
  for (const b of h4) {
    const d = Math.floor(b[0] / DAY) * DAY;
    const g = days.get(d);
    if (!g) days.set(d, [d, b[1], b[2], b[3], b[4], b[5]]);
    else { g[2] = Math.max(g[2], b[2]); g[3] = Math.min(g[3], b[3]); g[4] = b[4]; g[5] += b[5]; }
  }
  const okx = (rows, open) => rows.map((b, i) => [...b.slice(0, 5).map(String), String(b[5] / b[4]), String(b[5]), String(b[5]), i === rows.length - 1 && open ? '0' : '1']).reverse();
  return { h4: okx(h4, true), d1: okx([...days.values()], true) };
}

export function cryptoRoutes(now = Date.now()) {
  const data = {};
  for (const [id, sym, , price, seed] of COINS) data[id] = { ...candles(price, seed, now), sym };
  return data;
}

const DESC = {
  bitcoin: { fr: '<p>Le <a href="https://bitcoin.org">Bitcoin</a> est la première cryptomonnaie, créée en 2009 par Satoshi Nakamoto. Son offre est limitée à 21 millions d\'unités. Il sert de réserve de valeur.</p><p>Quatrième phrase qui ne doit pas apparaître dans le résumé, car il est déjà assez long avec les trois premières phrases du texte.</p>', en: 'Bitcoin is the first cryptocurrency.' },
  ethereum: { fr: '', en: 'Ethereum is a decentralized platform for smart contracts. Ether is its native currency.' },
};

export function routeCrypto(data, url) {
  const u = new URL(url);
  const q = k => u.searchParams.get(k);
  const ok = d => ({ code: '0', msg: '', data: d });
  if (u.host === 'www.okx.com') {
    const inst = q('instId') || '';
    switch (u.pathname) {
      case '/api/v5/public/instruments':
        // Mêmes paires que pour les Projets (badge « Sur OKX »), plus celles des fiches.
        if (q('instType') === 'SPOT') {
          return ok([...fixtures()['www.okx.com/api/v5/public/instruments'].data,
            ...COINS.filter(c => c[5]).map(c => ({ instId: `${c[1]}-USDT`, baseCcy: c[1], quoteCcy: 'USDT', state: 'live' }))]);
        }
        if (q('instType') === 'SWAP') {
          // Mêmes marchés que les Setups (avec leur catégorie), plus XRP, et le levier maximum de chacun.
          const lever = new Map(COINS.map(c => [c[1], c[6]]));
          return ok([...ASSETS.map(([s]) => ({ instId: `${s}-USDT-SWAP`, settleCcy: 'USDT', state: 'live', instCategory: ['CL', 'NG'].includes(s) ? '4' : '1', lever: String(lever.get(s) ?? 20) })),
            { instId: 'XRP-USDT-SWAP', settleCcy: 'USDT', state: 'live', instCategory: '1', lever: '75' }]);
        }
        return undefined;
      case '/api/v5/market/candles':
      case '/api/v5/market/history-candles': {
        const coin = COINS.find(c => c[5] && inst === `${c[1]}-USDT`);
        if (!coin) return undefined; // perpétuels : réponses des Setups
        const rows = data[coin[0]][q('bar') === '1Dutc' ? 'd1' : 'h4'];
        if (u.pathname.endsWith('/candles')) return ok(rows.slice(0, 300));
        return ok(rows.filter(b => Number(b[0]) < Number(q('after'))).slice(0, 100));
      }
      case '/api/v5/public/funding-rate': {
        const t = Math.ceil(Date.now() / (8 * 3_600_000)) * 8 * 3_600_000;
        return ok([{ instId: inst, fundingRate: inst.startsWith('DOGE') ? '0.00045' : '0.0001', fundingTime: String(t), nextFundingTime: String(t + 8 * 3_600_000) }]);
      }
      case '/api/v5/public/funding-rate-history':
        // XRP n'est pas dans les Setups : historique toutes les 4 h (OKX le fait parfois), ramené à 8 h par le script.
        if (inst !== 'XRP-USDT-SWAP') return undefined;
        return ok(Array.from({ length: 100 }, (_, k) => ({ fundingTime: String(Math.floor(Date.now() / (4 * 3_600_000)) * 4 * 3_600_000 - k * 4 * 3_600_000), realizedRate: '0.00005' }))
          .filter(f => !q('after') || Number(f.fundingTime) < Number(q('after'))));
      case '/api/v5/rubik/stat/contracts/long-short-account-ratio': {
        const r = rng(q('ccy').charCodeAt(0));
        return ok(Array.from({ length: 90 }, (_, k) => [String(Math.floor(Date.now() / DAY) * DAY - k * DAY), String(0.8 + r() * 0.9)]));
      }
      default:
        return undefined;
    }
  }
  if (u.host !== 'api.coingecko.com') return undefined;
  const path = u.pathname.replace('/api/v3', '');
  if (path === '/coins/markets' && q('ids')) {
    const ids = q('ids').split(',');
    if (!ids.every(id => BY_ID.has(id))) return undefined; // demandes des Projets
    return ids.map(id => {
      const [, sym, name, price] = BY_ID.get(id);
      const rank = COINS.findIndex(c => c[0] === id) + 1;
      return { id, symbol: sym.toLowerCase(), name, image: null, current_price: price, market_cap: 1.7e12 / rank, market_cap_rank: rank,
        fully_diluted_valuation: id === 'ripple' ? 1.7e12 / rank * 1.7 : 1.7e12 / rank, total_volume: 2e10 / rank, high_24h: price * 1.02, low_24h: price * 0.97,
        price_change_percentage_24h_in_currency: 1.2 - rank, price_change_percentage_7d_in_currency: 3 - rank, price_change_percentage_30d_in_currency: 8 - rank * 2,
        price_change_percentage_1y_in_currency: 40 - rank * 10, ath: price * 1.3, ath_date: '2025-10-06T18:00:00.000Z', ath_change_percentage: -23.1,
        atl: price / 50, atl_date: '2015-01-14T00:00:00.000Z', circulating_supply: 19.9e6 * rank, total_supply: 19.9e6 * rank, max_supply: id === 'ethereum' ? null : 21e6 * rank };
    });
  }
  const coin = path.match(/^\/coins\/([a-z0-9-]+)$/)?.[1];
  if (coin && BY_ID.has(coin)) {
    const [, sym, name] = BY_ID.get(coin);
    return {
      id: coin, symbol: sym.toLowerCase(), name, genesis_date: coin === 'bitcoin' ? '2009-01-03' : null,
      categories: ['Cryptocurrency', 'Layer 1 (L1)', '', 'Proof of Work (PoW)', 'Smart Contract Platform'],
      description: DESC[coin] || { en: `${name} is a cryptocurrency.`, fr: '' },
      links: {
        homepage: [`https://${coin}.org`, ''], whitepaper: coin === 'bitcoin' ? 'https://bitcoin.org/bitcoin.pdf' : '', twitter_screen_name: sym.toLowerCase(),
        subreddit_url: coin === 'bitcoin' ? 'https://www.reddit.com/r/Bitcoin/' : 'https://www.reddit.com', repos_url: { github: [`https://github.com/${coin}/${coin}`] },
        blockchain_site: ['', `https://explorer.${coin}.org`],
      },
    };
  }
  const chart = path.match(/^\/coins\/([a-z0-9-]+)\/market_chart$/)?.[1];
  if (chart && BY_ID.has(chart)) {
    const [, , , price, seed] = BY_ID.get(chart);
    const r = rng(seed);
    const today = Math.floor(Date.now() / DAY) * DAY;
    const prices = Array.from({ length: 731 }, (_, i) => [today - (730 - i) * DAY, price * (0.7 + 0.3 * (i / 730)) * (1 + (r() - 0.5) * 0.02)]);
    prices.push([Date.now(), price]);
    return { prices, total_volumes: prices.map(([t]) => [t, 2e6 * (1 + r())]), market_caps: [] };
  }
  return undefined;
}
