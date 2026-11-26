// Liens d'invitation Premium : https://…/#premium/CODE. La personne ouvre le lien, se connecte, et devient Premium
// toute seule (fonction redeem_premium_invite dans supabase/schema.sql). Ici, seulement les règles sans Supabase.
export const INVITE_KEY = 'dinexo-invite'; // code gardé le temps de se connecter (Google ou e-mail recharge la page)
export const INVITE_MS = 7 * 86_400_000; // une invitation ouverte puis oubliée ne s'active plus au-delà d'une semaine

const CODE = /^[A-Z0-9]{8,32}$/;
export const cleanCode = c => (typeof c === 'string' && CODE.test(c.trim().toUpperCase()) ? c.trim().toUpperCase() : null);

// Code de l'invitation dans l'ancre (#premium/CODE), sinon null.
export function inviteFromHash(hash) {
  const [page, code] = String(hash || '').replace(/^#/, '').split('/');
  return page === 'premium' ? cleanCode(decodeURIComponent(code || '')) : null;
}

export const inviteLink = (base, code) => `${base.split('#')[0].split('?')[0]}#premium/${code}`;

// Invitation gardée sur cet appareil : { code, at } encore valable, sinon null.
export function storedInvite(raw, now = Date.now()) {
  try {
    const p = JSON.parse(raw);
    const code = cleanCode(p?.code);
    return code && now - p.at < INVITE_MS ? code : null;
  } catch { return null; }
}

const DATE = { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' };
export const dayText = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', DATE);

// Message après activation, ou raison du refus.
export function redeemText(res) {
  if (res?.ok) {
    const until = res.until ? `jusqu'au ${dayText(res.until)}` : 'sans date de fin';
    return res.again ? `Cette invitation est déjà activée sur ton compte : Premium ${until}.` : `Bienvenue dans Premium ! Il est actif ${until}.`;
  }
  return {
    login: 'Connecte-toi pour activer ton invitation.',
    expired: 'Ce lien d\'invitation a expiré. Demande un nouveau lien à la personne qui te l\'a envoyé.',
    full: 'Toutes les places de ce lien d\'invitation sont déjà prises.',
    invalid: 'Ce lien d\'invitation ne marche pas (il a été arrêté, ou il est mal copié).',
  }[res?.reason] || 'L\'invitation n\'a pas pu être activée pour le moment. Rouvre le lien un peu plus tard.';
}

// Durées proposées à l'admin, en jours de Premium ('' = sans fin).
export const DURATIONS = [['7', '7 jours'], ['30', '1 mois'], ['90', '3 mois'], ['365', '1 an'], ['', 'Sans fin']];
export const durationText = days => (days ? (DURATIONS.find(([d]) => Number(d) === days)?.[1] || `${days} jours`) : 'sans fin');

// État d'un lien pour la liste de l'admin.
export function inviteState(inv, today = new Date().toISOString().slice(0, 10)) {
  if (!inv.active) return 'arrêté';
  if (inv.expires && inv.expires < today) return 'expiré';
  if (inv.uses >= inv.max_uses) return 'complet';
  return 'actif';
}
