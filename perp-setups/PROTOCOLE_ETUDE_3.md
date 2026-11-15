# Protocole de l'étude 3 : entrées de tendance avec objectif fixe court

Rédigé le 2026-11-15, **avant** tout calcul de l'étude 3. Grille figée dans `config/etude3.yaml`.

## 1. Question posée

Gabriel ne veut pas d'une méthode qui perd deux fois sur trois (étude 1 : environ 35 % de gagnants avec un stop
suiveur). Question : **en gardant les mêmes entrées de tendance mais avec un objectif fixe court (1 R ou 1,5 R),
obtient-on un taux de réussite plus élevé tout en remplissant les 9 critères ?**

## 2. Ce qui est testé (32 configurations, grille fermée)

- **Famille F — repli en tendance, objectif fixe** : entrée identique à la famille B (EMA50/EMA200, repli sur
  l'EMA20, RSI repassé au-delà du seuil). Stop 1,5 × ATR ou dernier pivot. Sortie : objectif fixe ou stop.
  Grille : timeframe {1h, 4h} × RSI {40/60, 45/55} × stop {ATR, pivot} × objectif {1 R, 1,5 R} = 16.
- **Famille G — cassure Donchian, objectif fixe** : entrée identique à la famille C. Stop 2 × ATR.
  Sortie : objectif fixe ou stop (plus de stop suiveur).
  Grille : timeframe {1h, 4h} × N {20, 55} × filtre volume {off, on} × objectif {1 R, 1,5 R} = 16.

Tout le reste est celui de l'étude 1, lu dans `config/config.yaml` sans modification : 20 paires, périodes,
frais, slippage, funding, risque 1 % par trade, 5 positions au plus, moteur, baseline aléatoire.

## 3. Sélection et critères (inchangés)

Grille entière sur DEV (2020-2022) ; passe DEV si ≥ 100 trades, espérance > 0, PF > 1 ; test de plateau ;
évaluation telle quelle sur VAL (2023-2024) ; une configuration gardée par famille (meilleure espérance VAL) ;
les 9 critères de la mission, mêmes seuils. Le taux de réussite est rapporté mais n'est pas un critère.

## 4. Jeu TEST

Non lu. Si une configuration remplit les 9 critères sur VAL : arrêt, et Gabriel décide s'il utilise le test
final (unique) pour elle. Sinon : « Aucun setup validé » pour cette étude.

## 5. Réserves écrites avant le calcul

- Ces entrées ont déjà été vues sur DEV et VAL dans l'étude 1 : l'étude 3 n'est pas indépendante.
  Total des configurations essayées sur ces données après l'étude 3 : 132.
- Dans l'étude 1, les variantes « objectif 2 R » de la famille B étaient à peine positives sur VAL
  (+0,04 à +0,09 R) et tout le 1h était négatif. Mon attente avant calcul : un taux de réussite plus élevé,
  mais une espérance trop faible pour passer les critères.
- Les résultats de l'étude 3 sont écrits dans `results_etude3/` et `TRIALS_etude3.csv` ; ceux de l'étude 1
  ne sont pas modifiés.
