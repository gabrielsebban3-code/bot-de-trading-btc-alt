import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertLimit, delayed, historyDays, isPremium, setPremium, tooOld, visibleIn } from '../js/premium.js';
import { whatsNew } from '../js/whatsnew.js';

globalThis.document = { body: { classList: { toggle() {} } } };
const H = 3600_000, DAY = 24 * H;
const NOW = Date.UTC(2026, 9, 4, 12);
const sig = (symbol, ageH) => ({ id: `${symbol}-${ageH}`, symbol, time: NOW - ageH * H - 4 * H, status: 'confirmé', outcome: 'open', dir: 'long' });

test('gratuit : SOL et pétrole avec 24 h de retard, BTC et ETH en direct', () => {
  setPremium(false);
  assert.equal(delayed(sig('BTC', 1), NOW), false);
  assert.equal(delayed(sig('ETH', 0), NOW), false);
  assert.equal(delayed(sig('SOL', 1), NOW), true);
  assert.equal(delayed(sig('BZ', 23), NOW), true);
  assert.equal(delayed(sig('SOL', 24), NOW), false);
  assert.equal(visibleIn(sig('SOL', 6), NOW), 18 * H);
  // Bougie pas encore fermée : cachée aussi.
  assert.equal(delayed({ symbol: 'SOL', time: NOW - H }, NOW), true);
});

test('gratuit : 3 mois d\'historique et 3 alertes ; Premium : tout', () => {
  setPremium(false);
  assert.equal(historyDays(), 90);
  assert.equal(alertLimit(), 3);
  assert.equal(tooOld({ time: NOW - 91 * DAY }, NOW), true);
  assert.equal(tooOld({ time: NOW - 89 * DAY }, NOW), false);
  setPremium(true);
  assert.equal(isPremium(), true);
  assert.equal(historyDays(), 365);
  assert.equal(alertLimit(), 20);
  assert.equal(tooOld({ time: NOW - 300 * DAY }, NOW), false);
  assert.equal(delayed(sig('SOL', 1), NOW), false);
  setPremium(false);
});

test('Quoi de neuf : les signaux encore cachés n\'apparaissent pas', () => {
  setPremium(false);
  const setups = { live: [sig('BTC', 2), sig('SOL', 2)], history: [] };
  const items = whatsNew({ setups, news: { items: [] }, list: ['BTC', 'SOL'], from: NOW - 2 * DAY, hide: s => delayed(s, NOW) });
  assert.deepEqual(items.map(i => i.title), ['Nouveau setup BTC long ▲']);
});
