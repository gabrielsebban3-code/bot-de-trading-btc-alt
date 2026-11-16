# Protocole de l'étude 4 : comparaison de sept méthodes en 15m et 1H

Rédigé le 2026-11-16 et validé par Gabriel (« Go ») avant tout calcul. Grille figée dans `config/etude4.yaml`.

## 1. Question

Parmi sept méthodes à règles fixes, laquelle est rentable sur les perpétuels Binance USDT-M après frais,
slippage et funding ? « Aucune » est un résultat valide.

## 2. Données et découpe

- Les 20 paires de `config/pairs.json`, bougies 15m et funding de 2020-01 à 2026-10 (déjà contrôlés).
  Le 1H est reconstruit à partir du 15m.
- Entraînement 2020-01-01 → 2024-01-31 (60 %), validation 2024-02-01 → 2025-05-31 (20 %),
  test final 2025-06-01 → 2026-10-31 (20 %), verrouillé par le code.

## 3. Règles communes

- Signal à la clôture d'une bougie, entrée au marché à l'ouverture de la suivante.
- Stop à 1,5 × ATR(14) ; objectif à 1,5 R ou 2,5 R (R = distance au stop).
- Stop et objectif touchés dans la même bougie 15m : le stop l'emporte.
- Frais 0,05 % par côté (objectif compris), slippage 0,02 % à l'entrée et sur le stop, funding réel.
- Risque 1 % du capital par trade, une position par paire.
- Signaux opposés sur la même bougie : aucun des deux n'est pris.

Décisions prises sur les quatre points laissés ouverts (propositions du plan, acceptées par le « Go ») :
5 positions simultanées au plus et levier 5 au plus par position ; signal ignoré si le stop est à moins de
0,3 % du prix ; comparaison au buy & hold par le rapport rendement / drawdown maximal face à un panier égal des
paires ; timeframes 15m et 1H uniquement, comme écrit dans la mission (le 4H n'est pas ajouté).

## 4. Méthodes (achat ; la vente est le miroir)

1. **SMC**. (a) Une bougie passe sous le plus bas des N bougies précédentes et clôture au-dessus.
   (b) Dans les 5 bougies suivantes, une bougie haussière crée un FVG (le bas de la bougie d'après est au-dessus
   du haut de la bougie d'avant) ; l'order block est la dernière bougie baissière parmi les 10 qui la précèdent.
   (c) Dans les 10 bougies qui suivent le FVG, une bougie revient dans le FVG, clôture haussière au-dessus du
   milieu du FVG ; le setup est annulé dès qu'une bougie clôture sous le bas de l'order block. N = 20 ou 50.
2. **Breakout Donchian**. Clôture au-dessus du plus haut des N bougies précédentes, volume > 1,5 × la moyenne
   des 20 précédentes. N = 20 ou 55.
3. **Suivi de tendance**. Clôture > EMA 200 et EMA 20 > EMA 50 ; la bougie touche l'EMA de repli (plus bas
   dessous) et clôture au-dessus, haussière ; premier signal d'une série seulement. EMA de repli = 20 ou 50.
4. **Mean reversion**. ADX(14) < 20, clôture sous la bande basse de Bollinger(20, 2), RSI(14) sous le seuil.
   Seuil 30 (vente : 70) ou 25 (vente : 75).
5. **Retour au VWAP**. VWAP de la journée UTC et son écart-type pondéré par le volume. La bougie précédente
   clôture sous VWAP − k écarts-types, la bougie courante reclôture au-dessus. Pas de signal sur une bougie
   ouverte avant 02:00 UTC. k = 2 ou 2,5.
6. **Funding extrême**. z-score du dernier funding sur les 90 règlements précédents. z ≤ −seuil : achat ;
   z ≥ +seuil : vente. Bougie de signal = première bougie ouverte après le règlement. Seuil 2 ou 3.
7. **Momentum**. Une bougie a un volume ≥ V × la moyenne des 20 précédentes. Parmi les 3 bougies suivantes,
   la première qui clôture au-dessus de son plus haut déclenche l'achat (sous son plus bas : la vente).
   V = 2 ou 3.
8. **Baseline**. Pour chaque variante, 1 000 simulations : même nombre de trades, mêmes paires, mêmes stop et
   objectif, dates et sens tirés au hasard.

Chaque méthode : timeframe {15m, 1H} × son paramètre {2 valeurs} × objectif {1,5 R ; 2,5 R} = 8 variantes.
Total : **56 variantes**.

## 5. Sélection

1. Les 56 variantes sur l'entraînement. Par méthode, on garde la variante à la meilleure espérance parmi celles
   qui ont au moins 200 trades (sinon la méthode est « insuffisante »).
2. La variante gardée est évaluée telle quelle sur la validation.
3. Walk-forward sur entraînement + validation, 5 fenêtres de 8 mois : la variante est choisie sur tout ce qui
   précède la fenêtre, puis mesurée sur la fenêtre. Résultat rapporté, sans seuil propre.
4. Critères, tous obligatoires, sur la validation :
   au moins 200 trades ; espérance > 0,15 R ; profit factor > 1,3 ; drawdown < 25 % ; au moins 60 % des paires
   (≥ 10 trades) positives ; Monte Carlo (10 000 tirages des trades avec remise) : au moins 95 % positifs ;
   espérance au-dessus du 95e centile de la baseline ; rendement / drawdown supérieur à celui du buy & hold.
5. Stabilité ±20 %, calculée seulement pour les méthodes qui remplissent tous les critères du point 4 :
   chaque paramètre chiffré (paramètre de la méthode, multiple du stop, objectif) est décalé de −20 % et +20 %,
   un par un ; les 6 variantes décalées doivent garder une espérance > 0 sur entraînement + validation.
6. Les méthodes qui remplissent tout vont au test final, 3 au plus (meilleures espérances de validation).
   Si aucune : verdict « aucune », le test n'est pas ouvert.
7. Test final : une seule exécution. Une méthode est retenue si elle remplit aussi les critères du point 4
   sur le test.

## 6. Réserves écrites avant le calcul

- 133 configurations ont déjà été essayées sur ces paires et ces années (études 1 à 3), dont des versions des
  méthodes 1, 2, 3, 4 et 6. En 15m et 1H elles étaient négatives ou trop faibles. Attente : « aucune ».
- La période 2025-2026 a été ouverte une fois pour une configuration en 4h. Aucune méthode 15m ou 1H n'y a été
  évaluée, mais le test n'est pas totalement vierge.
- Les paires sont choisies sur leur volume de 2026 (biais de survie).
- Le scanner n'est construit que si une méthode est retenue.
