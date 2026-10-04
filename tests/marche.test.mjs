// Onglet Marché : séries quotidiennes, moyennes mobiles et lecture de la direction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agendaEvents, agendaFr, altSeason, changeOver, DAY, mergePoints, realCoins, signals, sma, sortTop, tallyText, toDaily, verdict } from '../js/marche-lib.js';

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

test('script Marché : open interest du jour en direct, dérivés, saison des altcoins, secteurs et agenda', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dinexo-marche-'));
  const today = Math.floor(Date.now() / DAY);
  // Version déjà en ligne : historique des secteurs et de la saison des altcoins, gardé d'un passage à l'autre.
  await writeFile(join(dir, 'previous.json'), JSON.stringify({
    sectors: { list: [{ id: 'meme-token', history: [[today - 8, 5e10], [today - 1, 5.5e10]] }] },
    altseason: { history: [[today - 1, 40]] },
  }));
  await promisify(execFile)(process.execPath, ['--import', './tests/mock-fetch.mjs', 'scripts/build-marche.mjs', '--out', dir, '--previous', join(dir, 'previous.json')]);
  const m = JSON.parse(await readFile(join(dir, 'marche.json'), 'utf8'));
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
  // Tableau : 20 cryptos hors stablecoins. Saison des altcoins sur les 50 plus grosses hors BTC, un point par jour.
  assert.equal(m.top.length, 20);
  assert.equal(m.altseason.total, 50);
  assert.equal(m.altseason.value, Math.round((100 * m.altseason.beat) / 50));
  assert.deepEqual(m.altseason.history, [[today - 1, 40], [today, m.altseason.value]]);
  // Secteurs suivis trouvés chez CoinGecko (un secteur sans capitalisation est ignoré), symboles des plus grosses cryptos
  // connues, variation sur 7 jours grâce à l'historique déjà publié.
  assert.deepEqual(m.sectors.list.map(x => x.id), ['layer-1', 'decentralized-finance-defi', 'meme-token', 'artificial-intelligence']);
  const [l1, , meme, ai] = m.sectors.list;
  assert.deepEqual(l1.top, ['BTC', 'ETH', 'XRP']);
  assert.equal(l1.change7d, null);
  assert.deepEqual(l1.history, [[today, 2e12]]);
  assert.deepEqual(meme.top, ['DOGE']);
  assert.ok(Math.abs(meme.change24h - 0.042) < 1e-12);
  assert.ok(Math.abs(meme.change7d - 0.2) < 1e-12);
  assert.equal(meme.history.length, 3);
  assert.equal(ai.change24h, null);
  // Agenda : annonces fortes américaines et décision de la BCE, en français ; la semaine prochaine n'est pas publiée.
  assert.deepEqual(m.agenda.events.map(e => e.title), ['Communiqué de la Fed', 'Inflation (CPI) sur un mois', 'Décision de taux de la BCE']);
  assert.equal(m.agenda.events[1].t.slice(11), '12:30:00.000Z');
  assert.equal(m.agenda.nextWeek, false);
  assert.equal(m.sources.agenda, 'ok');
  assert.equal(m.sources.secteurs, 'ok');
});

test('altSeason : part des 50 plus grosses qui battent BTC sur 30 jours, sans BTC ni stablecoins', () => {
  const coin = (symbol, change30d, name = symbol) => ({ id: symbol.toLowerCase(), symbol, name, change30d });
  const alts = Array.from({ length: 12 }, (_, i) => coin(`A${i}`, i < 9 ? 0.2 : -0.1));
  const list = [coin('BTC', 0.1, 'Bitcoin'), coin('USDT', 0, 'Tether'), coin('WBTC', 0.1, 'Wrapped Bitcoin'), ...alts];
  const s = altSeason(list);
  assert.deepEqual([s.beat, s.total, s.value, s.dir, s.label], [9, 12, 75, 1, 'Saison des altcoins']);
  assert.ok(Math.abs(s.best[0].vsBtc - (1.2 / 1.1 - 1)) < 1e-12);
  assert.deepEqual(s.worst.map(c => c.symbol), ['A11', 'A10', 'A9', 'A8', 'A7']);
  // Seulement les n premières : 9 sur 10 font mieux que BTC.
  assert.equal(altSeason(list, 10).value, 90);
  const btcSeason = altSeason([coin('BTC', 0.1), ...Array.from({ length: 12 }, (_, i) => coin(`B${i}`, i < 3 ? 0.3 : 0))]);
  assert.deepEqual([btcSeason.value, btcSeason.dir, btcSeason.label], [25, -1, 'Saison du Bitcoin']);
  assert.equal(altSeason(alts), null); // sans BTC
  assert.equal(altSeason([coin('BTC', 0.1), ...alts.slice(0, 9)]), null); // trop peu d'altcoins
});

test('changeOver : variation sur n jours, null tant que l\'historique est trop court', () => {
  assert.ok(Math.abs(changeOver([[1, 100], [3, 100], [10, 120]], 7) - 0.2) < 1e-12);
  assert.equal(changeOver([[5, 100], [10, 120]], 7), null);
  assert.equal(changeOver([], 7), null);
  assert.equal(changeOver(undefined, 7), null);
});

test('agendaEvents : annonces américaines fortes et décisions de taux, en français, triées', () => {
  const rows = [
    { title: 'CPI m/m', country: 'USD', date: '2026-10-14T08:30:00-04:00', impact: 'High', forecast: '0.3%', previous: '0.4%' },
    { title: 'Non-Farm Employment Change', country: 'USD', date: '2026-10-09T08:30:00-04:00', impact: 'High', forecast: '180K', previous: '-4K' },
    { title: 'Unemployment Claims', country: 'USD', date: '2026-10-09T08:30:00-04:00', impact: 'Medium' },
    { title: 'German ZEW Economic Sentiment', country: 'EUR', date: '2026-10-14T05:00:00-04:00', impact: 'High' },
    { title: 'BOJ Policy Rate', country: 'JPY', date: '2026-10-30T00:00:00-04:00', impact: 'High', forecast: '0.75%', previous: '0.50%' },
    { title: 'Fed Chair Waller Speaks', country: 'USD', date: '2026-10-15T10:00:00-04:00', impact: 'High' },
    { title: 'Mystery Index', country: 'USD', date: 'pas une date', impact: 'High' },
  ];
  const ev = agendaEvents(rows);
  assert.deepEqual(ev.map(e => e.title), ["Créations d'emplois (NFP)", 'Inflation (CPI) sur un mois', 'Discours du président de la Fed (Waller)', 'Décision de taux de la Banque du Japon']);
  assert.equal(ev[0].t, '2026-10-09T12:30:00.000Z');
  assert.deepEqual([ev[0].forecast, ev[0].previous], ['180 k', '-4 k']);
  assert.deepEqual([ev[1].forecast, ev[1].previous, ev[1].en], ['0,3 %', '0,4 %', 'CPI m/m']);
  assert.equal(ev[2].forecast, null);
  assert.equal(agendaFr('Retail Sales m/m'), 'Ventes au détail sur un mois');
  assert.equal(agendaFr('Unknown Thing'), 'Unknown Thing');
  assert.deepEqual(agendaEvents(null), []);
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
