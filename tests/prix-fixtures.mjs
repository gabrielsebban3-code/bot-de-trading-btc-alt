// Réponses fictives pour scripts/build-prix.mjs : paires OKX au comptant (bougies journalières depuis 2018)
// et cours euro / dollar de la BCE (frankfurter).

const DAY = 86_400_000;
const COINS = [['BTC', 14_000, 11], ['ETH', 750, 12], ['SOL', 1.5, 13], ['XRP', 0.35, 14], ['DOGE', 0.003, 15]];

function rng(seed) {
  let x = seed;
  return () => ((x = (x * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
}

export function prixRoutes(now = Date.now()) {
  const end = Math.floor(now / DAY) * DAY;
  const start = Date.UTC(2018, 0, 1);
  const data = {};
  for (const [sym, price, seed] of COINS) {
    const r = rng(seed);
    let p = price;
    const rows = [];
    for (let t = start; t <= end; t += DAY) {
      p *= 1 + (r() - 0.48) * 0.06;
      rows.push([String(t), String(p), String(p * 1.02), String(p * 0.98), String(p), '0', '0', '0', t === end ? '0' : '1']);
    }
    data[sym] = rows.reverse(); // du plus récent au plus ancien, comme OKX
  }
  return data;
}

export function routePrix(data, url) {
  const u = new URL(url);
  const q = k => u.searchParams.get(k);
  const ok = d => ({ code: '0', msg: '', data: d });
  if (u.host.startsWith('api.frankfurter')) {
    const m = /\/(\d{4}-\d{2}-\d{2})\.\./.exec(u.pathname);
    const rates = {};
    for (let t = Date.parse(`${m[1]}T00:00:00Z`); t <= Date.now(); t += DAY) {
      const wd = new Date(t).getUTCDay();
      if (wd !== 0 && wd !== 6) rates[new Date(t).toISOString().slice(0, 10)] = { EUR: 0.9 };
    }
    return { base: 'USD', rates };
  }
  if (u.host !== 'www.okx.com') return undefined;
  const id = q('instId') || '';
  if (u.pathname === '/api/v5/public/instruments' && q('instType') === 'SPOT') {
    return ok(Object.keys(data).map(s => ({ instId: `${s}-USDT`, baseCcy: s, quoteCcy: 'USDT', state: 'live' })));
  }
  if (!/^[A-Z0-9]+-USDT$/.test(id) || q('bar') !== '1Dutc') return undefined;
  const rows = data[id.replace('-USDT', '')];
  if (!rows) return { code: '51001', msg: 'Instrument ID does not exist', data: [] };
  if (u.pathname === '/api/v5/market/candles') return ok(rows.slice(0, 300));
  if (u.pathname === '/api/v5/market/history-candles') return ok(rows.filter(b => Number(b[0]) < Number(q('after'))).slice(0, 100));
  return undefined;
}
