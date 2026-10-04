// Connexion aux comptes (Supabase). L'adresse du projet et la clé publique (« publishable » ou « anon ») sont faites
// pour être dans le site : ce sont les règles de supabase/schema.sql qui protègent les données de chaque compte.
// Tant qu'elles sont vides, le site marche sans connexion et la watchlist reste sur l'appareil.
export const SUPABASE = {
  url: 'https://dqfaduyfrehzipsfrwpc.supabase.co',
  key: 'sb_publishable_FVd3kyS16INilqWkWpYunA_-SDzdu8f',
  // Bouton « Continuer avec Google » : à activer une fois Google branché dans Supabase (Authentication → Providers).
  google: false,
  // Code à 6 chiffres dans l'e-mail de connexion : à activer une fois {{ .Token }} ajouté aux modèles d'e-mail de Supabase
  // (Authentication → Emails, possible seulement avec un SMTP perso). Sinon l'e-mail ne contient que le lien.
  code: false,
};

// Liens partenaires (affiliation) des plateformes : colle ici le lien de parrainage donné par chaque plateforme.
// Une plateforme sans lien n'est pas affichée ; sans aucun lien, l'encadré « Plateformes partenaires » est caché.
export const PARTNERS = {
  okx: '',
  bitget: '',
  binance: '',
};
