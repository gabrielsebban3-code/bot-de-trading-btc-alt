// Bilan du dimanche sur Discord : trades de la semaine en % du capital, news qui ont compté, annonces à venir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWeekly, logWeek, weeklyDue } from '../scripts/lib/weekly.mjs';

const now = Date.UTC(2026, 9, 4, 17, 30); // dimanche 4 octobre, 19 h 30 à Paris
const d = n => now - n * 24 * 3600e3;
const news = (id, o = {}) => ({ id, time: d(1), importance: 'medium', theme: 'cb', title: `Titre ${id}`, titleEn: `Fed story number ${id} unique words ${id}x`, link: `https://ex.fr/${id}`, ...o });

test('le dimanche après 19 h (Paris), une seule fois', () => {
  assert.equal(weeklyDue({}, now), true);
  assert.equal(weeklyDue({ weekly: '2026-10-04' }, now), false);
  assert.equal(weeklyDue({}, Date.UTC(2026, 9, 4, 16)), false); // 18 h
  assert.equal(weeklyDue({}, Date.UTC(2026, 9, 3, 18)), false); // samedi
});

test('journal de la semaine : garde 7 jours, ignore faibles, baleines et non vérifiées, met à jour', () => {
  const log = logWeek([news('old', { time: d(8) }), news('a', { count: 1 })], { items: [
    news('a', { count: 4 }), news('b', { importance: 'critical' }), news('l', { importance: 'low' }),
    news('w', { kind: 'whale' }), news('u', { unverified: true }),
  ] }, now);
  assert.deepEqual(log.map(i => i.id), ['b', 'a']);
  assert.equal(log[1].count, 4);
});

test('bilan : trades terminés en % du capital avec total, trade ouvert, news, semaine prochaine', () => {
  const setups = {
    live: [{ id: 'o', symbol: 'SOL', dir: 'long', status: 'confirmé', outcome: 'open', time: d(2), confirmedAt: d(2) }],
    history: [
      { id: 'w', symbol: 'ETH', dir: 'long', outcome: 'exit', at: d(3), r: 5.8 },
      { id: 'l', symbol: 'BTC', dir: 'short', outcome: 'sl', at: d(1), r: -1 },
      { id: 'x', symbol: 'BZ', dir: 'long', outcome: 'sl', at: d(9), r: -1 },
    ],
  };
  const agenda = [{ time: now + 2 * 24 * 3600e3, title: 'Inflation US (CPI)' }, { time: now + 9 * 24 * 3600e3, title: 'Trop loin' }];
  const w = buildWeekly({ setups, log: [news('n1', { importance: 'critical', titleEn: 'Fed cuts rates by half point' }), news('n2', { titleEn: 'Solana ETF approved by SEC' })], agenda, siteUrl: 'https://site.fr/d', now });
  const [trades, top, next] = w.embeds[0].fields;
  assert.match(trades.value, /\*\*ETH\*\* Long terminé : \+5,8 %/);
  assert.match(trades.value, /\*\*BTC\*\* Short terminé : -1 %/);
  assert.match(trades.value, /\*\*SOL\*\* Long ouvert, toujours en cours/);
  assert.match(trades.value, /Total de la semaine : \+4,8 % du capital/);
  assert.doesNotMatch(trades.value, /BZ/);
  assert.equal(top.value.split('\n').length, 2);
  assert.equal(next.name, 'La semaine prochaine');
  assert.match(next.value, /Inflation US \(CPI\)/);
  assert.doesNotMatch(next.value, /Trop loin/);
});

test('semaine vide : messages clairs, pas de bloc « semaine prochaine » sans agenda', () => {
  const w = buildWeekly({ setups: { live: [], history: [] }, log: [], now });
  assert.equal(w.embeds[0].fields.length, 2);
  assert.match(w.embeds[0].fields[0].value, /Aucun trade cette semaine/);
  assert.match(w.embeds[0].fields[1].value, /Semaine calme/);
});
