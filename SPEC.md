# Dinexo — cahier des charges

Dashboard web public pour trader crypto et matières premières :

1. **Projets** : trouver des petits projets crypto qui génèrent de vrais revenus et grandissent.
2. **Setups** : détecter des setups swing (2 à 5 jours) sur BTC, ETH, SOL et le pétrole Brent, via OKX.
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
- Connexion : **Google** ou **e-mail avec lien magique** (pas de mot de passe), avec Supabase (offre gratuite).
- **Admin** (le propriétaire) : voit le nombre et la liste des inscrits.

| Watchlist | Règle |
|---|---|
| Sans compte | Gardée sur l'appareil. Au départ : BTC, ETH, SOL |
| Ajout | Étoile sur chaque ligne de Projets, sur la fiche projet et sur la fiche setup, ou par symbole dans Mon compte. 50 actifs au plus |
| Filtre | « Ma watchlist » dans Projets, Setups et Actu (une news compte si son impact ou son projet touche un actif suivi ; pétrole pour WTI et Brent, gaz pour NG) |
| Ticker | Prix en direct OKX des 12 premiers actifs, qui défilent sous l'en-tête. Dernier prix des données si OKX ne répond pas |
| Première connexion sur un appareil | La liste du compte, plus ce qui a été ajouté sur l'appareil, puis enregistrée dans le compte |
| Ensuite | La liste du compte fait foi (elle a pu changer sur un autre appareil). Chaque clic sur une étoile est enregistré |
| Déconnexion | La watchlist reste sur l'appareil |
| Supprimer mon compte | Bouton dans Mon compte : efface le compte et sa watchlist enregistrée |
| Admin | Nombre d'inscrits, actifs les plus suivis, liste (adresse, date d'inscription, nombre d'actifs suivis). L'admin est désigné par son adresse dans la table `admins` |
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

Gabriel trade en **swing sur 2 à 3 jours** et veut **peu de signaux**. Révision du 2 octobre 2026 : la v1 (5 détecteurs 4h sur le top 50 crypto) perdait. Sur les 90 derniers jours, 75 % de stops touchés rien que sur BTC, ETH, SOL et le Brent, et encore plus sur les altcoins.

| Sujet | Décision |
|---|---|
| Données | OKX, perpétuels USDT |
| Marchés | **BTC, ETH, SOL et pétrole Brent (`BZ`) seulement** |
| Style | Swing de 2 à 5 jours, un seul trade à la fois par actif |
| Détecteur | **Cassure 20 jours** : clôture 4h au-dessus du plus haut des 20 derniers jours quand la tendance 1D est haussière (long), ou sous le plus bas quand elle est baissière (short) |
| Volume | Volume des 24 dernières heures au moins égal au volume journalier moyen des 20 jours précédents. Sinon la cassure est ignorée (ajouté le 2 octobre au soir : 48 % de gagnants et +0,30R sur 3,5 ans au lieu de 46 % et +0,23R ; sur 12 mois 57 % et +0,54R) |
| Tendance 1D | Haussière si clôture et EMA20 au-dessus de l'EMA50 journalière, baissière si les deux en dessous. Sert de **filtre** : pas de trade contre la tendance |
| Stop | 1 ATR(14) journalier |
| Objectifs | TP1 à 2R, TP2 à 3R, TP3 à 4R |
| Sortie | Ni stop ni TP1 au bout de 5 jours : on sort au prix du moment |
| Fréquence | Environ 1 signal par semaine sur les 4 paires (192 en 3,5 ans) |
| Statut | « En cours » (bougie 4h ouverte) puis « Confirmé » (bougie clôturée) |
| Affichage | Tant que le trade est en jeu, et au moins 24 h |
| Contenu d'un signal | Pourquoi ce signal, entrée, stop, TP1/TP2/TP3, R:R, bilan sur 12 mois, news liée |
| Historique | Recalculé à chaque mise à jour sur 12 mois de bougies 4h. Gagnant = TP1 touché avant le stop, ou sortie à 5 jours en gain |
| Discord | Watchlist seulement, 3 signaux max par jour (plus tard) |

**Backtest qui a servi au choix** (bougies OKX de mars 2023 à octobre 2026, frais de 0,12 % par trade inclus, stop prioritaire si stop et objectif tombent dans la même bougie) :

| Stratégie | Trades | Stops touchés | R moyen par trade |
|---|---|---|---|
| v1 : 5 détecteurs 4h, sans filtre | 447 | 68 % | −0,03R |
| v1, 90 derniers jours | 28 | 75 % | −0,33R |
| **Cassure 20 jours + tendance 1D** | 211 (1,2 par semaine) | 44 % | **+0,21R**, positif chaque année et sur chaque paire |

Testés et écartés : pullback sur l'EMA20 journalière (≈ 0R), sweep journalier (+0,05R, instable), v1 avec filtre de tendance (+0,16R mais 64 % de stops). La v1 avait trois défauts : des altcoins faibles, des signaux pris contre la tendance journalière et un stop à 1,5 ATR 4h, trop serré pour tenir plusieurs jours.

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
| Fréquence | Toutes les 15 minutes. Une news reste 72 h dans le fil (250 au plus : les faibles partent en premier) |
| Classement | Règles par mots-clés sur le titre : thème, importance, impact probable par actif et « pourquoi ça compte ». Un titre hors des thèmes suivis est écarté |
| Critique | Attaque ou frappe dans une zone clé (Iran, Golfe, Hormuz, Taïwan…) : seulement la première en 24 h, car dans une guerre déjà en cours les frappes suivantes sont attendues · nouvelle guerre, invasion, détroit fermé : toujours · décision de taux surprise d'une grande banque centrale · décision ferme de l'OPEP+ de changer sa production · hack crypto > 50 M$ |
| Moyenne | Décision de taux (Fed, BCE, BoE, BoJ) · chiffre d'inflation ou d'emploi américain publié · droits de douane annoncés ou levés par les États-Unis · sanctions pétrolières · nouvelle frappe dans une guerre déjà en cours en zone clé · menace d'escalade ou démonstration de force (exercices, déploiements) · cessez-le-feu ou détroit rouvert en zone clé · attaque d'installations pétrolières · flux ETF > 500 M$, approbation ou refus d'ETF · plainte, loi ou interdiction sur les cryptos (amende ou poursuite d'au moins 100 M$ quand un montant est cité) · hack > 5 M$, suite d'un gros hack · baleine > 100 M$ vers ou depuis un exchange (stablecoins > 500 M$), > 1 Md$ sans sens clair · news sur un projet du top 25 |
| Faible | Le reste des thèmes suivis : frappes dans les conflits hors zone clé (Ukraine, Gaza…), contexte d'une guerre, déclarations et menaces pendant une guerre déjà en cours, réactions (« condamne », « accuse ») et avis d'experts, discours, avant-premières (« avant le rapport sur l'emploi »), prévisions et analyses, commentaires de change (« NZD/USD… »), bilans du mois ou du trimestre, poursuite d'une seule société pour moins de 100 M$, droits de douane entre d'autres pays ou simplement réclamés, stocks de pétrole, prix de l'or… Sans flèche d'impact. L'onglet affiche par défaut les moyennes et critiques ; le filtre « Toutes » montre aussi les faibles |
| Confirmation | Une news critique venue d'un seul petit média reste « moyenne » tant qu'une agence, une source officielle ou un deuxième média ne l'a pas confirmée |
| Impact probable | Guerre : pétrole ▲ or ▲ BTC ▼ · détente (cessez-le-feu, détroit rouvert) : pétrole ▼ or ▼ · baisse de taux de la Fed : BTC ▲ or ▲ (hausse : BTC ▼) · inflation ou emploi américains plus forts que prévu : BTC ▼ (plus faibles : ▲) · moins de production OPEP+ : pétrole ▲ · hack : token touché ou DeFi ▼ · entrées dans les ETF : ▲ · dépôt d'une baleine sur un exchange : ▼, retrait : ▲, création de stablecoins : crypto ▲ |
| Doublons | Même jour, mêmes mots importants et mêmes acteurs (la Fed n'est pas la BCE), ou même chiffre publié (inscriptions au chômage, CPI…) ou même décision de taux = une seule ligne avec le nombre de sources. Le titre affiché est celui qui explique l'importance, puis celui de la source la plus fiable |
| Traduction | Google Traduction (accès gratuit), sinon MyMemory. Un titre pas encore traduit s'affiche en anglais avec la mention EN et repasse à la traduction suivante |
| Baleines | Whale Alert, transferts > 10 M$, plus les achats et ventes des gros détenteurs connus (Strategy, gouvernements, fondations). Dans « Tout », seuls ceux > 100 M$ vers ou depuis un exchange (> 500 M$ pour les stablecoins, dont les créations sont routinières), ceux > 1 Md$ sans sens clair (entre portefeuilles inconnus, interne à un exchange) ou sur un token du top 25 apparaissent ; les autres sont dans le filtre Baleines |
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
  └── scripts/build-setups.mjs → bougies 4h et 1D OKX (BTC, ETH, SOL, Brent), détecteur swing, bilan
        └── data/setups.json
  └── scripts/build-news.mjs  → flux d'actu, classement, doublons, traduction
        └── data/news.json
  └── scripts/send-alerts.mjs → Discord : nouveaux setups confirmés, news critiques
GitHub Pages
  └── index.html + css/ + js/ → lit les fichiers JSON
Supabase (offre gratuite, seulement si js/config.js est rempli)
  └── connexion (Google, lien par e-mail) ; tables profiles (adresse, watchlist) et admins
```

- Les données sont récupérées **une fois pour tout le monde** par GitHub Actions. Le nombre de visiteurs ne change rien aux coûts ni aux limites des API.
- Si une source tombe, le site garde la dernière version publiée de la partie concernée, sans bloquer les autres.
- Alertes Discord (secret `DISCORD_WEBHOOK_URL`) : à chaque mise à jour, ce qui vient d'apparaître par rapport à la version déjà en ligne, 5 messages au plus. Au premier passage avec le lien, un message de bienvenue confirme le branchement ; `data/alerts.json` retient qu'il est parti.
- Supabase : comptes et watchlists. Le schéma est dans [`supabase/schema.sql`](supabase/schema.sql), à coller une fois dans l'éditeur SQL (il peut être relancé). Chaque compte ne lit et ne modifie que sa ligne, et seulement sa watchlist (règles RLS et droits par colonne) ; l'admin lit toutes les lignes.
- `js/config.js` contient l'adresse du projet Supabase et sa clé publique (« publishable » ou « anon »). Cette clé est faite pour être visible dans le site : ce sont les règles RLS qui protègent les données. La clé secrète (« secret » ou « service_role ») ne va jamais dans le dépôt.
- Tant que `js/config.js` est vide, le site marche sans comptes : la watchlist reste sur l'appareil.
- La librairie supabase-js est chargée depuis jsDelivr à une version fixée, seulement quand les comptes sont branchés.

## 9. Ordre de réalisation

1. ✅ Cahier des charges + maquette
2. ✅ Onglet Projets
3. ✅ Onglet Setups + Historique
4. ✅ Onglet Actu
5. ✅ Comptes (Supabase)
6. ✅ Alertes Discord (nouveau setup confirmé, news critique) · IA à venir
