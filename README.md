# Royal Canin — Bac à Croquettes Connecté (Site vitrine)

Site vitrine d'une page (one-page) présentant la **nouveauté Royal Canin** : le
**bac à croquettes connecté 40 L**, avec balance intégrée, application mobile et
**commande automatique des croquettes chaque mois dès la zone critique**.

> Projet de démonstration. Royal Canin® est une marque déposée de ses
> propriétaires respectifs — ce site n'est pas affilié officiellement.

---

## 🎯 Le concept

Un bac de stockage de croquettes connecté qui :

1. **Pèse** le stock en continu grâce à une balance intégrée ;
2. **Détecte la zone critique** quand le niveau devient bas ;
3. **Commande automatiquement** les croquettes du mois via l'application — sans
   action de l'utilisateur (validation / modification / pause possibles depuis
   le téléphone).

**Prix affiché : 170 €**

---

## 🗂️ Structure du projet

```
.
├── index.html            # Page unique (toutes les sections)
├── css/
│   └── style.css         # Charte graphique Royal Canin (rouge & blanc)
├── js/
│   └── main.js           # Panier, notifications, formulaire, animations
└── assets/
    └── img/
        ├── bac-connecte.png   # Visuel produit (hero + section achat)
        └── bac-original.png   # Photo du bac de base (référence)
```

---

## 🧩 Sections de la page

| Section | Ancre | Contenu |
|--------|-------|---------|
| Navigation | — | Logo couronne + wordmark, liens, panier |
| Hero | `#produit` | « Nouveauté Royal Canin », titre, visuel produit, CTA 170 € |
| Bandeau | — | 4 arguments clés (rouge) |
| Caractéristiques | `#features` | 6 cartes (balance, app, commande auto, Wi-Fi, hermétique, 40 L) |
| Comment ça marche | `#etapes` | 3 étapes : remplir → peser → être alerté |
| Commande automatique | — | Section dédiée + mockup de l'application |
| Commander | `#commander` | Fiche produit + ajout au panier (170 €) |
| Fiche technique | — | Tableau des spécifications |
| Contact | `#contact` | Formulaire (nom, e-mail, message) |
| Footer | — | Marque + mentions |

---

## 🎨 Charte graphique

- **Rouge Royal Canin** : `#E2001A` (hover `#B5001A`)
- **Fond** : blanc `#FFFFFF` / gris doux `#F6F6F4`
- **Texte** : encre `#1A1A1A`
- **Police** : [Montserrat](https://fonts.google.com/specimen/Montserrat) (géométrique, proche de la typo de la marque)
- **Logo** : couronne recréée en SVG + wordmark « ROYAL CANIN »

Les couleurs sont centralisées dans des variables CSS (`:root`) en haut de
`css/style.css` — facile à modifier.

---

## ⚙️ Fonctionnalités JavaScript (`js/main.js`)

- **Panier** : ajout, suppression, total, compteur, ouverture/fermeture du
  panneau latéral.
- **Notifications** : toast de confirmation (« ajouté au panier », etc.).
- **Formulaire de contact** : envoi simulé avec message de confirmation.
- **Animations au scroll** : apparition progressive des sections
  (`IntersectionObserver`).
- **Format des prix** : affichage français (`170,00 €`).

> ⚠️ Le panier et le formulaire sont **front-end uniquement** (aucun paiement ni
> back-end réel) — il s'agit d'un site vitrine.

---

## 🚀 Lancer le site en local

Aucune dépendance, aucun build. Deux options :

**Option 1 — ouvrir directement**
Ouvrez `index.html` dans votre navigateur (double-clic).

**Option 2 — petit serveur local** (recommandé pour les images/polices)

```bash
# Python 3
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

---

## 📱 Responsive

Le site s'adapte aux mobiles et tablettes (breakpoints à 980 px et 620 px) :
grilles qui passent en une colonne, menu simplifié, panier en plein écran.

---

## ✏️ Personnalisation rapide

| Pour changer… | Où |
|---------------|-----|
| Le prix | `index.html` (hero + section « Commander »), `170` |
| Les couleurs | `css/style.css`, variables `:root` |
| Le visuel produit | remplacer `assets/img/bac-connecte.png` |
| Les caractéristiques | section `#features` dans `index.html` |
| Le texte de la commande auto | section `.autoorder` dans `index.html` |

---

## 🌿 Branche

Développement et déploiement sur la branche : `claude/sweet-ramanujan-kNRqe`
