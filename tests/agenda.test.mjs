// Agenda économique sur Discord : bloc du résumé du matin et alerte 30 min avant, une seule fois.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agendaAlert, agendaEvents, dueAgenda, markSent, todayAgenda } from '../scripts/lib/agenda.mjs';
import { buildDigest } from '../scripts/lib/digest.mjs';

const now = Date.UTC(2026, 9, 7, 6, 0); // mercredi 7 octobre, 8 h à Paris
const marche = { agenda: { fetchedAt: '2026-10-07T05:00:00Z', nextWeek: false, events: [
  { t: '2026-10-07T18:00:00.000Z', title: 'Compte rendu de la réunion de la Fed', en: 'FOMC Meeting Minutes', cur: 'USD', forecast: null, previous: null },
  { t: '2026-10-07T12:30:00.000Z', title: 'Inflation US (CPI)', en: 'CPI m/m', cur: 'USD', forecast: '0,3 %', previous: '0,4 %' },
  { t: '2026-10-08T12:15:00.000Z', title: 'Taux de la BCE', en: 'Main Refinancing Rate', cur: 'EUR', forecast: null, previous: null },
  { t: 'pas une date', title: 'Cassé' },
] } };

test('événements triés par heure, entrées invalides ignorées, fichier absent = liste vide', () => {
  const ev = agendaEvents(marche);
  assert.deepEqual(ev.map(e => e.en), ['CPI m/m', 'FOMC Meeting Minutes', 'Main Refinancing Rate']);
  assert.deepEqual(agendaEvents(null), []);
});

test('résumé du matin : les annonces du jour à l\'heure de Paris, avec prévu et précédent', () => {
  const text = todayAgenda(agendaEvents(marche), now);
  assert.equal(text, '• 14:30 · 🇺🇸 Inflation US (CPI) (prévu 0,3 % · précédent 0,4 %)\n• 20:00 · 🇺🇸 Compte rendu de la réunion de la Fed');
  assert.equal(todayAgenda([], now), 'Aucune grosse annonce aujourd\'hui.');
  const d = buildDigest({ setups: { live: [] }, news: { items: [] }, agenda: text, now });
  assert.equal(d.embeds[0].fields[2].name, 'Agenda du jour');
  assert.equal(buildDigest({ setups: { live: [] }, news: { items: [] }, now }).embeds[0].fields.length, 2);
});

test('alerte 30 min avant : une seule fois, pas pour une annonce passée ou lointaine', () => {
  const ev = agendaEvents(marche);
  const at = Date.UTC(2026, 9, 7, 12, 2); // 28 min avant le CPI
  const due = dueAgenda(ev, [], at);
  assert.deepEqual(due.map(e => e.en), ['CPI m/m']);
  const sent = markSent([], due);
  assert.deepEqual(dueAgenda(ev, sent, Date.UTC(2026, 9, 7, 12, 7)), []);
  assert.deepEqual(dueAgenda(ev, [], Date.UTC(2026, 9, 7, 12, 31)), []); // déjà passée
  assert.deepEqual(dueAgenda(ev, [], Date.UTC(2026, 9, 7, 11, 0)), []); // 1 h 30 avant
  const a = agendaAlert(due[0], at);
  assert.equal(a.title, 'Dans 28 min · 🇺🇸 Inflation US (CPI)');
  assert.match(a.description, /Annonce à 14:30 \(heure de Paris\)\.\nPrévu 0,3 % · précédent 0,4 %\./);
});
