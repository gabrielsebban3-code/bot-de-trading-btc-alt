// Outil « Liquidations » (js/liquidations-lib.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liquidationMap, liquidationSummary, positionsOf } from '../js/liquidations-lib.js';

const pos = (coin, szi, value, liq) => ({ position: { coin, szi: String(szi), entryPx: '100', positionValue: String(value), liquidationPx: liq == null ? null : String(liq), leverage: { value: 10 } } });

test('positionsOf : sens, valeur, prix de liquidation, autre crypto ignorée', () => {
  const p = positionsOf({ assetPositions: [pos('BTC', 0.5, 50000, 90), pos('BTC', -1, 100000, null), pos('ETH', 2, 4000, 1500), pos('BTC', 0, 0, 1)] }, 'BTC');
  assert.deepEqual(p.map(x => [x.side, x.value, x.liq]), [['long', 50000, 90], ['short', 100000, null]]);
  assert.deepEqual(positionsOf(null, 'BTC'), []);
});

test('liquidationMap : longs sous le prix, shorts au-dessus, cumul et zones', () => {
  const list = [
    { side: 'long', value: 100, liq: 98.2 }, { side: 'long', value: 50, liq: 98.4 }, { side: 'long', value: 30, liq: 90.1 },
    { side: 'short', value: 70, liq: 103.1 }, { side: 'short', value: 10, liq: 200 }, { side: 'long', value: 5, liq: null },
  ];
  const m = liquidationMap(list, 100, { step: 1, range: 20 });
  assert.equal(m.buckets.length, 40);
  assert.equal(m.longs, 185);
  assert.equal(m.shorts, 80);
  assert.equal(m.noLiq, 5);
  assert.equal(m.far, 10);
  assert.equal(m.topLong[0].value, 150);
  assert.ok(Math.abs(m.topLong[0].price - 98.5) < 1e-9);
  assert.equal(m.topShort[0].value, 70);
  assert.equal(m.within(2, 'long'), 150);
  assert.equal(m.within(10, 'long'), 180);
  assert.equal(m.within(5, 'short'), 70);
  const s = liquidationSummary(list.map((x, i) => ({ ...x, account: `a${i % 2}` })), 100, { step: 1, range: 20 });
  assert.deepEqual(s.near, [[2, 150, 0], [5, 150, 70], [10, 180, 70]]);
  assert.equal(s.accounts, 2);
  assert.equal(typeof s.within, 'undefined');
});
