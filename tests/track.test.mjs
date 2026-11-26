import test from 'node:test';
import assert from 'node:assert/strict';
import { trackRecord } from '../js/setups.js';

const D = 86_400_000;
const now = Date.UTC(2026, 10, 9);
const t = (r, daysAgo, outcome = r < 0 ? 'sl' : 'exit') => ({ r, outcome, at: now - daysAgo * D });

test('bilan 12 mois et série de stops depuis le dernier gain', () => {
  const h = [{ outcome: 'open', at: null, r: null }, t(-1, 5), t(-1, 14), t(-1, 30), t(6.92, 55), t(5.75, 60), t(-1, 70), t(4, 400)];
  const r = trackRecord(h, now);
  assert.equal(r.n, 6); // le trade de plus d'un an et le trade ouvert sont exclus
  assert.equal(r.wins, 2);
  assert.equal(r.total, 8.7);
  assert.deepEqual(r.streak, { kind: 'loss', n: 3, sum: -3, since: now - 55 * D });
});

test('série de gains et cas sans dernier gain', () => {
  assert.equal(trackRecord([t(5, 1), t(2.5, 3, 'be'), t(-1, 9)], now).streak.n, 2);
  const all = trackRecord([t(-1, 1), t(-1, 2)], now);
  assert.deepEqual(all.streak, { kind: 'loss', n: 2, sum: -2, since: null });
  assert.equal(trackRecord([], now).streak.n, 0);
});
