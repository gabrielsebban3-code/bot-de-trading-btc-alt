import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compute, dcaOps, importFile, makePriceAt, normalizeOp, num, parseCsv, parseDate, rates, standing, yearSummary,
} from '../js/fiscal-lib.js';

const D = s => Date.parse(`${s}T12:00:00Z`);
const DAY = 86_400_000;
const op = o => normalizeOp(o);
// Prix fixés à la main : BTC et ETH par période.
const prices = { BTC: [[D('2024-01-01'), 40000], [D('2024-06-01'), 60000], [D('2025-01-01'), 90000]], ETH: [[D('2024-01-01'), 2000], [D('2024-06-01'), 3000], [D('2025-01-01'), 3500]] };
const priceAt = (a, t) => { const l = prices[a]; if (!l) return null; let p = null; for (const [d, v] of l) if (t >= d) p = v; return p; };

test('taux : 30 % jusqu\'aux cessions de 2024, 31,4 % depuis 2025', () => {
  assert.deepEqual(rates(2024), { ir: 12.8, ps: 17.2, total: 30 });
  assert.deepEqual(rates(2025), { ir: 12.8, ps: 18.6, total: 31.4 });
  assert.equal(rates(2026).total, 31.4);
});

test('nombres saisis en français ou exportés en anglais', () => {
  assert.equal(num('1 234,56'), 1234.56);
  assert.equal(num('1,234.56'), 1234.56);
  assert.equal(num('€12.30'), 12.3);
  assert.equal(num('-€100.00'), -100);
  assert.equal(num('0,5'), 0.5);
  assert.equal(num('1,234,567'), 1234567);
  assert.equal(num(''), null);
  assert.equal(num('abc'), null);
});

test('formulaire 2086 : deux ventes, la part du prix d\'achat déjà déduite est reportée (ligne 221)', () => {
  // Achat 5 000 € de BTC (0,125 BTC à 40 000), puis vente de 2 000 € quand le portefeuille vaut 10 000 €.
  const ops = [
    op({ id: 'a1', date: D('2024-01-02'), type: 'achat', asset: 'BTC', qty: 0.125, eur: 5000 }),
    op({ id: 'v1', date: D('2024-07-01'), type: 'vente', asset: 'BTC', qty: 0.025, eur: 2000, portfolio: 10000 }),
    op({ id: 'a2', date: D('2024-08-01'), type: 'achat', asset: 'ETH', qty: 0.5, eur: 1000 }),
    op({ id: 'v2', date: D('2024-09-01'), type: 'vente', asset: 'ETH', qty: 0.4, eur: 3000, fee: 10, portfolio: 12000 }),
  ];
  const r = compute(ops, priceAt);
  const [c1, c2] = r.cessions;
  assert.equal(c1.l212, 10000);
  assert.equal(c1.l223, 5000);
  assert.equal(c1.l224, 1000); // 2 000 − 5 000 × 2 000 / 10 000
  assert.equal(c2.l220, 6000);
  assert.equal(c2.l221, 1000);
  assert.equal(c2.l223, 5000);
  assert.equal(c2.l218, 2990);
  assert.equal(c2.l224, 1740); // 2 990 − 5 000 × 3 000 / 12 000
  assert.equal(r.base, 3750); // 6 000 − 1 000 − 1 250
  const y = yearSummary(r.cessions, 2024);
  assert.equal(y.sales, 5000);
  assert.equal(y.gain, 2740);
  assert.equal(y.tax, 822); // 30 % en 2024
  assert.deepEqual(y.box, { key: '3AN', value: 2740 });
});

test('valeur du portefeuille calculée avec les prix du jour quand elle n\'est pas saisie', () => {
  const ops = [
    op({ id: 'a1', date: D('2024-01-02'), type: 'achat', asset: 'BTC', qty: 0.1, eur: 4000 }),
    op({ id: 'a2', date: D('2024-01-02'), type: 'achat', asset: 'ETH', qty: 1, eur: 2000 }),
    op({ id: 'v1', date: D('2024-07-01'), type: 'vente', asset: 'BTC', qty: 0.05, eur: 3000 }),
  ];
  const c = compute(ops, priceAt).cessions[0];
  assert.equal(c.l212, 9000); // 0,1 × 60 000 + 1 × 3 000
  assert.equal(c.l224, 1000); // 3 000 − 6 000 × 3 000 / 9 000
  assert.equal(c.estimated, false);
});

test('échange crypto contre crypto : aucun impôt, mais les quantités suivent', () => {
  const ops = [
    op({ date: D('2024-01-02'), type: 'achat', asset: 'BTC', qty: 0.1, eur: 4000 }),
    op({ date: D('2024-06-02'), type: 'echange', asset: 'BTC', qty: 0.1, to: 'ETH', toQty: 2 }),
  ];
  const r = compute(ops, priceAt);
  assert.equal(r.cessions.length, 0);
  assert.equal(r.holdings.get('ETH'), 2);
  assert.equal(r.holdings.has('BTC'), false);
  const s = standing(r, a => priceAt(a, D('2025-02-01')));
  assert.equal(s.value, 7000);
  assert.equal(s.gain, 3000);
});

test('305 € de ventes ou moins dans l\'année : rien à payer ; moins-value déclarée en 3BN', () => {
  const small = compute([
    op({ date: D('2024-01-02'), type: 'achat', asset: 'BTC', qty: 0.01, eur: 100 }),
    op({ date: D('2025-02-01'), type: 'vente', asset: 'BTC', qty: 0.003, eur: 270 }),
  ], priceAt);
  const y = yearSummary(small.cessions, 2025);
  assert.ok(y.gain > 0);
  assert.equal(y.exempt, true);
  assert.equal(y.tax, 0);
  assert.equal(y.box, null);
  const loss = compute([
    op({ date: D('2024-01-02'), type: 'achat', asset: 'BTC', qty: 0.1, eur: 6000 }),
    op({ date: D('2024-01-03'), type: 'vente', asset: 'BTC', qty: 0.1, eur: 4000 }),
  ], priceAt);
  const y2 = yearSummary(loss.cessions, 2024);
  assert.equal(y2.gain, -2000);
  assert.equal(y2.tax, 0);
  assert.deepEqual(y2.box, { key: '3BN', value: 2000 });
});

test('vente de plus que ce qu\'on détient : avertissement', () => {
  const r = compute([op({ id: 'x', date: D('2024-07-01'), type: 'vente', asset: 'BTC', qty: 1, eur: 60000 })], priceAt);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].id, 'x');
});

test('mode DCA : 100 € chaque mois, au prix du jour, fin de mois respectée', () => {
  const { ops } = dcaOps({ asset: 'btc', eur: '100', every: 'mois', from: D('2024-01-31'), to: D('2024-04-15'), feePct: 1 }, priceAt);
  assert.deepEqual(ops.map(o => new Date(o.date).toISOString().slice(0, 10)), ['2024-01-31', '2024-02-29', '2024-03-31']);
  assert.equal(ops[0].eur, 99);
  assert.equal(ops[0].fee, 1);
  assert.equal(ops[0].qty, 99 / 40000);
  assert.equal(dcaOps({ asset: 'BTC', eur: 50, every: 'semaine', from: D('2024-01-01'), to: D('2024-01-29') }, priceAt).ops.length, 5);
});

test('prix depuis les fichiers data/prix : clôtures en euros, stablecoins au cours du dollar', () => {
  const start = Date.UTC(2024, 0, 1);
  const p = makePriceAt(new Map([['BTC', { start, closes: [40000, 41000, 42000] }]]), { start, rates: [0.9, 0.91, 0.92] });
  assert.equal(p('BTC', start + DAY + 5000), 41000);
  assert.equal(p('BTC', start + 30 * DAY), 42000); // après la dernière clôture : la plus récente
  assert.equal(p('BTC', start - DAY), null);
  assert.equal(p('USDT', start + 2 * DAY), 0.92);
  assert.equal(p('EUR', start), 1);
  assert.equal(p('XYZ', start), null);
});

test('CSV : guillemets, point-virgule, dates des exports', () => {
  assert.deepEqual(parseCsv('a;b\n"x;1";"il dit ""oui"""\n'), [['a', 'b'], ['x;1', 'il dit "oui"']]);
  assert.equal(parseDate('2024-03-01 10:00:00 UTC'), Date.UTC(2024, 2, 1, 10));
  assert.equal(parseDate('2024-03-01 10:00:00'), Date.UTC(2024, 2, 1, 10));
  assert.equal(parseDate('24-03-01 10:00:00'), Date.UTC(2024, 2, 1, 10));
  assert.equal(parseDate('2024-03-01T10:00:00Z'), Date.UTC(2024, 2, 1, 10));
});

test('import Coinbase : achats, ventes, conversions et récompenses ; envois ignorés', () => {
  const csv = `Transactions
User,prenom@example.invalid,abc
ID,Timestamp,Transaction Type,Asset,Quantity Transacted,Price Currency,Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),Fees and/or Spread,Notes
1,2024-01-02 10:00:00 UTC,Buy,BTC,0.01,EUR,€40000.00,€400.00,€405.99,€5.99,Bought 0.01 BTC
2,2024-02-01 10:00:00 UTC,Convert,BTC,-0.005,EUR,€41000.00,€205.00,€205.00,€0.00,Converted 0.005 BTC to 0.1 ETH
3,2024-03-01 10:00:00 UTC,Staking Income,ETH,0.001,EUR,€3000.00,€3.00,€3.00,€0.00,
4,2024-04-01 10:00:00 UTC,Sell,ETH,-0.05,EUR,€3200.00,€160.00,€158.00,€2.00,Sold 0.05 ETH
5,2024-04-02 10:00:00 UTC,Send,ETH,-0.01,EUR,€3200.00,€32.00,€32.00,€0.00,
6,2024-05-01 10:00:00 UTC,Advanced Trade Buy,SOL,2,USDC,100,200,201,1,
7,2024-05-02 10:00:00 UTC,Mystery,SOL,1,EUR,€90,€90,€90,€0,`;
  const r = importFile(csv);
  assert.equal(r.format, 'coinbase');
  assert.deepEqual(r.ops.map(o => [o.type, o.asset, o.qty, o.eur ?? null, o.fee ?? null, o.to ?? null, o.toQty ?? null]), [
    ['achat', 'BTC', 0.01, 400, 5.99, null, null],
    ['echange', 'BTC', 0.005, null, null, 'ETH', 0.1],
    ['recompense', 'ETH', 0.001, null, null, null, null],
    ['vente', 'ETH', 0.05, 160, 2, null, null],
    ['echange', 'USDC', 201, null, null, 'SOL', 2],
  ]);
  assert.equal(r.skipped.length, 1);
});

test('import Binance : lignes d\'une même seconde regroupées en achat, vente ou échange', () => {
  const csv = `User_ID,UTC_Time,Account,Operation,Coin,Change,Remark
1,2024-01-02 10:00:00,Spot,Transaction Spend,EUR,-500,
1,2024-01-02 10:00:00,Spot,Transaction Buy,BTC,0.0125,
1,2024-01-02 10:00:00,Spot,Transaction Fee,BTC,-0.0000125,
1,2024-02-01 09:00:00,Spot,Transaction Sold,BTC,-0.005,
1,2024-02-01 09:00:00,Spot,Transaction Revenue,EUR,210,
1,2024-02-01 09:00:00,Spot,Transaction Fee,BNB,-0.001,
1,2024-03-01 08:00:00,Spot,Binance Convert,BTC,-0.002,
1,2024-03-01 08:00:00,Spot,Binance Convert,ETH,0.03,
1,2024-03-05 08:00:00,Earn,Simple Earn Flexible Interest,ETH,0.0001,
1,2024-03-06 08:00:00,Spot,Transfer Between Main and Funding Wallet,ETH,-0.01,
1,2024-03-06 08:00:00,Funding,Transfer Between Main and Funding Wallet,ETH,0.01,
1,2024-03-07 08:00:00,Spot,Deposit,SOL,3,
1,2024-03-08 08:00:00,Spot,Strange Thing,SOL,-1,`;
  const r = importFile(csv);
  assert.equal(r.format, 'binance');
  assert.deepEqual(r.ops.map(o => [o.type, o.asset, Number(o.qty.toFixed(8)), o.eur ?? null, o.to ?? null]), [
    ['recompense', 'ETH', 0.0001, null, null],
    ['achat', 'BTC', 0.0124875, 500, null],
    ['vente', 'BTC', 0.005, 210, null],
    ['echange', 'BTC', 0.002, null, 'ETH'],
  ]);
  assert.equal(r.skipped.length, 1); // « Strange Thing » ; le dépôt et le virement interne sont ignorés sans bruit
});

test('fichier inconnu : rien d\'importé', () => {
  assert.deepEqual(importFile('foo,bar\n1,2\n'), { format: null, ops: [], skipped: [] });
});

test('build-prix : prix en euros depuis 2018, puis seulement les derniers jours au passage suivant', async () => {
  const { execFile } = await import('node:child_process');
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const run = (...a) => new Promise((ok, ko) => execFile(process.execPath, ['--import', './tests/mock-fetch.mjs', 'scripts/build-prix.mjs', ...a], { env: { ...process.env, DINEXO_MOCK_PRIX: '1', PUBLISH: '' } }, (e, out) => (e ? ko(e) : ok(out))));
  const one = await mkdtemp(join(tmpdir(), 'prix-'));
  const two = await mkdtemp(join(tmpdir(), 'prix-'));
  await run('--out', one);
  const index = JSON.parse(await readFile(join(one, 'prix', 'index.json'), 'utf8'));
  assert.deepEqual(index.coins.map(c => c.symbol), ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']);
  assert.equal(index.usdEur.start, Date.UTC(2018, 0, 1));
  assert.ok(index.usdEur.rates.every(r => r === 0.9));
  const btc = JSON.parse(await readFile(join(one, 'prix', 'BTC.json'), 'utf8'));
  assert.equal(btc.start, Date.UTC(2018, 0, 1));
  assert.equal(btc.closes.length, index.coins[0].days);
  await run('--out', two, '--previous', join(one, 'prix'));
  assert.equal(await readFile(join(two, 'prix', 'BTC.json'), 'utf8'), await readFile(join(one, 'prix', 'BTC.json'), 'utf8'));
});
