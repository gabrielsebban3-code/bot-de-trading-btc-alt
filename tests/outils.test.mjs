// Onglet Outils : calculateurs de trading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { averageEntry, breakEven, compound, convert, dca, liquidation, num, percentile, pnl, positionSize, riskReward, rng, streaks } from '../js/outils-lib.js';

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

test('positionSize : 1 % de 10 000 $ avec un stop à 2 %', () => {
  const r = positionSize({ capital: 10_000, riskPct: 1, entry: 100, stop: 98 });
  assert.equal(r.side, 'long');
  near(r.risk, 100);
  near(r.qty, 50);
  near(r.notional, 5000);
  near(r.leverage, 0.5);
  near(r.stopPct, 2);
  const s = positionSize({ capital: 10_000, riskPct: 1, entry: 100, stop: 105 });
  assert.equal(s.side, 'short');
  near(s.qty, 20);
});

test('positionSize : les frais réduisent la taille pour que la perte totale reste 1 %', () => {
  const r = positionSize({ capital: 10_000, riskPct: 1, entry: 100, stop: 98, feePct: 0.05 });
  near(r.qty * 2 + r.fees, 100);
  assert.ok(r.qty < 50);
  assert.equal(positionSize({ capital: 10_000, riskPct: 1, entry: 100, stop: 100 }), null);
  assert.equal(positionSize({ capital: 0, riskPct: 1, entry: 100, stop: 90 }), null);
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

test('liquidation : marge isolée, sans frais ni maintenance = entrée × (1 ∓ 1/levier)', () => {
  near(liquidation({ side: 'long', entry: 100, leverage: 10, mmrPct: 0 }).price, 90);
  near(liquidation({ side: 'short', entry: 100, leverage: 10, mmrPct: 0 }).price, 110);
  near(liquidation({ side: 'long', entry: 100, leverage: 1, mmrPct: 0 }).price, 0);
  const l = liquidation({ side: 'long', entry: 100, leverage: 10, mmrPct: 0.4, stop: 95 });
  assert.ok(l.price > 90 && l.price < 91);
  assert.equal(l.stopFirst, true);
  // Au levier maximum, la liquidation tombe pile sur le stop.
  near(liquidation({ side: 'long', entry: 100, leverage: l.maxLeverage, mmrPct: 0.4 }).price, 95);
  const s = liquidation({ side: 'short', entry: 100, leverage: 50, mmrPct: 0.4, stop: 103 });
  assert.equal(s.stopFirst, false);
  near(liquidation({ side: 'short', entry: 100, leverage: s.maxLeverage, mmrPct: 0.4 }).price, 103);
});

test('pnl : brut, frais, funding, % de marge et de capital', () => {
  const r = pnl({ side: 'long', entry: 100, exit: 110, size: 1000, leverage: 5, feePct: 0.05, fundingPct: 0.01, hours: 24, capital: 10_000 });
  near(r.gross, 100);
  near(r.fees, 0.0005 * 210 * 10);
  near(r.funding, 0.0001 * 1000 * 3);
  near(r.net, 100 - 1.05 - 0.3);
  near(r.margin, 200);
  near(r.roe, r.net / 2);
  near(r.capitalPct, r.net / 100);
  const s = pnl({ side: 'short', entry: 100, exit: 110, size: 1000, fundingPct: 0.01, hours: 8 });
  near(s.gross, -100);
  near(s.funding, -0.1); // funding positif : le short le reçoit
});

test('breakEven : la sortie à ce prix donne un PnL nul', () => {
  for (const side of ['long', 'short']) {
    const b = breakEven({ side, entry: 100, feeInPct: 0.05, feeOutPct: 0.05, fundingPct: 0.01, hours: 48 });
    const r = pnl({ side, entry: 100, exit: b.price, size: 1000, feePct: 0, fundingPct: 0.01, hours: 48 });
    // Frais calculés sur la valeur réelle à chaque côté.
    const fees = 0.0005 * 1000 + 0.0005 * 10 * b.price;
    near(r.net - fees, 0, 1e-9);
  }
  assert.ok(breakEven({ side: 'long', entry: 100, feeInPct: 0.1, feeOutPct: 0.1 }).price > 100);
  assert.ok(breakEven({ side: 'short', entry: 100, feeInPct: 0.1, feeOutPct: 0.1 }).price < 100);
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
