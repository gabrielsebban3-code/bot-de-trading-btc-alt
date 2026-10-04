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

Cadre fixé avec Gabriel le 2 octobre 2026 (questionnaire) : suivi de tendance sur BTC, ETH, SOL et le Brent, bougies 4h, **un signal ne compte que s'il va dans le sens de la tendance journalière**, un trade à la fois par paire, environ 2 signaux par mois, résultats en % du capital avec 1 % risqué par trade, **choix au gain total**. Gabriel a ensuite demandé de tester un maximum de combinaisons et de programmer la plus rentable sans lui demander de choisir.

| Sujet | Décision |
|---|---|
| Données | OKX, perpétuels USDT, bougies 4h (signaux) et journalières (tendance, stop, sortie) |
| Marchés | **BTC, ETH, SOL et pétrole Brent (`BZ`) seulement** |
| Indicateurs | 3, sur bougies 4h : **Cassure 20 jours** (clôture 4h au-delà du plus haut/bas des 20 dernières journées), **Cassure 10 jours** (clôture 4h au-delà du plus haut/bas des 60 bougies 4h précédentes), **MACD** (histogramme 12/26/9 en 4h qui repasse au-dessus/au-dessous de zéro). Il suffit qu'un des trois donne le signal |
| Tendance 1D | Haussière si clôture et EMA20 au-dessus de l'EMA50 journalière, baissière si les deux en dessous. **Long seulement en tendance haussière, short seulement en tendance baissière**, rien en tendance neutre |
| Marge | Le premier niveau devant le prix (pivots, veille, semaine dernière, niveau le plus échangé, chiffre rond) doit laisser au moins 2 × 1,5 ATR 4h de marge, sinon le signal est ignoré |
| Un trade à la fois | Tant qu'un trade est en jeu sur une paire, les autres signaux de cette paire sont ignorés |
| Stop de départ | 0,75 ATR(14) journalier |
| Moitié | À 5R, on prend la moitié et le stop remonte au prix d'entrée |
| Sortie du reste | Quand une journée clôture sous le plus bas des 7 jours précédents (au-dessus du plus haut pour un short). Pas d'objectif fixe ni de durée maximale |
| Résultats possibles | Stop touché (−1R = −1 % du capital) · moitié prise puis reste sorti à l'entrée (+2,5R) · sortie de tendance (R variable) |
| Affichage des gains | En % du capital avec 1 % risqué par trade (1R = 1 %) |
| Statut | « En cours » (bougie 4h ouverte) puis « Confirmé » |
| Affichage | Tant que le trade est en jeu, puis 24 h après sa sortie. La fiche montre le stop actuel et le niveau de sortie du reste dès qu'il est plus serré que le stop |
| Historique | Recalculé à chaque mise à jour sur 12 mois de bougies 4h, bilan par indicateur. Gagnant = trade fini en gain |
| Discord | Une alerte par nouveau signal confirmé, dans les 24 h |

**Comment la combinaison a été choisie** (bougies OKX de mars 2023 à octobre 2026, Brent coté depuis mars 2026, frais de 0,12 % inclus, stop prioritaire si stop et objectif tombent dans la même bougie) :

- 14 indicateurs candidats : les 4 du début testables (Breakout + volume, Liquidity sweep, FVG, Niveaux ; le funding n'a pas assez d'historique), cassures 10, 20 et 55 jours, cassure de 60 bougies 4h, pullback sur l'EMA20 journalière, RSI 4h, MACD 4h, croisement EMA20/50 4h, Supertrend 4h, sortie de squeeze Bollinger.
- Toutes les combinaisons de 1 à 3 indicateurs, croisées avec le stop (0,5 à 2 ATR journalier), la moitié (aucune, 2R à 8R), la sortie (plus bas de 5 à 30 jours) et avec ou sans filtre de marge : **environ 192 000 backtests**, plus 24 000 sur toutes les combinaisons des 9 premiers indicateurs, soit plus de 216 000 au total.
- Gardées : au plus 3 signaux par mois, chaque année en gain. Classées au gain total **sans les 3 meilleurs trades**, pour ne pas retenir une combinaison qui doit tout à un seul coup de chance (la meilleure au gain brut, +204 %, perdait 90 % de son gain sans son meilleur trade).
- Contrôle hors échantillon : les combinaisons choisies sur 2023-2024 seulement ont fait en médiane +17 % en 2025-2026, contre +6 % pour une combinaison au hasard. La méthode trouve donc quelque chose de réel, mais les résultats futurs seront probablement plus faibles que le backtest.

| Dans le sens de la tendance, un trade à la fois, 1 % risqué par trade | Trades | Gagnants | Gain total | Par année (2023 / 2024 / 2025 / 2026) | 12 derniers mois | Pire baisse |
|---|---|---|---|---|---|---|
| Les 5 indicateurs du début, stop 2 ATR journaliers, moitié à 2R, sortie 10 jours | 75 | 41 % | +31 % | +13 / +10 / −5 / +13 % | +13 % | |
| **Cassure 20 j + Cassure 10 j + MACD, stop 0,75 ATR j, moitié à 5R, sortie 7 jours (retenu)** | 102 (2,4 par mois) | 32 % | **+122 %** | +52 / +34 / +2 / +34 % | **+34 %** | −10 % |

Avec le stop serré, deux trades sur trois touchent leur stop (−1 % chacun) ; les gains viennent d'une trentaine de sorties de tendance qui rapportent en moyenne +5,6 %. Par paire : SOL +54 %, ETH +41 %, BTC +26 %, Brent +1 % (3 trades seulement). Un trade dure 12 jours en moyenne.

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
| Classement | Règles par mots-clés sur le titre : thème, importance, impact probable par actif et « pourquoi ça compte ». Un titre hors des thèmes suivis est écarté. Quand les règles changent, les news déjà dans le fil sont reclassées à la mise à jour suivante |
| Critique | Attaque ou frappe dans une zone clé (Iran, Golfe, Hormuz, Taïwan…) : seulement la première en 24 h, car dans une guerre déjà en cours les frappes suivantes sont attendues · nouvelle guerre, invasion, détroit fermé : toujours · décision de taux surprise d'une grande banque centrale · décision ferme de l'OPEP+ de changer sa production · hack crypto > 50 M$ |
| Moyenne | Décision de taux (Fed, BCE, BoE, BoJ) · chiffre d'inflation ou d'emploi américain publié · droits de douane annoncés ou levés par les États-Unis face à un grand partenaire (Chine, Europe, Canada, Mexique, Japon, ou tout le monde) · nouvelles sanctions pétrolières · nouvelle frappe dans une guerre déjà en cours en zone clé · menace d'escalade ou démonstration de force (exercices, déploiements, sans simple déclaration) · cessez-le-feu ou détroit rouvert en zone clé · attaque d'installations pétrolières · flux ETF > 500 M$, approbation ou refus d'ETF au comptant · plainte, loi ou interdiction sur les cryptos (amende ou poursuite d'au moins 100 M$ quand un montant est cité) · hack > 5 M$, ou piratage d'un grand exchange sans montant · baleine > 100 M$ vers ou depuis un exchange (stablecoins > 500 M$), > 1 Md$ sans sens clair · news sur un projet du top 25 |
| Faible | Le reste des thèmes suivis : frappes dans les conflits hors zone clé (Ukraine, Gaza…), contexte d'une guerre, déclarations et menaces pendant une guerre déjà en cours, réactions (« condamne », « accuse ») et avis d'experts, discours, avant-premières (« avant le rapport sur l'emploi »), prévisions et analyses, commentaires de change (« NZD/USD… »), bilans du mois ou du trimestre, poursuite d'une seule société pour moins de 100 M$, droits de douane entre d'autres pays, menacés, simplement réclamés ou avec un petit partenaire, suites d'un piratage (traque des fonds, auteur identifié, remboursement), compte de réseau social piraté, ETF à levier, procès d'une banque contre un régulateur, titres-questions et sondages, bilans de la semaine (« le pétrole file vers une baisse hebdomadaire »), notes de banques, chiffres d'un seul État américain, stocks de pétrole, prix de l'or… Sans flèche d'impact. L'onglet affiche par défaut les moyennes et critiques ; le filtre « Toutes » montre aussi les faibles |
| Écarté | Publi-rédactionnels et listes de « cryptos à surveiller » (Remittix, préventes…) |
| Confirmation | Une news critique venue d'un seul petit média reste « moyenne » tant qu'une agence, une source officielle ou un deuxième média ne l'a pas confirmée |
| Médias sérieux | Une news venue d'un seul média peu connu (blog, télé locale, site de communiqués) reste en faible importance tant qu'un média sérieux (agences, grands titres de la finance, presse crypto et pétrole reconnue, Watcher.Guru, Wu Blockchain) ou un deuxième média ne l'a pas reprise |
| Réaction du prix | Pour chaque news, mouvement de l'actif concerné dans l'heure qui suit (bougies 15 min d'OKX : BTC, ETH, SOL, Brent) ; en gras au-delà de 1 % (BTC, pétrole), 1,5 % (ETH) ou 2 % (SOL) |
| Rafraîchissement | La page relit l'actu toutes les 2 minutes et quand on revient sur l'onglet, sans recharger. Un minuteur externe gratuit peut lancer la mise à jour de l'actu toutes les 5 minutes (workflow_dispatch avec actu=true) |
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
  └── scripts/send-alerts.mjs → Discord : nouveaux setups confirmés, news critiques, résumé du matin
GitHub Pages
  └── index.html + css/ + js/ → lit les fichiers JSON
Supabase (offre gratuite, seulement si js/config.js est rempli)
  └── connexion (Google, lien par e-mail) ; tables profiles (adresse, watchlist) et admins
```

- Les données sont récupérées **une fois pour tout le monde** par GitHub Actions. Le nombre de visiteurs ne change rien aux coûts ni aux limites des API.
- Si une source tombe, le site garde la dernière version publiée de la partie concernée, sans bloquer les autres.
- Alertes Discord (secret `DISCORD_WEBHOOK_URL`) : à chaque mise à jour, ce qui vient d'apparaître par rapport à la version déjà en ligne, 5 messages au plus. Au premier passage avec le lien, un message de bienvenue confirme le branchement ; `data/alerts.json` retient qu'il est parti.
- Résumé du matin (`scripts/lib/digest.mjs`) : une fois par jour, au premier passage après 7 h (heure de Paris), un message avec les setups en cours, les 3 news du jour qui comptent (hors géopolitique, sans baleines) et la situation géopolitique : zones actives (Moyen-Orient, Russie et Ukraine, Chine et Taïwan, commerce mondial, OTAN), tension ou détente selon l'impact sur le pétrole et le BTC, effet probable cumulé et les titres marquants des dernières 24 h. Sans IA, par règles. `data/alerts.json` retient le jour envoyé.
- Agenda économique (`scripts/lib/agenda.mjs`) : les annonces à fort impact publiées par l'onglet Marché (`data/marche.json` → `agenda.events`, ForexFactory). Celles du jour vont dans le résumé du matin (« Agenda du jour », heure de Paris, prévu et précédent), et une alerte part 30 min avant chacune, une seule fois (`alerts.json.agendaSent`).
- Bilan du dimanche (`scripts/lib/weekly.mjs`) : le dimanche après 19 h (Paris), les trades terminés de la semaine en % du capital avec le total, les trades ouverts, les 5 news qui ont compté et les annonces de la semaine suivante. Le fil Actu ne garde que 72 h : chaque passage note les news moyennes et critiques dans `alerts.json.week` (7 jours).
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
