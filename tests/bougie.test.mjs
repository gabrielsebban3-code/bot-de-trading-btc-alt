// Outil « Bougie du mois / de la semaine » (js/bougie-lib.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candleStats, periodKey, periodLength, splitPeriods } from '../js/bougie-lib.js';

const DAY = 86_400_000;
const d = (y, m, j) => Date.UTC(y, m - 1, j) / DAY;
const rand = seed => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

// Bougies quotidiennes au hasard, du 1er janvier 2014 au `end` compris.
function candles(end, seed = 7) {
  const r = rand(seed);
  const out = [];
  let p = 500;
  for (let t = d(2014, 1, 1); t <= end; t++) {
    const o = p;
    p *= Math.exp((r() - 0.5) * 0.06);
    out.push([t, o, Math.max(o, p) * (1 + r() * 0.01), Math.min(o, p) * (1 - r() * 0.01), p]);
  }
  return out;
}

test('périodes : mois calendaires et semaines du lundi', () => {
  assert.equal(periodKey(d(2026, 11, 19), 'm'), '2026-11');
  assert.equal(periodKey(d(2026, 11, 19), 'w'), d(2026, 11, 16)); // jeudi → lundi 16
  assert.equal(periodKey(d(2026, 11, 16), 'w'), d(2026, 11, 16));
  assert.equal(periodLength(d(2024, 2, 1), 'm'), 29);
  assert.equal(periodLength(d(2026, 11, 1), 'm'), 30);
  // Historique qui commence un 15 : ce premier mois incomplet est retiré.
  const p = splitPeriods(candles(d(2014, 3, 10)).slice(14), 'm');
  assert.deepEqual(p.map(x => x.key), ['2014-02', '2014-03']);
  assert.equal(p[1].rows.length, 10);
});

test('bougie du mois : état du mois en cours et chiffres cohérents', () => {
  const c = candles(d(2026, 11, 19));
  const r = candleStats(c, 'm');
  assert.equal(r.k, 19);
  assert.equal(r.len, 30);
  assert.equal(r.left, 11);
  const nov = c.filter(x => x[0] >= d(2026, 11, 1));
  assert.equal(r.open, nov[0][1]);
  assert.equal(r.high, Math.max(...nov.map(x => x[2])));
  assert.equal(r.low, Math.min(...nov.map(x => x[3])));
  assert.equal(r.close, nov.at(-1)[4]);
  assert.equal(r.similar.n, 20);
  assert.equal(r.periods, 154); // janvier 2014 à octobre 2026
  for (const k of ['high', 'low', 'green', 'restUp']) assert.ok(r.similar[k] >= 0 && r.similar[k] <= 100);
  assert.equal(r.band.length, 11);
  assert.ok(r.band.every(b => b[1] <= b[2] && b[2] <= b[3]));
  assert.ok(r.similar.up[0] <= r.similar.up[2] && r.similar.down[0] >= r.similar.down[2]);
  assert.equal(r.timing.high.reduce((s, v) => s + v, 0), r.periods);
  assert.ok(r.test.tests > 100);
  assert.ok(r.test.direction.hit >= 0 && r.test.direction.hit <= 100);
});

test('bougie de la semaine : jeudi = jour 4 sur 7', () => {
  const r = candleStats(candles(d(2026, 11, 19)), 'w');
  assert.equal(r.first, d(2026, 11, 16));
  assert.equal(r.k, 4);
  assert.equal(r.left, 3);
  assert.equal(r.similar.n, 40);
});

test('bougie : prix tout en bas du mois → le plus bas est souvent cassé, le plus haut rarement', () => {
  const c = candles(d(2026, 11, 18), 11);
  // Chute de 25 % le 19 : très loin du plus haut, au plus bas du mois.
  const last = c.at(-1)[4];
  c.push([d(2026, 11, 19), last, last, last * 0.75, last * 0.75]);
  const r = candleStats(c, 'm');
  assert.ok(r.similar.high < r.all.high);
  assert.ok(r.similar.green < r.all.green);
});

test('bougie : période finie ou historique trop court → rien', () => {
  assert.equal(candleStats(candles(d(2026, 11, 30)), 'm'), null); // dernier jour du mois : rien ne reste
  assert.equal(candleStats(candles(d(2014, 2, 10)), 'm'), null);
});
