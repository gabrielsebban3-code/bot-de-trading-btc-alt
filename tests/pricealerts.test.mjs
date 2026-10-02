// Alertes de prix : saisie, nettoyage de la liste du compte, déclenchement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ALERTS, checkAlerts, guessDir, normalizeAlerts, parsePrice } from '../js/pricealerts.js';

test('parsePrice : écriture française', () => {
  assert.equal(parsePrice('90 000'), 90000);
  assert.equal(parsePrice('0,45'), 0.45);
  assert.equal(parsePrice('1.5'), 1.5);
  assert.equal(parsePrice('84 000'), 84000);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('-3'), null);
  assert.equal(parsePrice('abc'), null);
});

test('normalizeAlerts : garde les alertes valides, sans doublon, 20 au plus', () => {
  const ok = { id: 'a', symbol: 'BTC', dir: 'above', price: 90000, created: 1 };
  assert.deepEqual(normalizeAlerts([ok, { ...ok }, { ...ok, id: 'b', symbol: 'btc' }, { ...ok, id: 'c', dir: 'up' }, { ...ok, id: 'd', price: -1 }, null]),
    [{ ...ok, hit: null }]);
  assert.deepEqual(normalizeAlerts('pas une liste'), []);
  const many = Array.from({ length: 30 }, (_, i) => ({ ...ok, id: String(i) }));
  assert.equal(normalizeAlerts(many).length, MAX_ALERTS);
});

test('checkAlerts : déclenche une seule fois, quand le seuil est franchi', () => {
  const alerts = normalizeAlerts([
    { id: 'up', symbol: 'BTC', dir: 'above', price: 90000 },
    { id: 'down', symbol: 'SOL', dir: 'below', price: 120 },
    { id: 'none', symbol: 'ETH', dir: 'above', price: 5000 },
  ]);
  const prices = { BTC: 90100, SOL: 125, ETH: null };
  const first = checkAlerts(alerts, s => prices[s], 1000);
  assert.deepEqual(first.hits.map(h => [h.id, h.at, h.hit]), [['up', 90100, 1000]]);
  prices.SOL = 119;
  const second = checkAlerts(first.alerts, s => prices[s], 2000);
  assert.deepEqual(second.hits.map(h => h.id), ['down']);
  assert.equal(second.alerts.find(a => a.id === 'up').hit, 1000, 'déjà déclenchée : pas de nouvelle alerte');
});

test('guessDir : au-dessus si l\'objectif dépasse le prix actuel', () => {
  assert.equal(guessDir(100, 90), 'above');
  assert.equal(guessDir(80, 90), 'below');
  assert.equal(guessDir(80, null), 'above');
});
