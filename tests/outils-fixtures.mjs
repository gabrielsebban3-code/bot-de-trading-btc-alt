// Réponses fictives pour scripts/build-outils.mjs en mode --sample : tableaux Farside, funding OKX et Hyperliquid,
// ratio long / short OKX, taux de l'euro. Les tickers OKX viennent de setups-fixtures.mjs.

const DAY = 86_400_000;
const END = Date.UTC(2026, 9, 2) / DAY;
// Suite pseudo-aléatoire fixe : les données d'essai ne changent pas d'une fois sur l'autre.
const rand = seed => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

const BTC = ['IBIT', 'FBTC', 'BITB', 'ARKB', 'BTCO', 'EZBC', 'BRRR', 'HODL', 'BTCW', 'GBTC', 'BTC'];
const ETH = ['ETHA', 'FETH', 'ETHW', 'CETH', 'ETHV', 'QETH', 'EZET', 'ETHE', 'ETH'];

const cell = v => (v === 0 ? '-' : v < 0 ? `(${(-v).toFixed(1)})` : v.toFixed(1));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const farsideDate = d => {
  const t = new Date(d * DAY);
  return `${String(t.getUTCDate()).padStart(2, '0')} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
};

// Tableau comme sur farside.co.uk : noms des émetteurs, codes boursiers, frais, un jour de bourse par ligne, totaux.
function farside(issuers, days, scale, seed) {
  const r = rand(seed);
  const rows = [];
  for (let d = END - days; d <= END; d++) {
    const wd = new Date(d * DAY).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const mood = Math.sin(d / 23) * 0.6 + (r() - 0.45);
    const flows = issuers.map((_, i) => (r() < 0.35 ? 0 : Math.round((mood + (r() - 0.5)) * scale / (i + 1)) / 10));
    rows.push(`<tr><td>${farsideDate(d)}</td>${flows.map(v => `<td>${cell(v)}</td>`).join('')}<td>${cell(Math.round(flows.reduce((s, v) => s + v, 0) * 10) / 10)}</td></tr>`);
  }
  return `<table class="etf"><tr><th></th>${issuers.map(() => '<th>Issuer</th>').join('')}<th></th></tr>
    <tr><th></th>${issuers.map(c => `<th>${c}</th>`).join('')}<th>Total</th></tr>
    <tr><td>Fee</td>${issuers.map(() => '<td>0.25%</td>').join('')}<td></td></tr>
    ${rows.join('\n')}
    <tr><td>Total</td>${issuers.map(() => '<td>0</td>').join('')}<td>0</td></tr></table>`;
}

const SYMS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'ADA', 'LINK', 'AVAX', 'SUI'];

export function routeOutils(url) {
  const u = new URL(url);
  const q = k => u.searchParams.get(k);
  const ok = d => ({ code: '0', msg: '', data: d });
  if (u.host === 'farside.co.uk') {
    if (/^\/(bitcoin-etf-flow-all-data|btc)\/$/.test(u.pathname)) return farside(BTC, u.pathname.includes('all') ? 640 : 30, 2500, 7);
    if (/^\/(ethereum-etf-flow-all-data|eth)\/$/.test(u.pathname)) return farside(ETH, u.pathname.includes('all') ? 440 : 30, 900, 11);
    return undefined;
  }
  if (u.host === 'www.okx.com') {
    if (u.pathname === '/api/v5/public/funding-rate') {
      const sym = (q('instId') || '').split('-')[0];
      const i = Math.max(0, SYMS.indexOf(sym));
      return ok([{ instId: q('instId'), fundingRate: String((0.0001 - i * 0.00003).toFixed(6)), nextFundingTime: String((END + 1) * DAY) }]);
    }
    if (u.pathname === '/api/v5/rubik/stat/contracts/long-short-account-ratio') {
      const r = rand(q('ccy') === 'ETH' ? 5 : 3);
      return ok(Array.from({ length: 180 }, (_, i) => [String((END - i) * DAY), (1.6 + Math.sin(i / 17) * 0.5 + r() * 0.3).toFixed(2)]));
    }
    return undefined;
  }
  if (u.host === 'api.hyperliquid.xyz') {
    return [{ universe: SYMS.map(name => ({ name })) }, SYMS.map((_, i) => ({ funding: String((0.0000125 - i * 0.000004).toFixed(7)) }))];
  }
  if (u.host === 'api.frankfurter.app') return { amount: 1, base: 'EUR', date: '2026-10-02', rates: { USD: 1.1225 } };
  return undefined;
}
