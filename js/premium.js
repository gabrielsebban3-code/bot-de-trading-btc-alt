// Formules Gratuit et Premium. Le statut Premium vient de Supabase (table premium, remplie à la main par l'admin
// tant que le paiement en ligne n'existe pas) : js/account.js le lit à la connexion et appelle setPremium.
// Le bridage est visuel : les fichiers data/*.json restent publics, comme pour l'historique réservé aux membres.
const DAY = 86_400_000;
const BAR = 4 * 3600_000;

export const PRICE = '9,90 €'; // prix affiché sur la page Premium, par mois
export const FREE_LIVE = ['BTC', 'ETH']; // paires en direct pour tout le monde
export const DELAY = DAY; // retard des autres paires sans Premium
export const HISTORY_DAYS = { free: 90, premium: 365 };
export const ALERTS = { free: 3, premium: 20 };

let premium = false;
const subs = new Set();

export const isPremium = () => premium;
export const onTier = fn => subs.add(fn);
export function setPremium(on) {
  on = Boolean(on);
  document.body.classList.toggle('premium', on);
  if (on === premium) return;
  premium = on;
  subs.forEach(fn => fn(on));
}

// Un signal compte à la clôture de sa bougie 4h. Sans Premium, SOL et le pétrole n'apparaissent que 24 h après.
export const delayed = (s, now = Date.now()) => !premium && !FREE_LIVE.includes(s.symbol) && now - (s.time + BAR) < DELAY;
export const visibleIn = (s, now = Date.now()) => Math.max(0, s.time + BAR + DELAY - now);
export const historyDays = () => (premium ? HISTORY_DAYS.premium : HISTORY_DAYS.free);
// Trade trop ancien pour la formule gratuite (fiche et historique limités à 3 mois).
export const tooOld = (s, now = Date.now()) => !premium && s.time < now - HISTORY_DAYS.free * DAY;
export const alertLimit = () => (premium ? ALERTS.premium : ALERTS.free);

export const hoursText = ms => {
  const h = Math.max(1, Math.ceil(ms / 3600_000));
  return `${h} heure${h > 1 ? 's' : ''}`;
};

// Encadré « Passer Premium » : même style que les encadrés réservés aux membres.
export const premiumBox = (text, cls = '') => `<div class="box join prem ${cls}"><p class="txt"><span class="ptag">Premium</span> ${text}</p>
  <div class="links"><a class="buy" href="#premium">Voir Premium</a></div></div>`;
