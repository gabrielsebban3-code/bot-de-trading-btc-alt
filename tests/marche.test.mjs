// Onglet Marché : séries quotidiennes, moyennes mobiles et lecture de la direction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, mergePoints, realCoins, signals, sma, toDaily, verdict } from '../js/marche-lib.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const D0 = T0 / DAY;
const line = (n, f) => Array.from({ length: n }, (_, i) => [D0 + i, f(i)]);

test('toDaily : dernière valeur du jour, ou moyenne', () => {
  const rows = [[T0 + 1000, 1], [T0 + 9000, 3], [T0 + DAY, 5]];
  assert.deepEqual(toDaily(rows), [[D0, 3], [D0 + 1, 5]]);
  assert.deepEqual(toDaily(rows, { mean: true }), [[D0, 2], [D0 + 1, 5]]);
  assert.deepEqual(toDaily([[T0, NaN]]), []);
});

test('mergePoints : garde l\'ancien historique, les nouveaux points gagnent, borne la longueur', () => {
  const merged = mergePoints([[1, 10], [2, 20]], [[2, 21], [3, 30]], 2);
  assert.deepEqual(merged, [[2, 21], [3, 30]]);
  assert.deepEqual(mergePoints(undefined, [[1, 1]]), [[1, 1]]);
});

test('sma : null tant que l\'historique est trop court', () => {
  const m = sma(line(4, i => i + 1), 2);
  assert.deepEqual(m.map(p => p[1]), [null, 1.5, 2.5, 3.5]);
});

test('signals : marché haussier, euphorie et levier chaud', () => {
  const series = {
    btc: { points: line(260, i => 100 + i) },
    fng: { points: line(10, () => 80) },
    stables: { points: line(40, i => 100e9 * (1 + i * 0.001)) },
    funding: { points: line(5, () => 0.05) },
    oi: { points: line(10, i => 1e9 * (1 + i * 0.02)) },
  };
  const s = Object.fromEntries(signals(series).map(x => [x.key, x.dir]));
  assert.deepEqual(s, { trend: 1, short: 1, fng: -1, stables: 1, funding: -1, oi: 1 });
  const v = verdict(signals(series));
  assert.equal(v.up, 4);
  assert.equal(v.down, 2);
  assert.equal(v.label, 'Plutôt haussier');
});

test('signals : marché baissier, peur extrême et shorts qui paient', () => {
  const series = {
    btc: { points: line(260, i => 400 - i) },
    fng: { points: line(10, () => 15) },
    stables: { points: line(40, i => 100e9 * (1 - i * 0.001)) },
    funding: { points: line(5, () => -0.01) },
    oi: { points: line(10, i => 1e9 * (1 + i * 0.02)) },
  };
  const s = Object.fromEntries(signals(series).map(x => [x.key, x.dir]));
  assert.deepEqual(s, { trend: -1, short: -1, fng: 1, stables: -1, funding: 1, oi: -1 });
  assert.equal(verdict(signals(series)).label, 'Plutôt baissier');
  assert.match(signals(series)[0].text, /sous sa moyenne 200 jours/);
  assert.doesNotMatch(signals(series)[0].text, /-/);
});

test('signals : sans historique, aucun signal et pas de verdict', () => {
  assert.deepEqual(signals({}), []);
  assert.equal(verdict([]).label, 'Pas de direction claire');
});

test('realCoins : retire stablecoins et versions wrapped ou staked', () => {
  const list = [['BTC', 'Bitcoin'], ['USDT', 'Tether'], ['STETH', 'Lido Staked Ether'], ['WBTC', 'Wrapped Bitcoin'], ['USDE', 'Ethena USDe'], ['SOL', 'Solana']]
    .map(([symbol, name]) => ({ symbol, name }));
  assert.deepEqual(realCoins(list).map(c => c.symbol), ['BTC', 'SOL']);
});
