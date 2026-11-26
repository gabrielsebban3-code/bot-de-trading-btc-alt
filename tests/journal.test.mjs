import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateJournal, journalStats, openRisk, ORPHAN_MS } from '../js/journal-lib.js';

const H = 3_600_000;
const sig = (o = {}) => ({ id: 'BTC-range20-long-1', symbol: 'BTC', dir: 'long', detector: 'range20', status: 'confirmé', time: 1000 * H, confirmedAt: 1001 * H, entry: 100, sl: 97, sz: 1.2, score: 0.6, outcome: 'open', r: null, at: null, tpHit: null, ...o });

test('un signal frais entre dans le journal avec ses chiffres figés', () => {
  const j = updateJournal(null, [sig()], { BTC: 100.4 }, 1002 * H, 'h1d1n');
  assert.equal(j.start, 1002 * H);
  // le journal commence au premier passage : un signal plus ancien que le départ n'entre pas
  assert.equal(j.entries.length, 0);
  const j2 = updateJournal({ start: 900 * H, entries: [] }, [sig()], { BTC: 100.4 }, 1002 * H, 'h1d1n');
  assert.equal(j2.entries.length, 1);
  assert.deepEqual([j2.entries[0].entry, j2.entries[0].sl, j2.entries[0].sz, j2.entries[0].priceSeen, j2.entries[0].model], [100, 97, 1.2, 100.4, 'h1d1n']);
});

test('un signal du passé recalculé n\'entre pas', () => {
  const j = updateJournal({ start: 900 * H, entries: [] }, [sig()], {}, 1010 * H, 'h1d1n');
  assert.equal(j.entries.length, 0);
});

test('le résultat est recopié, les chiffres d\'entrée ne bougent jamais', () => {
  let j = updateJournal({ start: 900 * H, entries: [] }, [sig()], {}, 1002 * H, 'm');
  j = updateJournal(j, [sig({ outcome: 'exit', r: 3.5, at: 1100 * H })], {}, 1101 * H, 'm');
  assert.equal(j.entries[0].outcome, 'exit');
  assert.equal(j.entries[0].r, 3.5);
  // les règles changent ensuite : le trade terminé reste tel quel
  j = updateJournal(j, [sig({ entry: 101, outcome: 'sl', r: -1, at: 1050 * H })], {}, 1200 * H, 'autre');
  assert.equal(j.entries[0].r, 3.5);
  assert.equal(j.entries[0].entry, 100);
  assert.deepEqual(journalStats(j), { start: 900 * H, signals: 1, open: 0, done: 1, wins: 1, total: 4.2, orphans: 0 });
});

test('un trade ouvert que les nouvelles règles ne retrouvent plus est mis de côté, hors bilan', () => {
  let j = updateJournal({ start: 900 * H, entries: [] }, [sig()], {}, 1002 * H, 'm');
  j = updateJournal(j, [], {}, 1003 * H, 'm');
  assert.equal(j.entries[0].outcome, 'open');
  j = updateJournal(j, [sig({ sl: 98 })], {}, 1002 * H + ORPHAN_MS + H, 'autre');
  assert.equal(j.entries[0].outcome, 'orphan');
  assert.equal(journalStats(j).done, 0);
  assert.equal(journalStats(j).orphans, 1);
});

test('le journal n\'est jamais vidé quand un signal disparaît', () => {
  let j = updateJournal({ start: 900 * H, entries: [] }, [sig({ outcome: 'sl', r: -1, at: 1005 * H })], {}, 1002 * H, 'm');
  j = updateJournal(j, [], {}, 2000 * H, 'm');
  assert.equal(j.entries.length, 1);
  assert.equal(journalStats(j).total, -1.2);
});

test('risque total : les trades à moitié pris ne comptent plus, le sens est compté', () => {
  const live = [
    sig({ dir: 'short', sz: 1 }), sig({ id: 'b', dir: 'short', sz: 0.5 }), sig({ id: 'c', dir: 'short', sz: 2 }),
    sig({ id: 'd', dir: 'long', tpHit: true }), sig({ id: 'e', status: 'en cours' }), sig({ id: 'f', outcome: 'sl' }),
  ];
  assert.deepEqual(openRisk(live, 1), { open: 4, atRisk: 3, pct: 3.5, dirs: { long: 0, short: 3 } });
});
