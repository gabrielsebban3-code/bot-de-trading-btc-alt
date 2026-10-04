// Onglet Outils : calculateurs de trading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { averageEntry, compound, convert, dca, dcaProjection, num, percentile, riskReward, rng, streaks } from '../js/outils-lib.js';
import { flowNum, flowSummary, farsideDay, mergeFlows, parseFarside } from '../js/outils-data.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≠ ${b}`);

test('num : virgule, espaces, symboles', () => {
  assert.equal(num('1 250,5'), 1250.5);
  assert.equal(num('0,05 %'), 0.05);
  assert.equal(num('60000$'), 60000);
  assert.equal(num('-2'), -2);
  assert.equal(num(''), null);
  assert.equal(num('abc'), null);
  assert.equal(num('1.2.3'), null);
});

test('riskReward : 3R, seuil de réussite 25 %, objectifs en R', () => {
  const r = riskReward({ entry: 100, stop: 95, target: 115, winRatePct: 32 });
  assert.equal(r.side, 'long');
  near(r.rr, 3);
  near(r.breakEvenWinRate, 25);
  near(r.expectancy, 0.32 * 3 - 0.68);
  assert.deepEqual(r.levels.map(l => l.price), [105, 110, 115, 125, 150]);
  const s = riskReward({ entry: 100, stop: 110, target: 80 });
  assert.equal(s.side, 'short');
  near(s.rr, 2);
  assert.deepEqual(s.levels.map(l => l.price), [90, 80, 70, 50]); // 10R = 0 $ : retiré
  assert.ok(riskReward({ entry: 100, stop: 95, target: 101, feePct: 0.5 }).rr < 0.2);
});

test('dca : achats réguliers, prix moyen, comparaison avec un achat unique', () => {
  const pts = [[0, 100], [1, 50], [2, 50], [3, 100], [4, 200]];
  const r = dca(pts, { amount: 100, every: 2, startDay: 0 });
  assert.equal(r.buys, 3); // jours 0, 2, 4
  near(r.invested, 300);
  near(r.units, 1 + 2 + 0.5);
  near(r.value, 3.5 * 200);
  near(r.avgPrice, 300 / 3.5);
  near(r.lump.value, 3 * 200);
  near(r.worst.pct, -50); // jour 1 : 1 unité qui vaut 50 pour 100 investis
  assert.equal(r.worst.day, 1);
  assert.equal(r.series.length, 5);
  assert.deepEqual(r.series[4], [4, 300, 700, 600]);
  // Prix moyen payé jour après jour : 100 au premier achat, 200 / 3 au jour 2 (1 + 2 unités), 300 / 3,5 à la fin.
  near(r.cost[0][1], 100);
  near(r.cost[1][1], 100);
  near(r.cost[2][1], 200 / 3);
  near(r.cost[4][1], 300 / 3.5);
  assert.equal(dca(pts, { amount: 100, every: 7, startDay: 10 }), null);
});

test('compound : 10 % par mois et objectif atteint', () => {
  const r = compound({ capital: 1000, ratePct: 10, months: 2, monthly: 0, target: 1300 });
  near(r.final, 1210);
  near(r.gains, 210);
  assert.equal(r.reach, 3); // 1331 au 3e mois, après la durée choisie
  const v = compound({ capital: 0, ratePct: 0, months: 12, monthly: 100 });
  near(v.final, 1200);
  near(v.gains, 0);
  assert.equal(compound({ capital: 0, ratePct: 5, months: 12, monthly: 0 }), null);
});

test('streaks : reproductible, cohérent avec la théorie', () => {
  const a = streaks({ winRatePct: 32, winR: 5.8, riskPct: 1, trades: 30, runs: 500 });
  const b = streaks({ winRatePct: 32, winR: 5.8, riskPct: 1, trades: 30, runs: 500 });
  assert.deepEqual(a.losingStreak, b.losingStreak);
  near(a.expectancyR, 0.32 * 5.8 - 0.68);
  assert.ok(a.losingStreak.median >= 4 && a.losingStreak.median <= 9);
  assert.ok(a.losingStreak.p95 >= a.losingStreak.median);
  assert.ok(a.drawdown.p95 >= a.drawdown.median);
  assert.ok(a.final.p95 >= a.final.median && a.final.median >= a.final.p5);
  assert.equal(a.curves.median.length, 31);
  // 0 % de gagnants : 30 pertes d'affilée, creux = 1 − 0,99^30.
  const z = streaks({ winRatePct: 0, winR: 2, riskPct: 1, trades: 30, runs: 10 });
  assert.equal(z.losingStreak.max, 30);
  near(z.drawdown.median, (1 - 0.99 ** 30) * 100);
  assert.equal(z.lossOdds, 100);
});

test('rng et percentile', () => {
  const r = rng(7);
  const x = Array.from({ length: 1000 }, r);
  assert.ok(x.every(v => v >= 0 && v < 1));
  assert.ok(Math.abs(x.reduce((s, v) => s + v, 0) / 1000 - 0.5) < 0.05);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([], 50), null);
});

test('averageEntry : prix moyen pondéré et achat pour le ramener à un objectif', () => {
  const r = averageEntry([{ price: 100, amount: 1000 }, { price: 50, amount: 1000 }, { price: 0, amount: 5 }], { current: 60, target: 60 });
  assert.equal(r.count, 2);
  near(r.units, 30);
  near(r.avg, 2000 / 30);
  near(r.value, 1800);
  near(r.pnl, -200);
  near(r.toBreakEvenPct, (2000 / 30 / 60 - 1) * 100);
  assert.equal(r.toTarget, null); // l'objectif doit être entre le prix actuel et le prix moyen
  const t = averageEntry([{ price: 100, amount: 1000 }], { current: 50, target: 75 });
  near(t.toTarget, 500); // 500 $ à 50 $ : 20 unités pour 1 500 $ → 75 $
  near((1000 + t.toTarget) / (10 + t.toTarget / 50), 75);
  assert.equal(averageEntry([]), null);
});

test('convert : passe par le dollar', () => {
  const rates = { USD: 1, EUR: 1.25, BTC: 50_000 };
  near(convert(1, 'BTC', 'EUR', rates), 40_000);
  near(convert(100, 'EUR', 'USD', rates), 125);
  assert.equal(convert(1, 'BTC', 'XRP', rates), null);
});

test('dcaProjection : prix qui monte de 1 % tous les 30 jours, sans hasard possible', () => {
  const pts = Array.from({ length: 400 }, (_, i) => [i, 100 * 1.01 ** (i / 30)]);
  const r = dcaProjection(pts, { amount: 100, every: 30, years: 1, runs: 50 });
  assert.equal(r.buys, 13);
  near(r.invested, 1300);
  near(r.final.p10, r.final.p90, 1e-6); // toutes les tranches se ressemblent
  assert.ok(r.final.p50 > r.invested);
  assert.equal(r.lossOdds, 0);
  near(r.histCagr, (1.01 ** (365 / 30) - 1) * 100, 1e-3);
  assert.equal(r.checkpoints.length, 13);
  // Le dernier point du graphique est le résultat final.
  assert.deepEqual(r.checkpoints.at(-1).slice(1), [r.invested, r.final.p10, r.final.p50, r.final.p90]);
  // Prix de l'actif : part du dernier prix et prend 1 % tous les 30 jours, dans tous les scénarios.
  assert.equal(r.lastPrice, pts.at(-1)[1]);
  assert.equal(r.prices.length, 13);
  assert.deepEqual(r.prices[0], [0, r.lastPrice, r.lastPrice, r.lastPrice]);
  assert.equal(r.prices.at(-1)[0], 365);
  near(r.price.p50, r.lastPrice * 1.01 ** (365 / 30), 1e-6);
  near(r.price.p10, r.price.p90, 1e-6);
  const weekly = dcaProjection(pts, { amount: 100, every: 7, years: 5, runs: 20 });
  assert.equal(weekly.checkpoints.length, 61);
  assert.deepEqual(weekly.checkpoints.at(-1).slice(1, 2), [weekly.invested]);
  assert.equal(weekly.checkpoints[0][1], 100);
  assert.equal(dcaProjection(pts.slice(0, 50), { amount: 100, every: 7, years: 1 }), null);
  // Sans tendance : le prix ne bouge plus, la valeur finale est la somme investie.
  const flat = dcaProjection(pts, { amount: 100, every: 30, years: 1, runs: 20, drift: 0 });
  near(flat.final.p50, 1300);
  near(flat.price.p50, flat.lastPrice);
  near(flat.usedCagr, 0);
  near(r.usedCagr, r.histCagr, 1e-3);
});

test('flowNum et farsideDay', () => {
  assert.equal(flowNum('(12.5)'), -12.5);
  assert.equal(flowNum('1,234.5'), 1234.5);
  assert.equal(flowNum('-'), 0);
  assert.equal(flowNum('abc'), null);
  assert.equal(farsideDay('11 Jan 2024') * 86_400_000, Date.UTC(2024, 0, 11));
  assert.equal(farsideDay('02 Sept 2025') * 86_400_000, Date.UTC(2025, 8, 2));
  assert.equal(farsideDay('Total'), null);
  assert.equal(farsideDay('11 Foo 2024'), null);
});

test('parseFarside : codes boursiers, jours, négatifs entre parenthèses, lignes de total ignorées', () => {
  const html = `<table><tr><th></th><th>Blackrock</th><th>Fidelity</th><th></th></tr>
    <tr><th></th><th>IBIT</th><th>FBTC</th><th>Total</th></tr>
    <tr><td>Fee</td><td>0.25%</td><td>0.25%</td><td></td></tr>
    <tr><td><span>11 Jan 2024</span></td><td>111.7</td><td>227.0</td><td>338.7</td></tr>
    <tr><td>12 Jan 2024</td><td>(10.0)</td><td>-</td><td>(10.0)</td></tr>
    <tr><td>15 Jan 2024</td><td></td><td></td><td></td></tr>
    <tr><td>Total</td><td>101.7</td><td>227.0</td><td>328.7</td></tr></table>`;
  const r = parseFarside(html);
  assert.deepEqual(r.issuers, ['IBIT', 'FBTC']);
  assert.equal(r.days.length, 2);
  assert.deepEqual(r.days[1].slice(1), [-10, [-10, 0]]);
  assert.deepEqual(parseFarside('<p>rien</p>'), { issuers: [], days: [] });
});

test('flowSummary et mergeFlows', () => {
  const a = { issuers: ['A', 'B'], days: [[1, 10, [10, 0]], [2, -5, [-5, 0]], [3, -2, [0, -2]]] };
  const s = flowSummary(a);
  assert.equal(s.last.total, -2);
  assert.equal(s.d5, 3);
  assert.equal(s.streak, -2);
  assert.deepEqual(s.cumulative.map(c => c[1]), [10, 5, 3]);
  assert.equal(s.byIssuer[0].name, 'A');
  const m = mergeFlows(a, { issuers: ['A', 'B'], days: [[3, 4, [4, 0]], [4, 1, [1, 0]]] });
  assert.deepEqual(m.days.map(d => d[1]), [10, -5, 4, 1]);
  assert.equal(mergeFlows(a, { issuers: ['A'], days: [[9, 1, [1]]] }).days.length, 1);
});
