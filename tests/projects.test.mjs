import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULTS, findToken, floatRatio, groupFees, holdersRevenueByKey, investorStats, markNew, mergeDaily, percentiles, preselect,
  revenueStats, scoreProjects, tvlStats, exclusionReason,
} from '../scripts/lib/projects.mjs';

const DAY = 86_400;
const daily = (n, f) => Array.from({ length: n }, (_, i) => [1_700_000_000 + i * DAY, f(i)]);

test('groupFees regroupe les protocoles enfants sous leur parent', () => {
  const groups = groupFees([
    { defillamaId: '1', name: 'Aero V1', slug: 'aero-v1', parentProtocol: 'parent#aero', category: 'Dexs', chains: ['Base'], total30d: 100, total60dto30d: 80 },
    { defillamaId: '2', name: 'Aero CL', slug: 'aero-cl', parentProtocol: 'parent#aero', category: 'Dexs', chains: ['Base', 'Optimism'], total30d: 50, total60dto30d: 20 },
    { defillamaId: '3', name: 'Solo', slug: 'solo', category: 'Lending', chains: ['Solana'], total30d: 10 },
  ], [{ id: 'parent#aero', name: 'Aerodrome' }]);
  assert.equal(groups.length, 2);
  const aero = groups.find(g => g.key === 'parent#aero');
  assert.equal(aero.name, 'Aerodrome');
  assert.equal(aero.detailSlug, 'aero');
  assert.equal(aero.revenue30d, 150);
  assert.equal(aero.revenuePrev30d, 100);
  assert.deepEqual(aero.chains.sort(), ['Base', 'Optimism']);
  assert.equal(groups.find(g => g.key === 'id:3').hasPrev, false);
});

test('holdersRevenueByKey additionne par parent', () => {
  const m = holdersRevenueByKey([{ parentProtocol: 'parent#a', total30d: 5 }, { parentProtocol: 'parent#a', total30d: 7 }, { defillamaId: 9, total30d: 1 }]);
  assert.equal(m.get('parent#a'), 12);
  assert.equal(m.get('id:9'), 1);
});

test('findToken trouve le token du parent, sinon celui des enfants', () => {
  const group = { key: 'parent#x', children: [{ id: '1', slug: 'x-v1' }] };
  assert.equal(findToken(group, [], [{ id: 'parent#x', gecko_id: 'x-token', symbol: 'xt' }]).geckoId, 'x-token');
  const viaChild = findToken(group, [{ id: '1', gecko_id: 'from-child', symbol: 'FC', parentProtocol: 'parent#x' }], []);
  assert.equal(viaChild.geckoId, 'from-child');
  assert.equal(viaChild.symbol, 'FC');
  assert.equal(findToken({ key: 'id:5', children: [{ id: '5', slug: 's' }] }, [{ id: '5', gecko_id: null }]), null);
});

test('mergeDaily additionne les séries par jour', () => {
  const merged = mergeDaily([[[DAY, 1], [2 * DAY, 2]], [[DAY + 3600, 10]]]);
  assert.deepEqual(merged, [[DAY, 11], [2 * DAY, 2]]);
});

test('revenueStats calcule la croissance sur 30 jours et détecte l\'accélération', () => {
  const flat = revenueStats(daily(90, () => 100));
  assert.equal(flat.revenue30d, 3000);
  assert.equal(flat.growth, 0);
  assert.equal(flat.accelerating, false);
  assert.equal(flat.series.length, 90);

  const rising = revenueStats(daily(90, i => (i < 60 ? 100 : i < 83 ? 120 : 200)));
  assert.ok(rising.growth > 0.1);
  assert.equal(rising.accelerating, true);

  assert.equal(revenueStats(daily(20, () => 1)), null);
  assert.equal(revenueStats(daily(45, () => 1)).growth, null, 'pas de croissance sans 60 jours de données');
});

test('tvlStats ignore les TVL trop petits', () => {
  const tvl = Array.from({ length: 40 }, (_, i) => ({ date: i * DAY, totalLiquidityUSD: 1e6 + i * 1e4 }));
  const s = tvlStats(tvl);
  assert.equal(s.tvl, 1e6 + 39 * 1e4);
  assert.ok(Math.abs(s.tvlGrowth - (1.39e6 / 1.09e6 - 1)) < 1e-9);
  assert.equal(tvlStats([{ date: 0, totalLiquidityUSD: 10 }, { date: 40 * DAY, totalLiquidityUSD: 50 }]).tvlGrowth, null);
  assert.deepEqual(tvlStats(undefined), { tvl: null, tvlGrowth: null });
});

test('investorStats met les leads en premier et convertit les millions', () => {
  const s = investorStats([{ amount: 5, leadInvestors: ['A'], otherInvestors: ['B', 'A'] }, { amount: 2.5, leadInvestors: ['C'] }]);
  assert.deepEqual(s.investors, ['A', 'B', 'C']);
  assert.equal(s.raisedUsd, 7.5e6);
  assert.equal(investorStats([]).raisedUsd, null);
});

test('floatRatio utilise l\'offre max, sinon totale', () => {
  assert.equal(floatRatio({ circulating_supply: 25, max_supply: 100, total_supply: 50 }), 0.25);
  assert.equal(floatRatio({ circulating_supply: 25, total_supply: 50 }), 0.5);
  assert.equal(floatRatio({ circulating_supply: 25 }), null);
});

test('percentiles gère les égalités et les valeurs nulles', () => {
  assert.deepEqual(percentiles([10, null, 30, 20]), [0, null, 1, 0.5]);
  assert.deepEqual(percentiles([5, 5, 9]), [0.25, 0.25, 1]);
  assert.deepEqual(percentiles([7]), [1]);
});

test('scoreProjects : revenus 35 %, croissance 25 %, valorisation 15 %, rachats 10 %, tendance 15 %', () => {
  const base = { revenueGrowth: 0, tvlGrowth: null, psRatio: 10, holdersShare: 0, change200d: 0, badges: {} };
  const [best, worst] = scoreProjects([
    { ...base, id: 'low', revenue30d: 1, revenueGrowth: -0.5, psRatio: 50, change200d: -60 },
    { ...base, id: 'high', revenue30d: 100, revenueGrowth: 0.5, psRatio: 5, holdersShare: 0.6, change200d: 40 },
  ]);
  assert.equal(best.id, 'high');
  assert.equal(best.score, 100);
  assert.equal(worst.score, 0);
  const [onlyRevenue] = scoreProjects([{ id: 'a', revenue30d: 1, revenueGrowth: null, tvlGrowth: null, psRatio: null, change200d: null, badges: {} }]);
  assert.equal(onlyRevenue.score, Math.round(100 * (0.35 + 0.25 * 0.3 + 0.15 * 0.3 + 0.15 * 0.3)));
  const [same, diluted] = scoreProjects([{ ...base, id: 'x', revenue30d: 1 }, { ...base, id: 'y', revenue30d: 1, badges: { lowFloat: true } }]);
  assert.equal(diluted.score, Math.round(same.score * 0.85), 'faible flottant : −15 %');
});

test('exclusionReason écarte les tokens peu échangés et ceux effondrés qui baissent encore', () => {
  const ok = { volume24h: 5e6, athChange: -0.5, change200d: -20, change30d: 5 };
  assert.equal(exclusionReason(ok), null);
  assert.equal(exclusionReason({ ...ok, volume24h: 50_000 }), 'volume');
  assert.equal(exclusionReason({ ...ok, volume24h: null }), null, 'volume inconnu : gardé');
  assert.equal(exclusionReason({ ...ok, athChange: -0.97 }), 'decline');
  assert.equal(exclusionReason({ ...ok, athChange: -0.95, change200d: 40 }), null, 'reprend depuis 200 jours');
  assert.equal(exclusionReason({ ...ok, athChange: -0.95, change200d: null, change30d: -10 }), 'decline', 'token jeune : tendance 30 jours');
  assert.equal(exclusionReason({ ...ok, athChange: -0.95, change200d: null, change30d: null }), null, 'tendance inconnue : gardé');
  assert.equal(exclusionReason({ ...ok, athChange: -0.7 }), null, 'chute moins forte');
  const now = new Date('2026-10-06T00:00:00Z');
  const old = { ...ok, athDate: '2021-10-08', athChange: -0.98, change200d: 25 };
  assert.equal(exclusionReason({ ...old, change1y: -81 }, now), 'decline', 'vieux token : un rebond sur 200 jours ne suffit pas');
  assert.equal(exclusionReason({ ...old, change1y: 30 }, now), null, 'vieux token en hausse sur 1 an : gardé');
  assert.equal(exclusionReason({ ...old, athDate: '2024-12-13', change1y: -10 }, now), null, 'plus haut récent : le rebond suffit');
});

test('revenueStats : la croissance ignore les 3 plus gros jours de chaque mois', () => {
  const spike = revenueStats(daily(60, i => (i === 50 ? 100_000 : 100)));
  assert.equal(spike.growth, 0, 'un seul jour exceptionnel ne compte pas');
  assert.ok(spike.revenue30d > 100_000, 'le revenu affiché reste le vrai total');
});

test('markNew date l\'entrée dans le top et ne marque rien au premier passage', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const opts = { topSize: 2, newDays: 3 };
  const first = markNew(projects, null, now, opts);
  assert.ok(first.every(p => !p.isNew && p.firstSeenTop === null));
  assert.deepEqual(first.map(p => p.inTop), [true, true, false]);

  const prev = { projects: [{ id: 'a', inTop: true, firstSeenTop: null }, { id: 'c', inTop: true, firstSeenTop: null }] };
  const second = markNew(projects, prev, now, opts);
  assert.equal(second[0].isNew, false, 'déjà dans le top avant');
  assert.equal(second[1].isNew, true, 'nouvel entrant');
  assert.equal(second[1].firstSeenTop, now.toISOString());

  const later = markNew(projects, { projects: second }, new Date('2026-10-05T12:00:00Z'), opts);
  assert.equal(later[1].isNew, false, 'plus nouveau après 3 jours');
});

test('preselect exclut les projets sans token, trop gros, trop petits ou déjà sur Binance', () => {
  const g = (key, revenue30d) => ({ key, revenue30d });
  const tokens = new Map([['ok', { geckoId: 'ok' }], ['big', { geckoId: 'big' }], ['bn', { geckoId: 'bn' }], ['small', { geckoId: 'small' }]]);
  const markets = new Map([
    ['ok', { market_cap: 1e8, symbol: 'ok' }], ['big', { market_cap: 2e9, symbol: 'big' }],
    ['bn', { market_cap: 1e8, symbol: 'bn' }], ['small', { market_cap: 1e6, symbol: 'sm' }],
  ]);
  const { kept, counts } = preselect([g('ok', 1e6), g('big', 1e6), g('bn', 1e6), g('small', 10), g('none', 1e6)], { tokens, markets, binance: new Set(['BN']) });
  assert.deepEqual(kept.map(k => k.group.key), ['ok']);
  assert.deepEqual(counts, { total: 5, noToken: 1, smallRevenue: 1, noMcap: 0, tooBig: 1, onBinance: 1, kept: 1 });
});

test('preselect garde les plus gros revenus puis ceux qui grimpent le plus vite', () => {
  const g = (key, revenue30d, revenuePrev30d) => ({ key, revenue30d, revenuePrev30d, hasPrev: true });
  const groups = [g('a', 9e6, 9e6), g('b', 8e6, 8e6), g('c', 1e5, 2e4), g('d', 2e5, 1e5), g('e', 3e5, 4e5)];
  const tokens = new Map(groups.map(x => [x.key, { geckoId: x.key }]));
  const markets = new Map(groups.map(x => [x.key, { market_cap: 1e8, symbol: x.key }]));
  const { kept } = preselect(groups, { tokens, markets, binance: null, opts: { ...DEFAULTS, shortlist: 2, growers: 1 } });
  assert.deepEqual(kept.map(k => k.group.key), ['a', 'b', 'c']);
});

test('build-data.mjs produit des fichiers complets à partir des API simulées', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dinexo-'));
  const run = promisify(execFile);
  await run(process.execPath, ['--import', './tests/mock-fetch.mjs', 'scripts/build-data.mjs', '--out', dir, '--sample']);
  const data = JSON.parse(await readFile(join(dir, 'projects.json'), 'utf8'));
  const names = data.projects.map(p => p.name);
  assert.ok(data.sample);
  assert.equal(data.sources.binance, 'ok');
  assert.ok(names.includes('Nebula DEX'), 'parent regroupé');
  for (const excluded of ['Big Chain', 'Listed DEX', 'No Token App', 'Tiny Farm']) assert.ok(!names.includes(excluded), excluded);
  const tidal = data.projects.find(p => p.name === 'Tidal Perps');
  assert.equal(tidal.change7d, -4.2, 'variation du prix sur 7 jours');
  assert.equal(tidal.badges.okx, true);
  assert.equal(tidal.badges.trending, true);
  assert.equal(tidal.badges.buyback, true);
  assert.equal(data.projects.find(p => p.name === 'Ember Swap').badges.binanceAlpha, true);
  assert.equal(data.projects.find(p => p.name === 'Orbit Lend').badges.lowFloat, true);
  assert.ok(data.projects.every((p, i, a) => i === 0 || a[i - 1].score >= p.score), 'trié par score');

  // Deuxième passage avec l'ancien fichier : rien de nouveau puisque le top n'a pas changé.
  const prevPath = join(dir, 'prev.json');
  await writeFile(prevPath, JSON.stringify(data));
  await run(process.execPath, ['--import', './tests/mock-fetch.mjs', 'scripts/build-data.mjs', '--out', dir, '--previous', prevPath]);
  const again = JSON.parse(await readFile(join(dir, 'projects.json'), 'utf8'));
  assert.ok(again.projects.every(p => !p.isNew));
  const market = JSON.parse(await readFile(join(dir, 'market.json'), 'utf8'));
  assert.deepEqual(market.fearGreed, { value: 68, label: 'Avidité' });
});
