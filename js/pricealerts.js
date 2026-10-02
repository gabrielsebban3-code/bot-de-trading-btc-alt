// Alertes de prix des membres : « BTC au-dessus de 90 000 », « SOL sous 120 ».
// Gardées dans le compte (profiles.alerts), vérifiées avec les prix en direct tant que le site est ouvert.
import { valid } from './watchlist.js';

export const MAX_ALERTS = 20;

// Saisie française : « 90 000 », « 0,45 » ou « 1.5 ».
export function parsePrice(text) {
  const n = Number(String(text ?? '').replace(/[\s  ]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Liste lue dans le compte : on ne garde que des alertes bien formées, sans doublon, 20 au plus.
export function normalizeAlerts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.filter(a => a && typeof a.id === 'string' && !seen.has(a.id) && seen.add(a.id)
    && valid(a.symbol) && ['above', 'below'].includes(a.dir) && Number.isFinite(a.price) && a.price > 0)
    .map(a => ({ id: a.id, symbol: a.symbol, dir: a.dir, price: a.price, created: Number(a.created) || 0, hit: Number(a.hit) || null }))
    .slice(0, MAX_ALERTS);
}

export const crossed = (a, last) => (a.dir === 'above' ? last >= a.price : last <= a.price);

// Alertes encore actives dont le prix actuel a franchi le seuil : elles passent « déclenchées ».
export function checkAlerts(alerts, lastOf, now = Date.now()) {
  const hits = [];
  const next = alerts.map(a => {
    const last = a.hit ? null : lastOf(a.symbol);
    if (last == null || !crossed(a, last)) return a;
    const hit = { ...a, hit: now, at: last };
    hits.push(hit);
    return hit;
  });
  return { alerts: next, hits };
}

// Sens proposé par défaut : au-dessus si l'objectif est plus haut que le prix actuel.
export const guessDir = (target, last) => (last != null && target < last ? 'below' : 'above');
