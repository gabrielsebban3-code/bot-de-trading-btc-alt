// Résumé du matin sur Discord : une fois par jour après 7 h (Paris), setups en cours, news du jour, géopolitique.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, digestDue, geoSummary, parisClock, zoneOf } from '../scripts/lib/digest.mjs';

const now = Date.UTC(2026, 9, 3, 6, 30); // 8 h 30 à Paris (heure d'été)
const h = n => now - n * 3600e3;
const item = (id, o = {}) => ({ id, time: h(2), importance: 'medium', theme: 'cb', title: `Titre ${id}`, titleEn: `Title ${id}`, link: `https://ex.fr/${id}`, impacts: [], ...o });

test('heure de Paris : changement de jour à minuit Paris, pas UTC', () => {
  assert.deepEqual(parisClock(Date.UTC(2026, 9, 3, 22, 30)), { day: '2026-10-04', hour: 0 });
  assert.deepEqual(parisClock(Date.UTC(2026, 11, 3, 6, 30)), { day: '2026-12-03', hour: 7 }); // heure d'hiver
});

test('une fois par jour, à partir de 7 h', () => {
  assert.equal(digestDue({}, now), true);
  assert.equal(digestDue({ digest: '2026-10-03' }, now), false);
  assert.equal(digestDue({ digest: '2026-10-02' }, Date.UTC(2026, 9, 3, 4, 30)), false); // 6 h 30 à Paris
});

test('zones reconnues sur le titre anglais', () => {
  assert.equal(zoneOf({ titleEn: 'Israel strikes Hezbollah targets in Lebanon' }), 'Moyen-Orient');
  assert.equal(zoneOf({ titleEn: 'Russian drones hit Kyiv overnight' }), 'Russie et Ukraine');
  assert.equal(zoneOf({ titleEn: 'China sends warships near Taiwan' }), 'Chine et Taïwan');
  assert.equal(zoneOf({ titleEn: 'US raises tariffs on EU cars' }), 'Commerce mondial');
});

test('géopolitique : tension ou détente par zone, effet probable, rien de vieux ni de non vérifié', () => {
  const news = { items: [
    item('a', { theme: 'geo', importance: 'critical', titleEn: 'Iran fires missiles at Israel', impacts: [['Pétrole', 1], ['Or', 1], ['BTC', -1]] }),
    item('b', { theme: 'geo', titleEn: 'Houthis attack tanker in Red Sea', impacts: [['Pétrole', 1]] }),
    item('c', { theme: 'geo', titleEn: 'Russia and Ukraine agree ceasefire', impacts: [['Pétrole', -1], ['Or', -1]] }),
    item('d', { theme: 'geo', titleEn: 'Old Iran news', time: h(30) }),
    item('e', { theme: 'geo', titleEn: 'Blog says Iran war', unverified: true }),
  ] };
  const { zones, text } = geoSummary(news, now);
  assert.deepEqual(zones.map(z => z.zone), ['Moyen-Orient', 'Russie et Ukraine']);
  assert.match(text, /\*\*Moyen-Orient\*\* : escalade majeure \(2 news\)/);
  assert.match(text, /\*\*Russie et Ukraine\*\* : signes de détente \(1 news\)/);
  assert.match(text, /Effet probable : Pétrole ▲ · BTC ▼/);
  assert.doesNotMatch(text, /Titre d|Titre e/);
  assert.equal(geoSummary({ items: [] }, now).text, 'Aucune news géopolitique marquante ces dernières 24 h.');
});

test('message complet : setups ouverts, 3 news hors géopolitique sans baleines ni faibles', () => {
  const setups = { live: [
    { id: 's1', symbol: 'BTC', dir: 'long', status: 'confirmé', outcome: 'open', time: h(5), entry: 86619.4, sl: 84000 },
    { id: 's2', symbol: 'ETH', dir: 'short', status: 'confirmé', outcome: 'sl', time: h(5), entry: 1, sl: 2 },
    { id: 's3', symbol: 'SOL', dir: 'long', status: 'en cours', outcome: 'open', time: h(5), entry: 1, sl: 2 },
  ] };
  const news = { items: [
    item('n1', { importance: 'critical', impacts: [['BTC', 1]] }), item('n2'), item('n3'), item('n4'),
    item('w', { kind: 'whale', importance: 'medium' }), item('l', { importance: 'low' }),
  ] };
  const d = buildDigest({ setups, news, siteUrl: 'https://site.fr/dinexo', now });
  assert.equal(d.day, '2026-10-03');
  assert.equal(d.embeds.length, 2);
  const [setupField, newsField] = d.embeds[0].fields;
  assert.equal(setupField.name, 'Setups en cours (1)');
  assert.match(setupField.value, /\*\*BTC\*\* Long · entrée 86 619 · stop 84 000/);
  assert.equal(newsField.value.split('\n').length, 3);
  assert.match(newsField.value.split('\n')[0], /\[Titre n1\]\(https:\/\/ex\.fr\/n1\) · BTC ▲$/);
  assert.doesNotMatch(newsField.value, /Titre w|Titre l/);
  assert.equal(d.embeds[1].url, 'https://site.fr/dinexo/#actu');
});

test('jour sans rien : messages clairs', () => {
  const d = buildDigest({ setups: { live: [] }, news: { items: [] }, now });
  assert.match(d.embeds[0].fields[0].value, /Aucun setup en cours/);
  assert.match(d.embeds[0].fields[1].value, /Rien de marquant/);
});

test('même événement par deux médias : un seul titre ; réaction du prix seulement si elle est nette', () => {
  const news = { items: [
    item('t1', { theme: 'geo', titleEn: 'Tanker attacked off Oman coast, says UK maritime agency', impacts: [['Pétrole', 1]], count: 3, reaction: { asset: 'Pétrole', pct: 1.4, strong: true } }),
    item('t2', { theme: 'geo', titleEn: 'Tanker hit by unknown projectile off Oman, UKMTO says', impacts: [['Pétrole', 1]] }),
    item('t3', { theme: 'geo', titleEn: 'Russian drones hit Kyiv overnight', reaction: { asset: 'Pétrole', pct: 0 } }),
  ] };
  const lines = geoSummary(news, now).text.split('\n').filter(l => l.startsWith('•'));
  assert.equal(lines.length, 2);
  assert.match(lines.join('\n'), /Titre t1\]\([^)]*\) · Pétrole \+1,4 % en 1 h/);
  assert.doesNotMatch(lines.join('\n'), /Titre t2|0 % en 1 h/);
});
