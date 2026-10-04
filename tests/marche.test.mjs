// Onglet Marché : séries quotidiennes, moyennes mobiles et lecture de la direction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAY, mergePoints, realCoins, signals, sma, sortTop, tallyText, toDaily, verdict } from '../js/marche-lib.js';

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
  assert.equal(tallyText(v), '4 signaux haussiers, 2 baissiers sur 6');
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
  assert.equal(tallyText(verdict([{ dir: 1 }, { dir: 0 }])), '1 signal haussier, 0 baissier sur 2');
  // marche.json déjà publié : le verdict n'a que up, down et total.
  assert.equal(tallyText({ up: 3, down: 1, total: 6, label: 'Plutôt haussier' }), '3 signaux haussiers, 1 baissier sur 6');
});

test('realCoins : retire stablecoins et versions wrapped ou staked', () => {
  const list = [['BTC', 'Bitcoin'], ['USDT', 'Tether'], ['STETH', 'Lido Staked Ether'], ['WBTC', 'Wrapped Bitcoin'], ['USDE', 'Ethena USDe'], ['SOL', 'Solana']]
    .map(([symbol, name]) => ({ symbol, name }));
  assert.deepEqual(realCoins(list).map(c => c.symbol), ['BTC', 'SOL']);
});

test('script Marché : open interest du jour en direct, dérivés de toutes les plateformes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dinexo-marche-'));
  await promisify(execFile)(process.execPath, ['--import', './tests/mock-fetch.mjs', 'scripts/build-marche.mjs', '--out', dir]);
  const m = JSON.parse(await readFile(join(dir, 'marche.json'), 'utf8'));
  const today = Math.floor(Date.now() / DAY);
  // Les valeurs quotidiennes d'OKX s'arrêtent avant aujourd'hui : le jour en cours prend la valeur en direct.
  assert.ok(m.series.oi.points.at(-2)[0] < today);
  assert.deepEqual(m.series.oi.points.at(-1), [today, 13.5e9]);
  // Volume et open interest des dérivés (en BTC chez CoinGecko) convertis en dollars au dernier prix BTC.
  const btc = m.series.btc.points.at(-1)[1];
  assert.ok(Math.abs(m.tiles.derivs.volume24h / (1_300_000.5 * btc) - 1) < 1e-4);
  assert.ok(Math.abs(m.tiles.derivs.openInterest / (420_000 * btc) - 1) < 1e-4);
  assert.equal(m.tiles.derivs.exchanges, 2);
  assert.equal(m.sources['dérivés'], 'ok');
  assert.equal(m.tiles.perps, undefined);
});

test('sortTop : classement, tendance la plus nette d\'abord, plus fortes hausses, sens inversé', () => {
  const list = [
    { id: 'a', change24h: 0.01, change7d: -0.02, change30d: null, volume: 5 },
    { id: 'b', change24h: -0.03, change7d: 0.05, change30d: 0.2, volume: 9 },
    { id: 'c', change24h: 0.04, change7d: 0.01, change30d: -0.1, volume: 1 },
    { id: 'd', change24h: null, change7d: 0, change30d: 0.05, volume: 9 },
  ];
  const trends = new Map([['a', { up: 1, down: 3 }], ['b', { up: 5, down: 0 }], ['c', { up: 4, down: 1 }]]);
  const ids = (key, rev) => sortTop(list, key, trends, rev).map(c => c.id);
  assert.deepEqual(ids('rank'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids('rank', true), ['d', 'c', 'b', 'a']);
  assert.deepEqual(ids('trend'), ['b', 'c', 'a', 'd']); // haussières d'abord, sans tendance connue à la fin
  assert.deepEqual(ids('trend', true), ['a', 'c', 'b', 'd']); // baissières d'abord, l'inconnue reste à la fin
  assert.deepEqual(ids('change24h'), ['c', 'a', 'b', 'd']);
  assert.deepEqual(ids('change24h', true), ['b', 'a', 'c', 'd']);
  assert.deepEqual(ids('change30d'), ['b', 'd', 'c', 'a']);
  assert.deepEqual(ids('volume'), ['b', 'd', 'a', 'c']); // égalité : l'ordre du classement départage
  assert.deepEqual(list.map(c => c.id), ['a', 'b', 'c', 'd']); // la liste d'origine ne bouge pas
});
