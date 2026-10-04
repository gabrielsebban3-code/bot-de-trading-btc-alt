// Heatmap : tri des cryptos, couleurs, placement des tuiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coins, isStableOrCopy, squarify, summary, tileColor } from '../js/treemap.js';

const cg = (symbol, name, mcap, c24 = 1, extra = {}) => ({
  id: name.toLowerCase().replace(/ /g, '-'), symbol: symbol.toLowerCase(), name, market_cap: mcap, current_price: 1,
  price_change_percentage_1h_in_currency: 0.1, price_change_percentage_24h_in_currency: c24, price_change_percentage_7d_in_currency: -2, ...extra,
});

test('coins : sans stablecoins, copies ni market cap inconnue, dans l\'ordre, `top` au plus', () => {
  const raw = [
    cg('BTC', 'Bitcoin', 2e12, 2), cg('ETH', 'Ethereum', 5e11), cg('USDT', 'Tether', 1.8e11), cg('XRP', 'XRP', 1.5e11),
    cg('USDC', 'USDC', 7e10), cg('STETH', 'Lido Staked Ether', 3e10), cg('WBTC', 'Wrapped Bitcoin', 1.4e10),
    cg('USDE', 'Ethena USDe', 1e10), cg('WEETH', 'Wrapped eETH', 9e9), cg('DAI', 'Dai', 5e9), cg('HYPE', 'Hyperliquid', 4e10),
    cg('X', 'Sans cap', 0), cg('PAXG', 'PAX Gold', 1e9),
  ];
  assert.deepEqual(coins(raw).map(c => c.symbol), ['BTC', 'ETH', 'XRP', 'HYPE', 'PAXG']);
  assert.deepEqual(coins(raw, 2).map(c => c.symbol), ['BTC', 'ETH']);
  assert.deepEqual(coins(raw)[0].change, { '1h': 0.1, '24h': 2, '7d': -2 });
  assert.deepEqual(coins(null), []);
  assert.equal(coins([cg('SOL', 'Solana', 1e11, null, { price_change_percentage_24h: -3 })])[0].change['24h'], -3, 'repli sur la variation 24 h simple');
  assert.equal(coins([cg('SOL', 'Solana', 1e11, null, { price_change_percentage_7d_in_currency: undefined })])[0].change['7d'], null);
  assert.ok(isStableOrCopy({ symbol: 'pyusd', name: 'PayPal USD' }) && !isStableOrCopy({ symbol: 'sui', name: 'Sui' }));
});

test('tileColor : gris autour de 0, vert ou rouge net dès un petit mouvement, plus vif ensuite, plafonné', () => {
  assert.equal(tileColor(0, 6), 'rgb(59, 63, 74)');
  assert.equal(tileColor(null, 6), 'rgb(59, 63, 74)');
  assert.equal(tileColor(-0.03, 6), 'rgb(59, 63, 74)', 'presque rien');
  assert.equal(tileColor(6, 6), 'rgb(23, 207, 99)');
  assert.equal(tileColor(50, 6), 'rgb(23, 207, 99)');
  assert.equal(tileColor(-50, 6), 'rgb(226, 36, 52)');
  const ch = (s, i) => Number(tileColor(s, 6).match(/\d+/g)[i]);
  assert.ok(ch(0.2, 1) > ch(0.2, 0) + 50, '+0,2 % : déjà vert');
  assert.ok(ch(-0.2, 0) > ch(-0.2, 1) + 60, '-0,2 % : déjà rouge');
  assert.ok(ch(1, 1) < ch(3, 1) && ch(3, 1) < ch(6, 1), 'de plus en plus vif');
  assert.ok(ch(-1, 0) < ch(-3, 0) && ch(-3, 0) < ch(-6, 0));
});

test('summary : moyenne pondérée par la market cap, hausses et baisses', () => {
  const list = coins([cg('BTC', 'Bitcoin', 3e12, 2), cg('ETH', 'Ethereum', 1e12, -2), cg('SOL', 'Solana', 1e11, 0), cg('ADA', 'Cardano', 1e10, null)]);
  const s = summary(list, '24h');
  assert.equal(s.up, 1);
  assert.equal(s.down, 1);
  assert.ok(Math.abs(s.avg - (3e12 * 2 - 1e12 * 2) / 4.1e12) < 1e-9);
  assert.equal(summary([], '24h').avg, null);
});

test('squarify : remplit le cadre, aires proportionnelles, sans chevauchement', () => {
  const values = [500, 200, 120, 80, 50, 30, 10, 6, 3, 1];
  const W = 800, H = 500;
  const r = squarify(values, 0, 0, W, H);
  assert.equal(r.length, values.length);
  const total = values.reduce((a, b) => a + b, 0);
  r.forEach((q, i) => {
    assert.ok(Math.abs(q.w * q.h - (values[i] / total) * W * H) < 1e-6, `aire ${i}`);
    assert.ok(q.x >= -1e-9 && q.y >= -1e-9 && q.x + q.w <= W + 1e-6 && q.y + q.h <= H + 1e-6, `dans le cadre ${i}`);
  });
  for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
    const a = r[i], b = r[j];
    const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;
    assert.ok(!overlap, `${i} et ${j} se chevauchent`);
  }
  // Tuiles plutôt carrées : la plus grosse n'est pas une bande.
  assert.ok(Math.max(r[0].w / r[0].h, r[0].h / r[0].w) < 3);
  assert.deepEqual(squarify([], 0, 0, 10, 10), []);
  assert.deepEqual(squarify([1, 1], 0, 0, 0, 10), [{ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 }]);
});

test('tileInk : texte foncé sur le vert vif, blanc sur les fonds sombres (contraste lisible)', async () => {
  const { tileInk, DARK_INK } = await import('../js/treemap.js');
  assert.equal(tileInk(0, 6), '#fff');
  assert.equal(tileInk(-1, 6), '#fff');
  assert.equal(tileInk(6, 6), DARK_INK);
  assert.equal(tileInk(null, 6), '#fff');
});
