# Protocole de l'étude 5 : un modèle qui note les signaux du momentum 1H

Rédigé le 2026-11-16 avant tout calcul. Gabriel a accepté l'usage de scikit-learn et la construction d'un bot
d'alertes sur une méthode non validée, étiquetée comme telle. Paramètres figés dans `config/etude5.yaml`.

## 1. Question

Un modèle réentraîné chaque mois sur les trades passés sait-il distinguer les bons signaux du momentum 1H des
mauvais, sur des données qu'il n'a pas vues ? « Non » est un résultat valide.

## 2. Signaux candidats

Tous les signaux de la méthode 7 de l'étude 4 en 1H, avec un pic de volume ≥ 2 × la moyenne, stop à 1,5 × ATR,
objectif à 2,5 R (`M7_tf1h_v2_tp2p5`). Chaque candidat est simulé seul (mêmes coûts que l'étude 4) pour connaître
son résultat net en R. Étiquette : 1 si le résultat est positif, 0 sinon.

## 3. Ce que le modèle voit (connu à la clôture de la bougie de signal)

Rapport du volume à sa moyenne ; taille du corps et dépassement de la bougie de pic, en ATR ; ATR en % du prix ;
ADX ; RSI dans le sens du trade ; écart à l'EMA 200 et pente EMA 20 / EMA 50 dans le sens du trade ; tendance 4h
dans le sens du trade ; rendement de la paire sur 24 h et 7 jours dans le sens du trade ; position dans le range
des 20 dernières bougies ; dernier funding et son z-score dans le sens du trade ; rendement du BTC sur 24 h dans
le sens du trade et volatilité du BTC ; heure et jour de la semaine.

## 4. Modèle et réapprentissage

- Arbres boostés peu profonds (`HistGradientBoostingClassifier`, profondeur 3, 200 arbres, feuilles ≥ 200 trades).
- Réentraîné le 1er de chaque mois sur tous les candidats dont le trade est **déjà clôturé** à cette date.
  Premier modèle quand 12 mois d'historique existent. Les notes d'un mois viennent du modèle entraîné au début
  de ce mois : toutes les notes sont hors échantillon.
- Un signal est gardé si sa note dépasse un quantile des notes hors échantillon des 6 mois précédents.
  Trois variantes : garder les 60 %, 40 % ou 20 % les mieux notés. Premier jour de trading : 2021-08-01.

## 5. Évaluation

Les signaux gardés passent dans le moteur de l'étude 4 (frais, slippage, funding, 1 % de risque, 5 positions).

1. Entraînement (2021-08-01 → 2024-01-31) : on garde la variante à la meilleure espérance (≥ 200 trades).
2. Validation (2024-02-01 → 2025-05-31), telle quelle. Trois questions :
   - **(a) Le modèle apporte-t-il quelque chose ?** Oui si l'espérance des signaux gardés dépasse celle du momentum
     sans modèle (`M7_tf1h_v3_tp2p5`, +0,137 R sur la validation) **et** dépasse le 95e centile de 1 000 sous-ensembles
     de candidats tirés au hasard, de même taille.
   - **(b) La méthode filtrée remplit-elle les 8 critères de l'étude 4 ?**
   - Les trois variantes sont toutes rapportées.
3. Test final (2025-06-01 → 2026-10-31), une seule fois, seulement si (a) et (b) sont vrais.

## 6. Conséquences pour le bot

- (a) faux : la partie apprentissage n'est pas construite. Le bot, si Gabriel le veut toujours, envoie les signaux
  du momentum 1H sans modèle, étiquetés « non validé ».
- (a) vrai, (b) faux : le bot note les signaux avec le modèle, étiqueté « non validé ».
- (a) et (b) vrais et test final réussi : méthode retenue.
Dans tous les cas : alertes seulement, aucun ordre.

## 7. Réserves écrites avant le calcul

- 189 variantes déjà testées sur ces données ; le momentum 1H a été choisi parce qu'il était le meilleur.
- Le modèle utilise les mêmes bougies que les méthodes déjà testées. Attente : amélioration faible ou nulle.
- Un modèle trouve toujours des régularités dans le passé ; seule la validation hors échantillon compte.
