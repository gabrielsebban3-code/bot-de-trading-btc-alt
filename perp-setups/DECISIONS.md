# Journal des décisions non spécifiées

Chaque ligne : date, point, option choisie, raison. Règle appliquée (section 14 de la mission) :
(1) le plus conservateur pour les résultats, (2) le plus simple à coder et à vérifier, (3) le plus standard.
Toutes ces décisions ont été prises et codées **avant** le premier backtest complet (DEV sur les 20 paires).

## Données et réseau

| # | Date | Point | Décision | Raison |
|---|---|---|---|---|
| D1 | 2026-11-15 | `fapi.binance.com` répond HTTP 451 (restriction géographique du serveur cloud) | `exchangeInfo` fourni par Gabriel : réponse JSON complète de `fapi/v1/exchangeInfo` collée dans la conversation, enregistrée telle quelle dans `data/raw/exchangeInfo.json` (946 contrats, `serverTime` = 2026-11-13 06:02 UTC) ; tout le reste vient de `data.binance.vision` | La mission impose de s'arrêter et de demander les fichiers plutôt que de contourner |
| D2 | 2026-11-15 | Mois en cours impossible à compléter par l'API ; archive funding de novembre 2026 inexistante | Fin des données = **2026-10-31 23:45 UTC** (dernier mois complet où klines ET funding existent en archive) | Sans funding réel on ne peut pas simuler ; aucune donnée inventée |
| D3 | 2026-11-15 | Volume 90 jours pour le classement des paires | Klines 1d des archives `data.binance.vision` (mensuelles août-octobre 2026 + journalières 1er-14 novembre), fenêtre 2026-08-17 → 2026-11-14 | Même donnée officielle que l'API klines 1d, seule source accessible |
| D4 | 2026-11-15 | Transparence | En vérifiant le format CSV j'ai vu l'en-tête et 2 bougies BTC d'octobre 2026 (jeu TEST). Aucun calcul, aucun résultat | Signalé par honnêteté ; sans effet sur les règles |
| D5 | 2026-11-15 | Exclusions de la liste de paires | Stablecoins = liste explicite dans `config.yaml` ; indices = `underlyingType != COIN`, base finissant par `DOM`, `DEFI`, `ALL` ; seuls `contractType = PERPETUAL`, `status = TRADING`, cotés et margés en USDT | Application littérale de la section 3.2 |
| D6 | 2026-11-15 | Paire sans assez de bougies 1d sur la fenêtre de 90 jours (< 90 %) | Non classée | Impossible de mesurer son volume moyen |
| D7 | 2026-11-15 | Chauffe pour les paires listées avant 2020 | Même règle pour toutes : aucun signal pendant les **30 premiers jours** de l'historique chargé | Simple, et l'EMA200 4h a besoin de 33 jours d'historique |
| D8 | 2026-11-15 | Bougies 1h et 4h | Reconstruites à partir du 15m (alignées sur l'heure UTC) ; une bougie supérieure n'existe que si **toutes** ses bougies 15m existent | Un seul jeu de données, pas de bougie partielle |
| D9 | 2026-11-15 | Trous de données | Jamais comblés (quelle que soit leur taille). Aucun signal pendant 30 jours après un trou (indicateurs considérés comme redémarrés). Un trade ou un ordre limite qui rencontre un trou est annulé : pas de ligne de trade, la place reste occupée jusqu'au trou | Lecture conservatrice de « signaux et trades touchant un trou sont ignorés » |
| D10 | 2026-11-15 | Contrôle qualité avant ouverture du TEST | Calculé sur DEV+VAL uniquement ; la période TEST est contrôlée après le déverrouillage | Ne lire aucune ligne du TEST avant l'arrêt obligatoire |
| D11 | 2026-11-15 | Seuil « mouvement > 30 % » | Bougie listée si \|close/open − 1\| > 30 % **ou** amplitude high/low − 1 > 30 % | Les mèches aberrantes comptent aussi |

## Indicateurs

| # | Date | Point | Décision | Raison |
|---|---|---|---|---|
| I1 | 2026-11-15 | EMA | Initialisée par la moyenne simple des `période` premières valeurs, alpha = 2/(période+1) ; NaN avant | Standard |
| I2 | 2026-11-15 | ATR, RSI, ADX | Lissage de Wilder ; première valeur = moyenne simple des 14 premières entrées (ATR à l'indice 14, ADX à l'indice 27) | Définition d'origine de Wilder |
| I3 | 2026-11-15 | Bollinger | Moyenne simple 20, écart-type de population (ddof = 0) | Définition de Bollinger |
| I4 | 2026-11-15 | Donchian, moyenne de volume | Fenêtre des N bougies **précédentes**, bougie courante exclue | Texte de la mission (« N dernières bougies », « 20 bougies précédentes ») |
| I5 | 2026-11-15 | Aucun signal si un indicateur requis vaut NaN | Signal ignoré | Conservateur |

## Famille A (SMC)

| # | Date | Point | Décision | Raison |
|---|---|---|---|---|
| A1 | 2026-11-15 | Pivots éligibles à la bougie t | Pivots situés dans [t−50, t−1] et confirmés (indice + n ≤ t) | Règle anti-biais 2 |
| A2 | 2026-11-15 | Groupe d'equal highs/lows | Le niveau = pivot le plus extrême ; membres = pivots dont le niveau est à moins de 0,15 % (écart rapporté au plus haut des deux niveaux) | Texte de la mission |
| A3 | 2026-11-15 | Niveau déjà traversé | Le niveau doit être **intact** : aucune bougie postérieure à un pivot membre n'a dépassé le niveau avant la bougie de sweep. Un niveau n'est donc balayé qu'une fois | Un sweep prend une liquidité encore présente ; sans cela un même niveau produirait plusieurs « sweeps ». Interprétation, pas un filtre ajouté après coup |
| A4 | 2026-11-15 | Plusieurs niveaux balayés par la même bougie | Un seul sweep par bougie : le niveau valide le plus extrême | Déterministe et simple |
| A5 | 2026-11-15 | Pivot de référence du MSS | Dernier pivot opposé confirmé **au moment du sweep** (figé) ; il ne doit pas déjà être cassé à la clôture du sweep | Simple ; une « cassure » suppose un niveau non cassé |
| A6 | 2026-11-15 | Bougie de cassure | **Première** clôture au-delà du pivot dans les 10 bougies suivant le sweep (la bougie de sweep exclue). Variante `deplacement` : cette bougie doit avoir un corps ≥ 1,5 × ATR (ATR de cette même bougie, close) dans le sens de la cassure, sinon le setup est abandonné | Lecture littérale de « la bougie de cassure » |
| A7 | 2026-11-15 | Stop touché entre le sweep et la création de l'ordre | Setup abandonné | Cohérent avec « annulé si le prix touche le stop avant l'entrée » |
| A8 | 2026-11-15 | ATR de la marge du stop | ATR de la bougie de sweep : stop = extrême du sweep ± 0,1 × ATR | Le stop est connu dès le sweep |
| A9 | 2026-11-15 | FVG | Le gap dont la bougie centrale est la bougie de cassure ; ordre créé à la clôture de la bougie suivante (le gap n'est connu qu'à ce moment). Pas de gap = pas de setup | « créé par la bougie de déplacement » |
| A10 | 2026-11-15 | Order block | Dernière bougie de couleur opposée avant la bougie de cassure, sans limite de recul ; ordre créé à la clôture de la bougie de cassure | Lecture littérale |
| A11 | 2026-11-15 | Ordre limite mal placé | Ignoré si le prix limite n'est pas du côté passif du marché à la création (vente au-dessus de la clôture, achat en dessous) ou n'est pas à l'intérieur du stop | Un ordre limite déjà traversé serait exécuté au marché : pas de remplissage fictif |
| A12 | 2026-11-15 | Validité | 10 bougies du timeframe du signal après la création | Texte de la mission |
| A13 | 2026-11-15 | Filtre 4h | Évalué à la création de l'ordre, sur la dernière bougie 4h **close** | Règle anti-biais 3 |

## Familles B, C, D, E

| # | Date | Point | Décision | Raison |
|---|---|---|---|---|
| B1 | 2026-11-15 | Repli | Long : le plus bas a touché ou traversé l'EMA20 sur l'une des 5 dernières bougies (courante incluse), la clôture courante est au-dessus de l'EMA20, RSI courant > seuil bas et RSI < seuil bas sur l'une des 5 bougies précédentes. Short symétrique | Précision d'un texte ambigu, fenêtre de 5 bougies reprise de la règle RSI |
| B2 | 2026-11-15 | Répétition du signal | Signal émis à la **première** bougie où toutes les conditions sont vraies (front montant) | Un repli = un signal |
| B3 | 2026-11-15 | Stop pivot | Niveau du dernier pivot (n = 3) confirmé à la bougie du signal ; signal ignoré si le pivot est du mauvais côté | Texte de la mission |
| C1 | 2026-11-15 | Cassure | Toute bougie clôturant au-delà du canal est un signal (pas de front montant) ; la limite d'une position par paire évite les doublons | Lecture littérale, standard Donchian |
| D1b | 2026-11-15 | Objectif de la famille D | Moyenne mobile 20 de la bougie du signal ; signal ignoré si l'ouverture suivante est déjà au-delà | « fixée à l'entrée » |
| D2b | 2026-11-15 | Sortie temporelle | Au marché à l'ouverture de la 25e bougie du timeframe (24 bougies détenues) ; durée max de E mesurée depuis l'entrée | Simple |
| E1 | 2026-11-15 | z-score du funding | (taux − moyenne des 90 règlements précédents) / écart-type d'échantillon (ddof = 1) de ces 90 règlements | Standard, sans le règlement courant |
| E2 | 2026-11-15 | Fenêtre de confirmation | Les bougies 1h ouvrant à partir du règlement et clôturant au plus tard 8 h après ; première confirmation seulement ; un seul signal par bougie et par direction | Texte de la mission |

## Moteur

| # | Date | Point | Décision | Raison |
|---|---|---|---|---|
| M1 | 2026-11-15 | Implémentation | Résolution 15m pour tout ; le parcours des bougies 15m est vectorisé par blocs (numpy), strictement équivalent à une boucle bougie par bougie | Performance sans changer une seule hypothèse |
| M2 | 2026-11-15 | Stop des ordres au marché | Niveau du stop = open brut ∓ k × ATR ; le prix d'entrée inclut le slippage ; R = \|prix d'entrée − stop\| ; l'objectif en R part du prix d'entrée | Le slippage dégrade réellement le trade (sinon il serait invisible) |
| M3 | 2026-11-15 | Objectif sur la bougie de remplissage d'un ordre limite | Non compté (ordre des événements inconnu) ; le stop, lui, compte | Conservateur |
| M4 | 2026-11-15 | Objectif dépassé par un gap | Exécuté au niveau de l'objectif, jamais mieux | Conservateur |
| M5 | 2026-11-15 | Ordre limite en attente | Occupe la place de la paire et une des 5 places du portefeuille jusqu'au remplissage ou à l'annulation | La marge est réservée ; déterministe |
| M6 | 2026-11-15 | Libération d'une place | Une place libérée pendant la bougie 15m j est disponible pour un ordre passé à partir de la clôture de j | Conservateur |
| M7 | 2026-11-15 | Capital courant | Capital initial + PnL des trades clôturés avant le passage de l'ordre (pas de valorisation des positions ouvertes) | Simple |
| M8 | 2026-11-15 | Liquidation | Marge isolée à 5× pour chaque position, marge de maintenance 1 % : liquidation à 19 % du prix d'entrée. Ne peut arriver que sur un gap au-delà ; perte = marge | Hypothèse la plus défavorable compatible avec « levier ≤ 5× » |
| M9 | 2026-11-15 | Funding | `notionnel d'entrée × taux` pour chaque règlement f tel que ouverture de la bougie d'entrée < f ≤ ouverture de la bougie de sortie (horodatages arrondis à la minute inférieure) | Mission : « notionnel × funding_rate » ; approximation signalée dans les limites |
| M10 | 2026-11-15 | Position encore ouverte à la fin d'un jeu | Fermée au marché à la clôture de la dernière bougie du jeu (frais taker + slippage), motif `time` | Ne pas supprimer de trades ; ne pas lire le jeu suivant |
| M11 | 2026-11-15 | Trailing chandelier | Mis à jour à chaque clôture d'une bougie du timeframe du signal : max(stop précédent, plus haut des bougies closes depuis l'entrée − 3 ATR). Motif `trail` si le stop a bougé, `stop` sinon | Indicateur du timeframe du signal, sans regarder la bougie en cours |
| M12 | 2026-11-15 | Colonne supplémentaire du CSV | `risk_pct_actual` ajoutée en dernière colonne | La mission demande d'enregistrer l'écart quand le levier plafonne la taille |
| M13 | 2026-11-15 | Colonne `slippage` | Coût informatif déjà contenu dans les prix d'entrée et de sortie : `pnl_usdt = taille × (sortie − entrée) × sens − frais − funding` | Éviter un double comptage |
| M14 | 2026-11-15 | Plafond de levier | Avec un stop minimal de 0,3 % et 1 % de risque, le levier maximal atteignable est 3,33× : le plafond 5× ne peut pas mordre (il est codé et testé quand même) | Constat arithmétique |

## Statistiques, sélection, verdict

| # | Date | Point | Décision | Raison |
|---|---|---|---|---|
| S1 | 2026-11-15 | Baseline aléatoire | Pour chaque configuration et chaque jeu : un réservoir de max(50 000, 10 × N) entrées aléatoires (plafonné à 300 000). Chaque entrée copie la paire, la distance de stop en ATR et, s'il y en a une, la distance d'objectif en ATR d'un trade réel tiré au hasard ; bougie d'entrée et direction aléatoires ; mêmes coûts, même sortie. Les 1000 simulations tirent N trades avec remise dans ce réservoir | Simuler 1000 × N trades un par un serait trop long ; le réservoir donne la même distribution |
| S2 | 2026-11-15 | Baseline et portefeuille | Les entrées aléatoires ne passent pas par la limite de 5 positions | L'espérance en R par trade ne dépend pas de la taille ni du nombre de positions |
| S3 | 2026-11-15 | Profit factor | Calculé sur les multiples de R | Cohérent avec l'espérance, insensible à la capitalisation |
| S4 | 2026-11-15 | Drawdown %, Sharpe, Calmar | Sur le capital réalisé (trades clôturés), rendements journaliers sur tous les jours calendaires, annualisation √365 | Simple ; marché ouvert 7 j/7 |
| S5 | 2026-11-15 | Trimestre d'un trade | Trimestre de la date d'entrée ; seuls les trimestres avec au moins un trade comptent pour le critère 9 | Simple |
| S6 | 2026-11-15 | Meilleure paire (critère 6) | Paire avec la plus grande somme de R | Standard |
| S7 | 2026-11-15 | Plateau | Voisine sans aucun trade = espérance non positive | Conservateur |
| S8 | 2026-11-15 | Évaluation sur VAL | Toutes les configurations qui passent DEV sont évaluées sur VAL ; le choix de la configuration de chaque famille se fait parmi celles qui passent aussi le plateau | Lecture littérale de la section 7 |
| S9 | 2026-11-15 | Configurations envoyées au TEST | Au plus une par famille : celle choisie sur VAL, et seulement si elle remplit les 9 critères sur VAL | « uniquement les configurations survivantes » |
| S10 | 2026-11-15 | Coûts ×2 | Backtest complet relancé avec frais et slippage doublés (pas un simple recalcul) | Le slippage change les prix d'entrée et donc R |
| S11 | 2026-11-15 | numba | Non utilisé (aucune étape ne dépasse 10 minutes) | Section 2 |
| S12 | 2026-11-15 | Code du rapport | Placé dans `src/run.py` (commande `report`) | Structure de dépôt imposée, pas de fichier supplémentaire |
