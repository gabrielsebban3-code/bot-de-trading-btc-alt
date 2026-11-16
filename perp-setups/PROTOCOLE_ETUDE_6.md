# Protocole de l'étude 6 : améliorer le momentum par trois leviers déjà observés

Rédigé le 2026-11-16 avant tout calcul, accepté par Gabriel (« oui vsy »). Grille figée dans `config/etude6.yaml`.

## 1. Question

Le momentum (pic de volume puis cassure de la bougie) remplit-il les critères de l'étude 4 si l'on change trois
choses dont l'effet a déjà été observé dans les études précédentes : le timeframe, la sortie, la force du pic ?

## 2. Grille (8 variantes, rien d'autre)

- Timeframe : 1H ou 4H.
- Sortie : objectif fixe à 2,5 R, ou stop suiveur chandelier à 3 × ATR (jamais reculé, pas d'objectif).
- Pic de volume : ≥ 3× ou ≥ 4× la moyenne des 20 bougies précédentes.

Le reste est celui de l'étude 4 : signal à la clôture, entrée au marché à l'ouverture suivante, stop initial à
1,5 × ATR, frais 0,05 % par côté, slippage 0,02 %, funding réel, 1 % de risque, 5 positions au plus, mêmes 20 paires.

## 3. Sélection et critères (identiques à l'étude 4)

1. Entraînement 2020-01-01 → 2024-01-31 : on garde la variante à la meilleure espérance (≥ 200 trades).
2. Validation 2024-02-01 → 2025-05-31, telle quelle : les 8 critères de l'étude 4.
3. Si tous sont remplis : stabilité ±20 % (seuil de volume, multiple du stop, objectif ou multiple du stop suiveur).
4. Si tout est rempli : test final 2025-06-01 → 2026-10-31, une seule fois. Retenue si les 8 critères y sont
   aussi remplis. Sinon : « aucune », le test n'est pas ouvert.
5. Walk-forward rapporté, sans seuil propre.

## 4. Réserves écrites avant le calcul

- 192 variantes déjà testées sur ces données. Les trois leviers ont été choisis parce qu'ils avaient aidé
  d'autres méthodes sur ces mêmes années : le choix n'est pas indépendant des données.
- La variante 1H, objectif fixe, volume ≥ 3× est celle de l'étude 4 (+0,137 R sur la validation, rejetée).
- La période 2025-06 → 2026-10 n'a jamais été lue pour le momentum ; une configuration de cassure 4h y a été
  testée une fois (étude 2). C'est le dernier test encore à peu près propre.

## 5. Avenant du 2026-11-16, écrit avant l'ouverture du test final

Résultat de la validation : `M7_tf4h_v4_exittp` remplit 7 critères sur 8 et rate le nombre de trades
(174 sur la validation pour 200 exigés). La mission d'origine demandait « au moins 200 trades sur la période »
sans préciser laquelle ; le protocole l'avait appliqué à la validation seule. Gabriel, informé que c'est une
relecture faite après avoir vu le résultat et qu'un verdict positif en vaut moins, a choisi d'ouvrir le test
final (réponse « b »).

Règles pour la suite, fixées avant de lire le test :

1. Le seuil de 200 trades se compte sur l'ensemble entraînement + validation + test.
2. Stabilité ±20 % calculée d'abord sur entraînement + validation ; si une variante décalée est négative,
   le test n'est pas ouvert.
3. Test final 2025-06-01 → 2026-10-31, une seule exécution, sur cette seule variante. Elle est retenue si les
   sept autres critères y sont remplis.
4. Le rapport mentionne cet avenant à côté du verdict, quel qu'il soit.
