// « Quoi de neuf pour toi » : ce qui a bougé sur les actifs de la watchlist depuis la dernière visite d'un membre.
import { touches } from './watchlist.js';

const DAY = 86_400_000;
// Sans dernière visite connue (première connexion), on remonte 3 jours ; jamais plus de 7, pour rester lisible.
export const FIRST = 3 * DAY;
export const MAX_BACK = 7 * DAY;
const RESULT = { tp1: 'objectif TP1 touché', sl: 'stop touché', expired: 'sortie au bout de 5 jours' };
const LEVEL = { critical: 2, medium: 1 };

export function since(lastSeen, now = Date.now()) {
  const t = Date.parse(lastSeen ?? '');
  return Number.isFinite(t) ? Math.max(t, now - MAX_BACK) : now - FIRST;
}

// Retourne les nouveautés, la plus récente d'abord : { time, kind, title, detail, href, tone }.
export function whatsNew({ setups, news, list, from, projectSymbol = () => null, limit = 12 }) {
  const out = [];
  const watched = new Set(list);
  const seen = new Set();
  for (const s of [...(setups?.live || []), ...(setups?.history || [])]) {
    if (!watched.has(s.symbol) || s.status !== 'confirmé' || seen.has(s.id)) continue;
    seen.add(s.id);
    const dir = s.dir === 'long' ? 'long ▲' : 'short ▼';
    if (s.outcome !== 'open' && s.at > from) {
      out.push({
        time: s.at, kind: 'setup', title: `${s.symbol} : ${RESULT[s.outcome] || 'trade terminé'}`,
        detail: `Setup ${dir}, ${s.r > 0 ? '+' : ''}${Math.round(s.r * 10) / 10} R`, href: '#historique', tone: s.r > 0 ? 'up' : s.r < 0 ? 'down' : '',
      });
    } else if (s.time > from) {
      out.push({
        time: s.time, kind: 'setup', title: `Nouveau setup ${s.symbol} ${dir}`,
        detail: s.outcome === 'open' ? 'En jeu en ce moment' : 'Déjà terminé', href: s.outcome === 'open' ? `#setup/${encodeURIComponent(s.id)}` : '#historique', tone: 'acc',
      });
    }
  }
  for (const i of news?.items || []) {
    if (i.time <= from || !LEVEL[i.importance] || !touches(i, list, projectSymbol)) continue;
    out.push({ time: i.time, kind: 'news', title: i.title, detail: i.importance === 'critical' ? 'News critique' : 'News', href: `#actu/${encodeURIComponent(i.id)}`, tone: i.importance === 'critical' ? 'down' : 'mid' });
  }
  return out.sort((a, b) => b.time - a.time).slice(0, limit);
}
