# Étude 2 : test final de la cassure 4h — résultat

Protocole : `PROTOCOLE_ETUDE_2.md` (enregistré avant le calcul). Configuration : `config/etude2.yaml`. Fichiers : `results_etude2/`, `TRIALS_etude2.csv`.

## Verdict : REJETÉ

La configuration `C_tf4h_dc55_volon` (risque 0,5 % par trade) remplit **7 critères sur 9** sur le jeu TEST, ouvert une seule fois le 2026-11-15. Elle échoue aux critères 3 et 5. **Aucun setup validé, scanner non construit.**

## Résultats côte à côte (nets de frais, slippage et funding)

| Jeu | Trades | % gagnants | E[R] net | IC 95 % | PF | DD max | Rendement (info) | Série de pertes max | Centile baseline |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| DEV 2020-2022 | 455 | 39,6 % | +0,223 R | [+0,069 ; +0,386] | 1,50 | 9,8 % | +60,2 % | 13 | 98,6 |
| VAL 2023-2024 | 545 | 35,4 % | +0,189 R | [+0,025 ; +0,377] | 1,40 | 18,2 % | +57,0 % | 16 | 99,6 |
| **TEST 2025-01 → 2026-10** | 550 | 35,8 % | +0,108 R | [-0,039 ; +0,259] | 1,21 | 16,4 % | +28,0 % | 15 | 83,9 |

## Les 9 critères sur TEST

| # | Critère | Valeur | Résultat |
|---|---|---|:-:|
| 1 | ≥ 100 trades | 550 trades | ✅ |
| 2 | Espérance ≥ +0,10 R et PF ≥ 1,15 | +0,108 R, PF 1,21 | ✅ |
| 3 | Borne basse de l'IC 95 % > 0 | -0,039 R | ❌ |
| 4 | Espérance > 0 avec coûts ×2 | +0,063 R | ✅ |
| 5 | Au-dessus du 95e centile de la baseline aléatoire | +0,108 R pour un seuil de +0,164 R (83,9e centile) | ❌ |
| 6 | Espérance > 0 sans la meilleure paire | +0,081 R sans 1000PEPEUSDT | ✅ |
| 7 | ≥ 60 % des paires (≥ 10 trades) positives | 61,1 % de 18 paires | ✅ |
| 8 | Drawdown ≤ 25 % | 16,4 % | ✅ |
| 9 | Au plus 1 trimestre sur 3 sous −0,3 R | 12,5 % des 8 trimestres | ✅ |

## Détail TEST

- Par trimestre : 2025-T1 -0,054 R (56) ; 2025-T2 +0,084 R (62) ; 2025-T3 +0,360 R (84) ; 2025-T4 +0,246 R (59) ; 2026-T1 +0,101 R (76) ; 2026-T2 +0,270 R (84) ; 2026-T3 -0,094 R (103) ; 2026-T4 -0,308 R (26).
- Par direction : long +0,140 R (291 trades) ; short +0,073 R (259 trades).
- Par sortie : stop -1,037 R (152) ; time +0,228 R (4) ; trail +0,549 R (394).
- Paires positives (≥ 10 trades) : ZECUSDT (+0,939 R, 13), 1000PEPEUSDT (+0,653 R, 26), ARBUSDT (+0,588 R, 24), ETHUSDT (+0,365 R, 42), UNIUSDT (+0,287 R, 19), TRUMPUSDT (+0,237 R, 18), SOLUSDT (+0,203 R, 25), LINKUSDT (+0,141 R, 27), DOGEUSDT (+0,137 R, 38), ADAUSDT (+0,094 R, 48), TAOUSDT (+0,035 R, 16).
- Paires négatives (≥ 10 trades) : XRPUSDT (-0,045 R, 33), AVAXUSDT (-0,052 R, 37), BTCUSDT (-0,070 R, 58), QNTUSDT (-0,075 R, 25), BNBUSDT (-0,309 R, 56), SUIUSDT (-0,326 R, 13), NEARUSDT (-0,418 R, 16).
- Coûts : 1579 USDT pour 4381 USDT de PnL brut (36 % du brut). Avec coûts doublés : +0,063 R.
- Baseline aléatoire (mêmes paires, mêmes sorties, entrées au hasard) : médiane +0,041 R, 95e centile +0,164 R.

## Lecture honnête

- Le résultat sur données neuves est positif (+0,108 R par trade, drawdown 16,4 %) mais il a baissé par rapport à VAL (+0,189 R), comme le protocole l'annonçait (biais du gagnant).
- L'intervalle de confiance contient zéro : on ne peut pas exclure que l'espérance réelle soit nulle ou négative.
- Des entrées tirées au hasard, avec les mêmes stops et la même sortie, font aussi bien ou mieux dans 16 % des simulations. Une partie du gain vient donc de la sortie par stop suiveur dans un marché qui a eu des tendances, pas du signal d'entrée.
- Les deux derniers trimestres (2026-T3 et 2026-T4) sont négatifs.
- Selon les règles fixées à l'avance, ce setup est REJETÉ. Il ne doit pas être qualifié de validé, et aucun scanner n'est construit.
- Le jeu TEST est maintenant consommé : tout nouveau test sur 2025-2026 serait biaisé. Les seules données encore neuves sont celles du futur.

## Contrôles

- `results_etude2/run_log.txt` : DEV et VAL lancés avec `final_test_unlocked=False` ; une seule ligne « FINAL TEST ».
- Le verrou n'a été ouvert que dans `config/etude2.yaml` ; `config/config.yaml` reste à `false`.
- La commande refuse toute relance du TEST tant que `results_etude2/summary_test.csv` existe.
- Qualité des données 2025-2026 : aucun trou, aucune paire exclue (`results_etude2/data_quality.md`).
