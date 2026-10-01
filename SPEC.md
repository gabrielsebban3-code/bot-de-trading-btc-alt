# Monexo — cahier des charges

Dashboard web public pour trader crypto et matières premières :

1. **Projets** : trouver des petits projets crypto qui génèrent de vrais revenus et grandissent.
2. **Setups** : détecter des setups de trading en 4h sur OKX.
3. **Actu** : être prévenu de l'actualité qui fait bouger les marchés.

Maquette de référence : [`mockup/index.html`](mockup/index.html).

> Monexo est un outil d'information. **Ceci n'est pas un conseil financier.**

---

## 1. Profil et contraintes

| Sujet | Décision |
|---|---|
| Niveau | Trader avancé |
| Marchés | Crypto + matières premières (pétrole, gaz) |
| Plateforme de trading | OKX |
| Levier | Faible (≤ 3x), pour information |
| Budget | < 20 €/mois au total |
| Hébergement | Page web en ligne (GitHub Pages), données mises à jour par GitHub Actions |
| Langue | Français, heure de Paris |
| IA | Pas maintenant. Le code doit permettre de la brancher plus tard (~3-5 €/mois) |

## 2. Utilisateurs et comptes

- Site **public et gratuit**. Pas de version payante prévue.
- Un visiteur **voit tout sans compte** (projets, setups, actu, historique).
- Le compte sert à garder sa **watchlist** sur tous ses appareils.
- Connexion : **Google** ou **e-mail avec lien magique** (pas de mot de passe). Prévu avec Supabase (offre gratuite).
- **Admin** (le propriétaire) : voit le nombre et la liste des inscrits.
- Avertissement « Ceci n'est pas un conseil financier » sur l'accueil, Projets, Setups, chaque fiche, et en pied de page.
- ⚠️ À faire vérifier : publier des signaux de trading au public en France peut relever de la réglementation AMF.

## 3. Onglet Projets

**Objectif :** petits projets qui font du chiffre et ont du potentiel de croissance.

| Critère | Décision |
|---|---|
| Market cap | < 1 Md$, pas de minimum |
| Blockchains / secteurs | Toutes / tous |
| Listing | **Pas encore sur Binance** (spot). Binance Alpha accepté avec un badge. Coinbase/Upbit n'excluent pas |
| Classement | Top 25, recalculé à chaque mise à jour des données |
| Score /100 | 50 % revenus du protocole · 30 % croissance (revenus + TVL sur 30 j) · 20 % valorisation (market cap ÷ revenu annualisé) |
| Badges | **Buyback** (le protocole reverse des revenus aux détenteurs), **Accélère**, **Faible flottant** (< 30 % en circulation), **Binance Alpha**, **Sur OKX**, **Tendance** (CoinGecko) |
| Fiche détaillée | Revenus 90 j, détail du score, TVL, investisseurs (VCs), flottant, buyback, où acheter (OKX ou DEX), liens |
| Alertes | Nouveau projet dans le top, buyback détecté → Discord (plus tard) |

**Sources :**
- DefiLlama : revenus, revenus reversés aux détenteurs, TVL, levées de fonds.
- CoinGecko : market cap, offre en circulation, tendances.
- Binance : liste des tokens listés.
- OKX : liste des tokens disponibles.

**Limites connues :**
- La croissance du nombre d'utilisateurs n'est pas disponible gratuitement. On utilise la croissance des revenus et du TVL.
- Les unlocks de tokens ne sont pas disponibles gratuitement. Ils ne sont donc pas affichés.
- La détection « sur Binance » compare les tickers. Un projet qui porte le même ticker qu'un token Binance est exclu à tort (rare).
- Seul le **spot** Binance est vérifié : les serveurs de GitHub sont aux États-Unis, où l'API futures de Binance est bloquée.

## 4. Onglet Setups (à venir)

| Sujet | Décision |
|---|---|
| Données | OKX |
| Marchés | Top 50 crypto + pétrole / gaz |
| Unité de temps | 4h. Tendance 1D affichée à titre d'info, sans filtrer |
| Détecteurs | Indépendants et simples (une cassure = juste une cassure). Départ avec 5 : **Breakout + volume, Liquidity sweep, FVG, Funding/OI extrême, Niveaux** (veille/semaine, chiffres ronds, volume) |
| Détecteurs ensuite | Order block, BOS/CHoCH, RSI/divergences, EMA, cascades de liquidations — ajoutés seulement si l'historique montre qu'ils fonctionnent |
| Statut | « En cours » (bougie ouverte) puis « Confirmé » (bougie clôturée) |
| Contenu d'un signal | **Pourquoi ce signal** (très important), entrée, stop-loss ATR, TP partiels (TP1/TP2/TP3), R:R, taux de réussite du détecteur, lien vers un projet du top ou une news liée |
| Filtre | R:R minimum 1:2 |
| Durée d'affichage | 24 h |
| Historique | Taux de réussite par détecteur (gagné = TP1 touché avant le SL), stocké côté serveur |
| Discord | Watchlist seulement, 3 signaux max par jour (plus tard) |

## 5. Onglet Actu (à venir)

| Sujet | Décision |
|---|---|
| Thèmes | Conflits / sanctions, banques centrales (Fed, BCE, taux, CPI), OPEP / pétrole / or, régulation crypto, hacks / exploits, flux ETF, baleines, annonces des projets du top |
| Sources | Agences de presse, sources officielles (Fed, BCE, OPEP, SEC…), médias crypto, canaux Telegram de news macro rapides (à la place de X, trop cher) |
| Toujours critique | Guerre / frappe militaire, décision de taux surprise, changement de production OPEP, hack > 50 M$ |
| Affichage | Titre traduit en français (traduction gratuite), pastille d'importance (rouge / orange / gris), impact probable (▲▼ par actif), « pourquoi ça compte », regroupement des doublons |
| Analyse | Règles par mots-clés au départ. IA plus tard pour des résumés de qualité |
| Baleines | > 10 M$, tokens des projets du top, dépôts sur exchange et wallets connus |
| Bandeau | Bandeau rouge en haut du site quand une news critique tombe |
| Discord | Importance moyenne et critique, 24h/24 (plus tard) |

## 6. Organisation des pages

```
En-tête (partout) : logo · onglets · bandeau critique · ticker de la watchlist
├── Résumé (accueil)
│   ├── Indicateurs : dominance BTC, Fear & Greed, pétrole
│   ├── « À regarder maintenant » : 3-4 éléments prioritaires
│   └── 3 colonnes : Projets | Setups | Actu
├── Projets → Fiche projet
├── Setups → Fiche setup
├── Actu
└── Plus
    ├── Historique
    └── Mon compte (watchlist, admin)
Pied de page : avertissement « pas un conseil financier »
```

- Chaque page commence par un encadré « À savoir » qui explique ce qu'on voit (masquable).
- Les onglets sont reliés : un setup sur un projet du top l'indique, une news qui touche un actif apparaît sur ses setups.
- Mobile : barre d'onglets en bas de l'écran, tableaux défilants horizontalement.

## 7. Style

- Inspiré des DEX (Hyperliquid, Uniswap, Jupiter) : fond sombre ardoise, panneaux arrondis, bordures fines, onglets en pilules.
- Accent **orange**. Hausse **verte**, baisse **rouge**.
- Police Geist. Chiffres en Geist Mono.
- Pas d'emojis ni de logos de cryptos. Importance des news en pastilles de couleur.
- Animations discrètes.
- Messages Discord épurés : seulement l'essentiel, bordure verte (long) ou rouge (short).

## 8. Architecture technique

```
GitHub Actions (toutes les heures)
  └── scripts/build-data.mjs  → récupère les API, calcule scores et badges
        └── data/projects.json, data/market.json
GitHub Pages
  └── index.html + css/ + js/ → lit les fichiers JSON
```

- Les données sont récupérées **une fois pour tout le monde** par GitHub Actions. Le nombre de visiteurs ne change rien aux coûts ni aux limites des API.
- Si une source tombe, le site garde la dernière version publiée.
- Supabase (plus tard) : comptes, watchlists, historique des signaux.

## 9. Ordre de réalisation

1. ✅ Cahier des charges + maquette
2. ✅ Onglet Projets
3. Onglet Setups
4. Onglet Actu
5. Comptes (Supabase)
6. IA + alertes Discord
