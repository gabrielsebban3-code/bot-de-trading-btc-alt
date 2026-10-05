// Agenda économique sur Discord : les annonces qui font bouger le marché (inflation US, Fed, emploi, BCE, BoJ).
// Les événements viennent de data/marche.json (`agenda.events`, rempli par l'onglet Marché depuis ForexFactory,
// grosses annonces, plus les annonces moyennes marquées « minor » que Discord ignore pour rester discret). Ici : le bloc du résumé du matin et l'alerte 30 min avant.

import { DIGEST, clip, parisClock } from './digest.mjs';

export const AGENDA = {
  alertBeforeMs: 30 * 60e3, // alerte 30 min avant
  slackMs: 6 * 60e3, // les passages ont lieu toutes les 5 min : un peu de marge
  keepSent: 60,
};
const BLUE = 0x3b82f6;
const NFA = 'Pas un conseil financier.';

const hhmm = t => new Intl.DateTimeFormat('fr-FR', { timeZone: DIGEST.zone, hour: '2-digit', minute: '2-digit' }).format(new Date(t));
const FLAG = { USD: '🇺🇸', EUR: '🇪🇺', JPY: '🇯🇵' };

// Événements lisibles, avec l'heure en millisecondes ; un fichier absent ou vide donne une liste vide.
export function agendaEvents(marche) {
  return (marche?.agenda?.events || [])
    .map(e => ({ ...e, time: Date.parse(e.t) }))
    .filter(e => Number.isFinite(e.time) && e.title && !e.minor)
    .sort((a, b) => a.time - b.time);
}
const idOf = e => `${e.t}|${e.en || e.title}`;
const figures = e => [e.forecast && `prévu ${e.forecast}`, e.previous && `précédent ${e.previous}`].filter(Boolean).join(' · ');

// Annonces du jour (Paris) encore à venir ou passées de moins d'une heure, pour le résumé du matin.
export function todayAgenda(events, now = Date.now()) {
  const { day } = parisClock(now);
  const today = events.filter(e => parisClock(e.time).day === day);
  if (!today.length) return 'Aucune grosse annonce aujourd\'hui.';
  return clip(today.map(e => `• ${hhmm(e.time)} · ${FLAG[e.cur] || ''} ${e.title}${figures(e) ? ` (${figures(e)})` : ''}`.replace('  ', ' ')).join('\n'), 1024);
}

// Annonces qui tombent dans les 30 prochaines minutes et pas encore signalées.
export function dueAgenda(events, sent = [], now = Date.now()) {
  const done = new Set(sent);
  return events.filter(e => e.time > now && e.time - now <= AGENDA.alertBeforeMs + AGENDA.slackMs && !done.has(idOf(e)));
}
export const markSent = (sent = [], events) => [...sent, ...events.map(idOf)].slice(-AGENDA.keepSent);

export function agendaAlert(e, now = Date.now()) {
  const mins = Math.max(1, Math.round((e.time - now) / 60e3));
  return {
    title: clip(`Dans ${mins} min · ${FLAG[e.cur] || ''} ${e.title}`.replace('  ', ' '), 256),
    color: BLUE,
    description: [`Annonce à ${hhmm(e.time)} (heure de Paris).`, figures(e) && figures(e).replace(/^./, c => c.toUpperCase()) + '.',
      'Le prix peut bouger fort pendant quelques minutes : attention aux stops serrés.'].filter(Boolean).join('\n'),
    footer: { text: NFA },
    timestamp: new Date(e.time).toISOString(),
  };
}
