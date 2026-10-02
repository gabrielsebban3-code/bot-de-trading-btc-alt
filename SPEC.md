# Dinexo — cahier des charges

Dashboard web public pour trader crypto et matières premières :

1. **Projets** : trouver des petits projets crypto qui génèrent de vrais revenus et grandissent.
2. **Setups** : détecter des setups de trading en 4h sur OKX.
3. **Actu** : être prévenu de l'actualité qui fait bouger les marchés.

Maquette de référence : [`mockup/index.html`](mockup/index.html).

> Dinexo est un outil d'information. **Ceci n'est pas un conseil financier.**

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

## 4. Onglet Setups

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

**Fonctionnement (v1) :**

| Sujet | Règle |
|---|---|
| Marchés | Top 50 CoinGecko disponible en perpétuel USDT sur OKX (stablecoins exclus) + WTI (`CL`), Brent (`BZ`), gaz naturel (`NG`). Si CoinGecko ne répond pas : les 50 plus gros volumes OKX |
| Breakout + volume | Clôture au-dessus du plus haut (ou sous le plus bas) des 20 dernières bougies, volume ≥ 1,8× la moyenne 20 bougies |
| Liquidity sweep | Mèche sous un plus bas (semaine dernière, veille ou 20 bougies) puis clôture au-dessus, dans la moitié haute de la bougie. Inverse pour un short |
| FVG | Premier retour du prix dans un gap de 3 bougies (≥ 0,3 ATR) de moins de 30 bougies, clôture qui tient le gap |
| Funding/OI extrême | Funding ≥ 0,04 %/8 h (ou ≤ −0,04 %) et open interest +10 % en 24 h → signal contraire |
| Niveaux | Rebond (ou rejet) sur le plus haut/bas de la veille ou de la semaine dernière, un chiffre rond ou le niveau le plus échangé sur 30 jours |
| Stop | 1,5 ATR(14) |
| Objectifs | Juste avant les niveaux suivants (sommets/creux, veille, semaine, chiffres ronds, volume). Sinon 2R, 3R, 4,5R |
| Filtre R:R | Si le premier niveau gênant est à moins de 2R, le signal est écarté |
| Anti-doublon | Un même détecteur ne redonne pas le même signal sur un actif pendant 24 h |
| Résultat | TP1 avant le stop = gagné. Stop et TP1 dans la même bougie = perdu. Rien après 5 jours = expiré (non gagné) |
| Historique | Recalculé à chaque mise à jour sur 90 jours de bougies 4h. L'open interest OKX ne remonte qu'à ~16 jours : l'historique Funding/OI se construit au fil des mises à jour (fichier `setups.json` déjà en ligne) |

## 5. Onglet Actu

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

**Fonctionnement (v1) :**

| Sujet | Règle |
|---|---|
| Sources | Flux officiels Fed, BCE et SEC · Google News, une recherche par thème sur 24 h (Reuters, AP, Bloomberg, CNBC…) · BBC, Al Jazeera, CNBC, FXStreet, OilPrice · CoinDesk, Cointelegraph, The Block, Decrypt, DL News, Blockworks · pages publiques Telegram : Watcher.Guru, Wu Blockchain, Whale Alert |
| Fréquence | Toutes les 15 minutes. Une news reste 72 h dans le fil |
| Classement | Règles par mots-clés sur le titre : thème, importance, impact probable par actif et « pourquoi ça compte ». Un titre hors des thèmes suivis est écarté |
| Critique | Attaque ou frappe dans une zone clé (Iran, Golfe, Hormuz, Taïwan…), nouvelle guerre, détroit fermé · décision de taux surprise d'une grande banque centrale · décision ferme de l'OPEP+ de changer sa production · hack crypto > 50 M$ |
| Moyenne | Décision de taux (Fed, BCE, BoE, BoJ) · chiffre d'inflation ou d'emploi américain · droits de douane annoncés ou levés · sanctions pétrolières · menace d'escalade ou tensions militaires sans attaque · attaque d'installations pétrolières · flux ETF > 500 M$, approbation ou refus d'ETF · plainte, loi ou interdiction sur les cryptos · hack > 5 M$ · baleine > 100 M$ · news sur un projet du top 25 |
| Faible | Le reste des thèmes suivis : frappes dans les conflits déjà en cours (Ukraine, Gaza…), discours, stocks de pétrole, prix de l'or… Sans flèche d'impact |
| Confirmation | Une news critique venue d'un seul petit média reste « moyenne » tant qu'une agence, une source officielle ou un deuxième média ne l'a pas confirmée |
| Impact probable | Guerre : pétrole ▲ or ▲ BTC ▼ · baisse de taux de la Fed : BTC ▲ or ▲ (hausse : BTC ▼) · inflation ou emploi américains plus forts que prévu : BTC ▼ (plus faibles : ▲) · moins de production OPEP+ : pétrole ▲ · hack : token touché ou DeFi ▼ · entrées dans les ETF : ▲ · dépôt d'une baleine sur un exchange : ▼, retrait : ▲, création de stablecoins : crypto ▲ |
| Doublons | Même jour, mêmes mots importants et mêmes acteurs (la Fed n'est pas la BCE) = une seule ligne avec le nombre de sources. Le titre affiché vient de la source la plus fiable |
| Traduction | Google Traduction (accès gratuit), sinon MyMemory. Un titre pas encore traduit s'affiche en anglais avec la mention EN et repasse à la traduction suivante |
| Baleines | Whale Alert, transferts > 10 M$, plus les achats et ventes des gros détenteurs connus (Strategy, gouvernements, fondations). Dans « Tout », seuls ceux > 100 M$ ou sur un token du top 25 apparaissent ; les autres sont dans le filtre Baleines |
| Bandeau | Dernière news critique des 6 dernières heures, en rouge en haut de toutes les pages, refermable |
| Liens | Un setup affiche la news importante des dernières 24 h sur son actif (pétrole pour WTI/Brent, BTC pour tout le marché crypto) et dit si elle va dans son sens. Une fiche projet affiche ses news |

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
GitHub Actions (toutes les heures ; l'actu toutes les 15 minutes)
  └── scripts/build-data.mjs  → récupère les API, calcule scores et badges
        └── data/projects.json, data/market.json
  └── scripts/build-setups.mjs → bougies 4h OKX, détecteurs, bilan
        └── data/setups.json
  └── scripts/build-news.mjs  → flux d'actu, classement, doublons, traduction
        └── data/news.json
GitHub Pages
  └── index.html + css/ + js/ → lit les fichiers JSON
```

- Les données sont récupérées **une fois pour tout le monde** par GitHub Actions. Le nombre de visiteurs ne change rien aux coûts ni aux limites des API.
- Si une source tombe, le site garde la dernière version publiée de la partie concernée, sans bloquer les autres.
- Supabase (plus tard) : comptes, watchlists.

## 9. Ordre de réalisation

1. ✅ Cahier des charges + maquette
2. ✅ Onglet Projets
3. ✅ Onglet Setups + Historique
4. ✅ Onglet Actu
5. Comptes (Supabase)
6. IA + alertes Discord
