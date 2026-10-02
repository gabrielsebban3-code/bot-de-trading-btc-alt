// Connexion aux comptes (Supabase). L'adresse du projet et la clé publique (« publishable » ou « anon ») sont faites
// pour être dans le site : ce sont les règles de supabase/schema.sql qui protègent les données de chaque compte.
// Tant qu'elles sont vides, le site marche sans connexion et la watchlist reste sur l'appareil.
export const SUPABASE = {
  url: 'https://dqfaduyfrehzipsfrwpc.supabase.co',
  key: 'sb_publishable_FVd3kyS16INilqWkWpYunA_-SDzdu8f',
  // Bouton « Continuer avec Google » : à activer une fois Google branché dans Supabase (Authentication → Providers).
  google: false,
};
