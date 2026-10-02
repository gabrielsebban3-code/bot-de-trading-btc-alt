// Watchlist : les actifs suivis (symboles comme BTC, CL ou le ticker d'un projet). Gardée sur l'appareil, et dans
// le compte quand on est connecté (js/account.js). Fonctions pures, sans accès au DOM, testées dans tests/watchlist.test.mjs.

export const DEFAULT = ['BTC', 'ETH', 'SOL'];
export const MAX = 50;
const KEY = 'dinexo-watchlist';

// « $sol », « Sol » → « SOL ». Un symbole : lettres et chiffres, 15 caractères au plus.
export const clean = s => String(s ?? '').trim().replace(/^\$/, '').toUpperCase();
export const valid = s => /^[A-Z0-9]{1,15}$/.test(s);

export function normalize(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const c = clean(s);
    if (valid(c) && !out.includes(c)) out.push(c);
  }
  return out.slice(0, MAX);
}

// Première connexion sur un appareil : on garde ce qui est déjà dans le compte, puis ce qui a été ajouté ici.
export const merge = (account, device) => normalize([...(account || []), ...(device || [])]);

export const toggle = (list, symbol) => {
  const s = clean(symbol);
  return list.includes(s) ? list.filter(x => x !== s) : normalize([...list, s]);
};

// Pétrole (WTI, Brent) et gaz : les news en parlent sous ces noms.
const NEWS_NAMES = { CL: 'Pétrole', BZ: 'Pétrole', NG: 'Gaz' };

// Une news touche la watchlist si son impact cite un actif suivi, ou si elle parle d'un projet suivi.
export function touches(item, list, projectSymbol = () => null) {
  const names = new Set(list.flatMap(s => [s, NEWS_NAMES[s]].filter(Boolean)));
  return (item.impacts || []).some(([asset]) => names.has(asset)) || list.includes(projectSymbol(item.projectId));
}

// Liste observable : chaque changement est enregistré sur l'appareil et signalé aux abonnés avec son origine
// (« user » : un clic sur une étoile ; « account » : la liste vient du compte).
export function createWatchlist(storage) {
  const read = () => {
    try {
      const raw = storage?.getItem(KEY);
      return raw === null || raw === undefined ? [...DEFAULT] : normalize(JSON.parse(raw));
    } catch { return [...DEFAULT]; }
  };
  let list = read();
  const subs = new Set();
  const set = (next, source = 'user') => {
    const value = normalize(next);
    const changed = value.join() !== list.join();
    list = value;
    try { storage?.setItem(KEY, JSON.stringify(list)); } catch { /* stockage indisponible */ }
    if (changed) for (const fn of subs) fn(list, source);
    return changed;
  };
  return {
    get: () => [...list],
    has: s => list.includes(clean(s)),
    set,
    toggle: s => set(toggle(list, s)),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

// Le stockage du navigateur peut être bloqué (navigation privée) : la watchlist marche alors pour la visite en cours.
const browserStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
export const watchlist = createWatchlist(browserStorage());

// Étoile pour suivre un actif. `text` : version avec libellé (fiches projet et setup). Les étoiles de toute la page
// sont mises à jour ensemble par js/app.js quand la watchlist change.
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>';
export function star(symbol, { text = false } = {}) {
  const s = clean(symbol);
  if (!valid(s)) return '';
  const on = watchlist.has(s);
  return `<button type="button" class="star${text ? ' wide' : ''}" data-sym="${s}" aria-pressed="${on}" title="${starTitle(s, on)}" aria-label="Suivre ${s}">${STAR}${text ? '<span class="off">Suivre</span><span class="on">Dans ma watchlist</span>' : ''}</button>`;
}
export const starTitle = (s, on) => (on ? `Retirer ${s} de ma watchlist` : `Ajouter ${s} à ma watchlist`);
