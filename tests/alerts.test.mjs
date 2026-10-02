// Alertes Discord : seulement ce qui vient d'apparaître, jamais d'avalanche, messages épurés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALERTS, pickAlerts, toDiscord } from '../scripts/lib/alerts.mjs';

const now = Date.UTC(2026, 9, 2, 16);
const h = n => now - n * 3600e3;
const setup = (id, o = {}) => ({ id, symbol: 'BTC', dir: 'long', status: 'confirmé', outcome: 'open', time: h(1), entry: 86619.4, sl: 84000, tp: [91857, 94476, 97095], rr: 2, why: 'Cassure du plus haut de 20 jours.', detector: 'breakout', ...o });
const news = (id, o = {}) => ({ id, ids: [id], importance: 'critical', time: h(1), title: 'La Fed baisse ses taux', why: 'Argent moins cher.', impacts: [['BTC', 1]], link: 'https://ex.fr/a', sources: ['Reuters'], ...o });
const S = live => ({ live, detectors: { breakout: 'Cassure 20 jours' } });
const N = items => ({ items });

test('nouveau setup confirmé et nouvelle news critique : envoyés', () => {
  const out = pickAlerts({ setups: S([setup('a'), setup('b')]), prevSetups: S([setup('a')]), news: N([news('n1')]), prevNews: N([]), now });
  assert.deepEqual(out.map(a => a.item.id), ['b', 'n1']);
  assert.equal(out[0].detector, 'Cassure 20 jours');
});

test('rien à envoyer : déjà vu, en cours, terminé, trop vieux, pas critique', () => {
  const out = pickAlerts({
    setups: S([setup('a'), setup('c', { status: 'en cours' }), setup('d', { outcome: 'sl' }), setup('e', { time: h(30) })]),
    prevSetups: S([setup('a')]),
    news: N([news('n1', { ids: ['n1', 'n2'] }), news('n3', { importance: 'medium' }), news('n4', { time: h(7) })]),
    prevNews: N([news('n2')]),
    now,
  });
  assert.deepEqual(out, []);
});

test('signal journalier : l\'âge compte depuis la clôture de la journée', () => {
  const day = setup('j', { time: h(25), confirmedAt: h(1) });
  assert.deepEqual(pickAlerts({ setups: S([day]), prevSetups: S([]), news: null, prevNews: null, now }).map(a => a.item.id), ['j']);
});

test('premier passage (pas de version en ligne) : aucune alerte', () => {
  assert.deepEqual(pickAlerts({ setups: S([setup('a')]), prevSetups: null, news: N([news('n1')]), prevNews: null, now }), []);
});

test('jamais plus de 5 messages d\'un coup, les plus récents', () => {
  const items = Array.from({ length: 8 }, (_, k) => news(`n${k}`, { time: h(5 - k * 0.5) }));
  const out = pickAlerts({ news: N(items), prevNews: N([]), now });
  assert.equal(out.length, ALERTS.maxPerRun);
  assert.equal(out.at(-1).item.id, 'n7');
});

test('message Discord : vert pour un long, rouge pour un short, lien vers le setup', () => {
  const long = toDiscord({ kind: 'setup', item: setup('BTC-1'), detector: 'Cassure 20 jours' }, 'https://site.fr/dinexo');
  assert.equal(long.color, 0x22c55e);
  assert.equal(long.title, 'BTC · Long · Cassure 20 jours');
  assert.equal(long.url, 'https://site.fr/dinexo/#setup/BTC-1');
  assert.deepEqual(long.fields.map(f => f.value), ['86 619', '84 000', '1:2', '91 857 · 94 476 · 97 095']);
  assert.equal(toDiscord({ kind: 'setup', item: setup('x', { dir: 'short' }) }).color, 0xef4444);
  const n = toDiscord({ kind: 'news', item: news('n1') });
  assert.match(n.title, /^Critique · La Fed/);
  assert.match(n.description, /Impact probable : BTC ▲/);
  assert.match(n.footer.text, /Reuters · Pas un conseil financier/);
});
