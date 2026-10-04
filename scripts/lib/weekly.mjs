// Bilan du dimanche sur Discord : trades de la semaine, news qui ont compté, annonces de la semaine suivante.
// News : le fil Actu ne garde que 72 h, donc chaque passage note les news moyennes et critiques dans
// data/alerts.json (`week`, 7 jours glissants). Sans IA, par règles.

import { DIGEST, byWeight, clip, distinct, line, num, parisClock } from './digest.mjs';

export const WEEKLY = {
  weekday: 0, // dimanche
  hour: 19, // heure de Paris à partir de laquelle le bilan part
  keepMs: 7 * 24 * 3600e3,
  maxLog: 80, // news retenues au plus dans le journal de la semaine
  news: 5,
  risk: 1, // % du capital risqué par trade (1R = 1 %), comme l'onglet Setups
};
const ACCENT = 0xff8a00;
const NFA = 'Pas un conseil financier.';

const weekdayParis = now => new Intl.DateTimeFormat('en-US', { timeZone: DIGEST.zone, weekday: 'short' }).format(new Date(now));

export function weeklyDue(state, now = Date.now()) {
  const { day, hour } = parisClock(now);
  return weekdayParis(now) === 'Sun' && hour >= WEEKLY.hour && state?.weekly !== day;
}

// Journal de la semaine : les news qui comptent, sans les baleines ni les non vérifiées, 7 jours au plus.
export function logWeek(log = [], news, now = Date.now()) {
  const keep = (log || []).filter(i => now - i.time <= WEEKLY.keepMs);
  const known = new Map(keep.map(i => [i.id, i]));
  for (const i of news?.items || []) {
    if (i.kind === 'whale' || i.unverified || i.importance === 'low' || now - i.time > WEEKLY.keepMs) continue;
    const entry = { id: i.id, time: i.time, title: i.title, titleEn: i.titleEn, link: i.link, importance: i.importance, count: i.count || 1, theme: i.theme };
    known.set(i.id, { ...known.get(i.id), ...entry });
  }
  return [...known.values()].sort(byWeight).slice(0, WEEKLY.maxLog);
}

const pct = r => `${r > 0 ? '+' : ''}${num(Math.round(r * WEEKLY.risk * 10) / 10)} %`;
const day = t => new Intl.DateTimeFormat('fr-FR', { timeZone: DIGEST.zone, weekday: 'short', day: 'numeric' }).format(new Date(t));

export function buildWeekly({ setups, log, agenda = [], siteUrl = '', now = Date.now() }) {
  const site = siteUrl ? siteUrl.replace(/\/?$/, '/') : undefined;
  const since = now - WEEKLY.keepMs;
  const all = [...(setups?.live || []), ...(setups?.history || [])].filter((s, k, a) => a.findIndex(x => x.id === s.id) === k);
  const closed = all.filter(s => s.outcome && s.outcome !== 'open' && s.at >= since && s.at <= now && Number.isFinite(s.r)).sort((a, b) => a.at - b.at);
  const opened = all.filter(s => s.status === 'confirmé' && s.outcome === 'open' && (s.confirmedAt ?? s.time) >= since);
  const total = closed.reduce((sum, s) => sum + s.r, 0);
  const trades = [
    ...closed.map(s => `• ${day(s.at)} · **${s.symbol}** ${s.dir === 'long' ? 'Long' : 'Short'} terminé : ${pct(s.r)}`),
    ...opened.map(s => `• ${day(s.confirmedAt ?? s.time)} · **${s.symbol}** ${s.dir === 'long' ? 'Long' : 'Short'} ouvert, toujours en cours`),
  ];
  const tradeText = trades.length
    ? [...trades, closed.length ? `**Total de la semaine : ${pct(total)} du capital**` : null].filter(Boolean).join('\n')
    : 'Aucun trade cette semaine : la stratégie attend un vrai signal.';
  const top = distinct((log || []).filter(i => i.time >= since).sort(byWeight), WEEKLY.news);
  const newsText = top.length ? top.sort((a, b) => a.time - b.time).map(i => line(i).replace(/^• /, `• ${day(i.time)} `)).join('\n') : 'Semaine calme : aucune news marquante.';
  const next = agenda.filter(e => e.time > now && e.time - now <= WEEKLY.keepMs).sort((a, b) => a.time - b.time).slice(0, 8);
  const fields = [
    { name: 'Tes trades', value: clip(tradeText, 1024) },
    { name: 'Les news qui ont compté', value: clip(newsText, 1024) },
    ...(next.length ? [{ name: 'La semaine prochaine', value: clip(next.map(e => `• ${day(e.time)} ${new Intl.DateTimeFormat('fr-FR', { timeZone: DIGEST.zone, hour: '2-digit', minute: '2-digit' }).format(new Date(e.time))} · ${e.title}`).join('\n'), 1024) }] : []),
  ];
  return { day: parisClock(now).day, embeds: [{ title: 'Bilan de la semaine', url: site, color: ACCENT, fields, footer: { text: NFA } }] };
}
