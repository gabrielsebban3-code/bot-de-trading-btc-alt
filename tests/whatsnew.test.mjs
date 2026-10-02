// « Quoi de neuf pour toi » : nouveautés de la watchlist depuis la dernière visite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST, MAX_BACK, since, whatsNew } from '../js/whatsnew.js';

const NOW = Date.parse('2026-10-02T20:00:00Z');
const H = 3600_000;
const setup = (o) => ({ id: `${o.symbol}-${o.time}`, detector: 'swing', dir: 'long', status: 'confirmé', outcome: 'open', r: 0, ...o });

test('since : dernière visite, bornée à 7 jours, 3 jours sans visite connue', () => {
  assert.equal(since(new Date(NOW - 5 * H).toISOString(), NOW), NOW - 5 * H);
  assert.equal(since(new Date(NOW - 30 * 24 * H).toISOString(), NOW), NOW - MAX_BACK);
  assert.equal(since(null, NOW), NOW - FIRST);
  assert.equal(since('pas une date', NOW), NOW - FIRST);
});

test('whatsNew : seulement la watchlist, après la visite, le plus récent d\'abord', () => {
  const from = NOW - 10 * H;
  const setups = {
    live: [setup({ symbol: 'ETH', time: NOW - 2 * H })],
    history: [
      setup({ symbol: 'ETH', time: NOW - 2 * H }), // même setup que dans live : une seule fois
      setup({ symbol: 'BTC', time: NOW - 40 * H, outcome: 'tp1', at: NOW - 3 * H, r: 2 }),
      setup({ symbol: 'BTC', time: NOW - 40 * H, outcome: 'sl', at: NOW - 20 * H, r: -1, id: 'old' }), // avant la visite
      setup({ symbol: 'SOL', time: NOW - 1 * H }), // pas suivi
      setup({ symbol: 'ETH', time: NOW - 1 * H, status: 'en cours', id: 'pending' }), // bougie pas fermée
    ],
  };
  const news = { items: [
    { id: 'a', time: NOW - 1 * H, title: 'BTC chute', importance: 'critical', impacts: [['BTC', -1]] },
    { id: 'b', time: NOW - 1 * H, title: 'petite news', importance: 'low', impacts: [['BTC', -1]] },
    { id: 'c', time: NOW - 1 * H, title: 'pétrole', importance: 'medium', impacts: [['Pétrole', 1]] },
    { id: 'd', time: NOW - 30 * H, title: 'vieille', importance: 'critical', impacts: [['ETH', 1]] },
  ] };
  const got = whatsNew({ setups, news, list: ['BTC', 'ETH'], from });
  assert.deepEqual(got.map(i => i.title), ['BTC chute', 'Nouveau setup ETH long ▲', 'BTC : objectif TP1 touché']);
  assert.equal(got[1].href, `#setup/${encodeURIComponent('ETH-' + (NOW - 2 * H))}`);
  assert.equal(got[2].detail, 'Setup long ▲, +2 R');
  assert.deepEqual(whatsNew({ setups, news, list: ['CL'], from }).map(i => i.title), ['pétrole']);
  assert.deepEqual(whatsNew({ setups: null, news: null, list: ['BTC'], from }), []);
});
