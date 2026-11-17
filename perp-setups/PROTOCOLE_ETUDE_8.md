# Protocole de l'étude 8 : les bots du commerce (grid et DCA)

Rédigé le 2026-11-17 avant tout calcul et avant le téléchargement des bougies 1h. Paramètres figés dans
`config/etude8.yaml`. Gabriel a demandé de s'inspirer des bots existants : grid et DCA sont les deux familles
proposées par 3Commas, Pionex, Bitsgap, Cornix et la plupart des plateformes ; elles n'ont jamais été testées ici.

## 1. Règles (achat seulement, bougies 1h des perpétuels, chaque paire a une part fixe 1/20 du capital, sans levier)

**DCA** (« safety orders »)
- Départ quand on n'a pas de position et que le RSI(14) 1h clôture sous 30 : ordre de base au marché à
  l'ouverture suivante.
- 5 ordres de renfort limites, à −1, −2, −3, −4 et −5 fois le pas (2 % ou 3 %) sous le prix d'entrée, chacun 1,5 fois
  plus gros que le précédent. L'ordre de base vaut 1/20,8 de la part de la paire (la série complète utilise toute la part).
- Sortie de toute la position par ordre limite à +1,5 % ou +3 % au-dessus du prix moyen.
- Stop : aucun (réglage par défaut de la plupart des bots), ou à −25 % sous le prix d'entrée.
- Conventions prudentes : un renfort exécuté dans une bougie interdit la sortie dans la même bougie ; le stop passe
  avant l'objectif ; un stop dépassé en ouverture est exécuté à l'ouverture.

**GRID** (grille longue, remise à zéro chaque lundi 00:00 UTC)
- Le lundi : clôture de tout le stock au marché ; fourchette = plus bas et plus haut des 7 ou 14 derniers jours ;
  10 ou 20 niveaux en progression géométrique. Semaine sautée si l'écart entre niveaux est inférieur à 0,3 %.
- Un ordre d'achat sur chaque niveau sous le prix ; un achat exécuté place une vente au niveau supérieur ; une vente
  exécutée replace l'achat. Montant par niveau : part de la paire / nombre de niveaux.
- Une vente ne peut pas être exécutée dans la bougie de son achat. Si une bougie clôture 5 % sous la fourchette :
  tout est vendu à l'ouverture suivante et la grille reste arrêtée jusqu'au lundi suivant.

Coûts : ordres limites 0,02 %, ordres au marché et stops 0,05 % + slippage 0,02 %, funding réel payé sur le stock.

## 2. Évaluation (identique à l'étude 7)

Choix de la variante au meilleur Sharpe net sur les paires d'origine 2020-2023, puis évaluation telle quelle sur les
paires d'origine 2024-2026 et sur les 20 paires de l'étude 7 (rangs 21-40), 2020-2026. Mêmes critères : Sharpe ≥ 1,
intervalle de confiance du Sharpe > 0, drawdown < 25 %, positif avec coûts ×2, ≥ 60 % des trimestres positifs,
positif dans 2 régimes sur 3, Sharpe supérieur au buy & hold. Stabilité : pas du DCA ou nombre de niveaux ±20 %.

## 3. Réserves écrites avant le calcul

- 12 variantes ; environ 234 au total sur ces marchés. Les 20 nouvelles paires ont déjà servi une fois (étude 7,
  stratégies journalières), sans rapport avec ces règles.
- Ces deux familles sont surtout des façons d'être acheteur : elles risquent de suivre le marché (fortes pertes en
  2022) sans battre la détention en rendement ajusté du risque. Attente : rejet.
