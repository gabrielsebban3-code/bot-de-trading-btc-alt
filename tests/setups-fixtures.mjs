// Réponses OKX fictives pour l'onglet Setups (format des vraies API).
// Les bougies sont générées de façon déterministe et se terminent maintenant, avec une bougie 4h encore ouverte.

const BAR = 4 * 3600_000;
const DAY = 86_400_000;

function rng(seed) {
  let x = seed;
  return () => ((x = (x * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
}

// Marche aléatoire avec une dérive qui change de sens et quelques impulsions, pour avoir des tendances et des cassures.
function walk(start, n, seed, vol = 0.012) {
  const r = rng(seed);
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const impulse = r() < 0.03 ? (r() < 0.5 ? -1 : 1) * vol * 4 : 0;
    const drift = Math.sin(i / 180) * vol * 0.25;
    const o = p;
    const c = o * (1 + (r() - 0.5) * vol * 2 + impulse + drift);
    const h = Math.max(o, c) * (1 + r() * vol * 0.8);
    const l = Math.min(o, c) * (1 - r() * vol * 0.8);
    const v = (1 + r() * 2 + (impulse ? 3 : 0)) * 1e6;
    out.push([o, h, l, c, v]);
    p = c;
  }
  return out;
}

// DOGE et CL sont listés sur OKX mais ne font pas partie des paires suivies.
export const ASSETS = [
  ['BTC', 'Bitcoin', 85_000, 1], ['ETH', 'Ethereum', 3_800, 2], ['SOL', 'Solana', 180, 3], ['BZ', 'Pétrole Brent', 68, 7],
  ['DOGE', 'Dogecoin', 0.41, 4], ['CL', 'Pétrole WTI', 64, 8],
];

export function setupRoutes(now = Date.now()) {
  const end4h = Math.floor(now / BAR) * BAR;       // bougie 4h en cours
  const endDay = Math.floor(now / DAY) * DAY;
  const data = {};
  for (const [sym, , price, seed] of ASSETS) {
    const n = 2600;
    const w = walk(price, n, seed);
    const bars = w.map(([o, h, l, c, v], i) => {
      const t = end4h - (n - 1 - i) * BAR;
      return [String(t), String(o), String(h), String(l), String(c), String(v), String(v / c), String(v), i === n - 1 ? '0' : '1'];
    }).reverse(); // OKX renvoie du plus récent au plus ancien
    const days = [];
    const nDays = Math.floor((n * BAR) / DAY);
    for (let d = 0; d < nDays; d++) {
      const t = endDay - (nDays - 1 - d) * DAY;
      const inDay = w.filter((_, i) => { const bt = end4h - (n - 1 - i) * BAR; return bt >= t && bt < t + DAY; });
      if (!inDay.length) continue;
      days.push([String(t), String(inDay[0][0]), String(Math.max(...inDay.map(b => b[1]))), String(Math.min(...inDay.map(b => b[2]))), String(inDay.at(-1)[3]), '0', '0', String(inDay.reduce((v, b) => v + b[4], 0)), t === endDay ? '0' : '1']);
    }
    data[sym] = { bars, days: days.reverse(), last: Number(bars[0][4]), open24h: Number(bars[6][1]) };
  }
  return data;
}

const rows = (d, bar) => (bar === '1Dutc' ? d.days : d.bars);

export function routeSetups(data, url) {
  const u = new URL(url);
  const q = k => u.searchParams.get(k);
  const ok = d => ({ code: '0', msg: '', data: d });
  if (u.host !== 'www.okx.com') return undefined;
  const sym = (q('instId') || '').replace('-USDT-SWAP', '');
  switch (u.pathname) {
    case '/api/v5/public/instruments':
      if (q('instType') !== 'SWAP') return undefined;
      return ok(ASSETS.map(([s]) => ({ instId: `${s}-USDT-SWAP`, settleCcy: 'USDT', state: 'live', instCategory: ['CL', 'NG'].includes(s) ? '4' : '1' })));
    case '/api/v5/market/tickers':
      return ok(ASSETS.map(([s]) => ({ instId: `${s}-USDT-SWAP`, last: String(data[s].last), open24h: String(data[s].open24h), volCcy24h: '1000' })));
    case '/api/v5/market/candles':
      return ok(rows(data[sym], q('bar')).slice(0, 300));
    case '/api/v5/market/history-candles': {
      const after = Number(q('after'));
      return ok(rows(data[sym], q('bar')).filter(b => Number(b[0]) < after).slice(0, 100));
    }
    default:
      return undefined;
  }
}
