# Étude 3 : entrées de tendance avec objectif fixe court — résultats

Protocole : `PROTOCOLE_ETUDE_3.md` (enregistré avant le calcul). Grille : `config/etude3.yaml`. Fichiers : `results_etude3/`, `TRIALS_etude3.csv`. Le jeu TEST n'a pas été lu.

## Résumé

- **32 configurations** testées sur DEV (2020-2022) ; **23** passent DEV, **22** passent aussi le plateau ; **23** évaluées sur VAL (2023-2024).
- **0 configuration ne remplit les 9 critères sur VAL. Aucun setup validé.**
- Le taux de réussite monte bien : 43,1 à 55,3 % en 4h sur VAL (environ 35 % avec le stop suiveur de l'étude 1).
- Mais l'espérance baisse : +0,016 à +0,082 R par trade en 4h sur VAL, sous le seuil de +0,10 R. Toutes les configurations échouent au critère 2.
- Tout le 1h est négatif sur VAL, comme dans l'étude 1.
- Avec l'étude 1, 132 configurations ont été essayées sur les mêmes données.

## Configuration gardée par famille (meilleure espérance VAL)

| Famille | Configuration | DEV : E[R] (trades, % gagnants) | VAL : E[R] (trades, % gagnants) | IC 95 % VAL | PF VAL | DD VAL | Critères ratés |
|---|---|---|---|---|---:|---:|---|
| F — repli en tendance, objectif fixe | `F_tf4h_rsi45-55_stoppivot_tp1p5` | +0,069 R (689, 44,6 %) | +0,068 R (741, 44,4 %) | [-0,022 ; +0,160] | 1,12 | 26,3 % | c2,c3,c7,c8 |
| G — cassure Donchian, objectif fixe | `G_tf4h_dc55_volon_tp1p5` | +0,217 R (607, 50,4 %) | +0,082 R (740, 44,6 %) | [-0,009 ; +0,174] | 1,14 | 29,3 % | c2,c3,c8 |

Critères : c2 = espérance ≥ +0,10 R et PF ≥ 1,15 ; c3 = borne basse de l'IC > 0 ; c4 = espérance > 0 avec coûts ×2 ; c5 = au-dessus du 95e centile de la baseline ; c6 = positif sans la meilleure paire ; c7 = ≥ 60 % des paires positives ; c8 = drawdown ≤ 25 %.

La plus proche de passer : `G_tf4h_dc55_volon_tp1p0` (cassure 55 bougies, filtre volume, objectif 1 R) : 894 trades, 55,3 % de gagnants, +0,076 R, IC [+0,010 ; +0,143], PF 1,16, drawdown 24,9 %. Elle échoue uniquement sur l'espérance minimale (c2).

## DEV (2020-2022), toute la grille

| Configuration | Trades | % gagnants | E[R] net | PF | DD max % | Passe DEV | Plateau |
|---|---:|---:|---:|---:|---:|:-:|:-:|
| `F_tf1h_rsi40-60_stopatr_tp1p0` | 2803 | 51,1 | -0,032 | 0,94 | 73,8 | non | non |
| `F_tf1h_rsi40-60_stopatr_tp1p5` | 2674 | 41,1 | -0,030 | 0,95 | 82,1 | non | non |
| `F_tf1h_rsi40-60_stoppivot_tp1p0` | 2196 | 52,2 | -0,005 | 0,99 | 53,1 | non | non |
| `F_tf1h_rsi40-60_stoppivot_tp1p5` | 1977 | 42,6 | +0,012 | 1,02 | 59,9 | oui | non |
| `F_tf1h_rsi45-55_stopatr_tp1p0` | 5325 | 50,3 | -0,047 | 0,91 | 96,1 | non | non |
| `F_tf1h_rsi45-55_stopatr_tp1p5` | 4682 | 40,6 | -0,043 | 0,93 | 95,5 | non | non |
| `F_tf1h_rsi45-55_stoppivot_tp1p0` | 4012 | 51,1 | -0,031 | 0,94 | 85,3 | non | non |
| `F_tf1h_rsi45-55_stoppivot_tp1p5` | 3367 | 42,0 | -0,008 | 0,99 | 72,2 | non | non |
| `F_tf4h_rsi40-60_stopatr_tp1p0` | 528 | 54,4 | +0,057 | 1,12 | 16,1 | oui | oui |
| `F_tf4h_rsi40-60_stopatr_tp1p5` | 515 | 46,4 | +0,128 | 1,23 | 17,8 | oui | oui |
| `F_tf4h_rsi40-60_stoppivot_tp1p0` | 319 | 54,5 | +0,057 | 1,12 | 15,7 | oui | oui |
| `F_tf4h_rsi40-60_stoppivot_tp1p5` | 311 | 46,6 | +0,124 | 1,22 | 14,5 | oui | oui |
| `F_tf4h_rsi45-55_stopatr_tp1p0` | 958 | 54,7 | +0,060 | 1,13 | 22,0 | oui | oui |
| `F_tf4h_rsi45-55_stopatr_tp1p5` | 862 | 45,2 | +0,092 | 1,16 | 25,3 | oui | oui |
| `F_tf4h_rsi45-55_stoppivot_tp1p0` | 721 | 54,0 | +0,041 | 1,09 | 19,0 | oui | oui |
| `F_tf4h_rsi45-55_stoppivot_tp1p5` | 689 | 44,6 | +0,069 | 1,12 | 19,7 | oui | oui |
| `G_tf1h_dc20_voloff_tp1p0` | 8263 | 51,4 | -0,012 | 0,98 | 93,5 | non | non |
| `G_tf1h_dc20_voloff_tp1p5` | 6082 | 41,8 | +0,001 | 1,00 | 83,1 | oui | oui |
| `G_tf1h_dc20_volon_tp1p0` | 7357 | 51,9 | -0,003 | 0,99 | 84,5 | non | non |
| `G_tf1h_dc20_volon_tp1p5` | 5666 | 42,3 | +0,013 | 1,02 | 73,3 | oui | oui |
| `G_tf1h_dc55_voloff_tp1p0` | 5693 | 52,6 | +0,012 | 1,02 | 67,2 | oui | oui |
| `G_tf1h_dc55_voloff_tp1p5` | 4499 | 43,2 | +0,035 | 1,06 | 64,7 | oui | oui |
| `G_tf1h_dc55_volon_tp1p0` | 5087 | 53,2 | +0,023 | 1,05 | 60,4 | oui | oui |
| `G_tf1h_dc55_volon_tp1p5` | 4128 | 43,8 | +0,050 | 1,08 | 62,2 | oui | oui |
| `G_tf4h_dc20_voloff_tp1p0` | 1389 | 56,5 | +0,099 | 1,22 | 31,4 | oui | oui |
| `G_tf4h_dc20_voloff_tp1p5` | 1102 | 46,6 | +0,129 | 1,23 | 28,3 | oui | oui |
| `G_tf4h_dc20_volon_tp1p0` | 1100 | 57,6 | +0,121 | 1,28 | 21,1 | oui | oui |
| `G_tf4h_dc20_volon_tp1p5` | 896 | 48,7 | +0,178 | 1,33 | 23,3 | oui | oui |
| `G_tf4h_dc55_voloff_tp1p0` | 880 | 56,7 | +0,100 | 1,22 | 19,4 | oui | oui |
| `G_tf4h_dc55_voloff_tp1p5` | 719 | 46,6 | +0,122 | 1,22 | 26,7 | oui | oui |
| `G_tf4h_dc55_volon_tp1p0` | 728 | 59,1 | +0,148 | 1,35 | 15,3 | oui | oui |
| `G_tf4h_dc55_volon_tp1p5` | 607 | 50,4 | +0,217 | 1,42 | 19,8 | oui | oui |

## VAL (2023-2024), configurations ayant passé DEV

| Configuration | Trades | % gagnants | E[R] net | IC 95 % | PF | DD max % | E[R] coûts ×2 | Critères ratés |
|---|---:|---:|---:|---|---:|---:|---:|---|
| `G_tf4h_dc55_volon_tp1p5` | 740 | 44,6 | +0,082 | [-0,009 ; +0,174] | 1,14 | 29,3 | +0,036 | c2,c3,c8 |
| `G_tf4h_dc55_volon_tp1p0` | 894 | 55,3 | +0,076 | [+0,010 ; +0,143] | 1,16 | 24,9 | +0,043 | c2 |
| `G_tf4h_dc20_volon_tp1p0` | 1279 | 55,0 | +0,071 | [+0,017 ; +0,128] | 1,15 | 31,1 | +0,033 | c2,c8 |
| `F_tf4h_rsi45-55_stoppivot_tp1p5` | 741 | 44,4 | +0,068 | [-0,022 ; +0,160] | 1,12 | 26,3 | +0,040 | c2,c3,c7,c8 |
| `G_tf4h_dc55_voloff_tp1p5` | 823 | 43,9 | +0,063 | [-0,021 ; +0,149] | 1,11 | 36,2 | +0,020 | c2,c3,c8 |
| `F_tf4h_rsi40-60_stopatr_tp1p5` | 652 | 43,7 | +0,059 | [-0,039 ; +0,155] | 1,10 | 34,2 | +0,005 | c2,c3,c8 |
| `F_tf4h_rsi40-60_stoppivot_tp1p0` | 496 | 54,4 | +0,055 | [-0,035 ; +0,144] | 1,12 | 22,1 | +0,016 | c2,c3,c7 |
| `G_tf4h_dc20_voloff_tp1p5` | 1124 | 43,6 | +0,055 | [-0,018 ; +0,129] | 1,09 | 46,6 | +0,037 | c2,c3,c8 |
| `G_tf4h_dc20_volon_tp1p5` | 988 | 43,5 | +0,055 | [-0,022 ; +0,133] | 1,09 | 31,8 | +0,007 | c2,c3,c8 |
| `G_tf4h_dc55_voloff_tp1p0` | 1031 | 54,0 | +0,052 | [-0,010 ; +0,113] | 1,11 | 32,0 | +0,020 | c2,c3,c8 |
| `F_tf4h_rsi40-60_stoppivot_tp1p5` | 443 | 43,1 | +0,042 | [-0,074 ; +0,159] | 1,07 | 25,6 | +0,016 | c2,c3,c5,c7,c8 |
| `F_tf4h_rsi45-55_stopatr_tp1p5` | 998 | 43,2 | +0,042 | [-0,035 ; +0,120] | 1,07 | 32,1 | -0,013 | c2,c3,c4,c7,c8 |
| `G_tf4h_dc20_voloff_tp1p0` | 1502 | 53,3 | +0,036 | [-0,016 ; +0,086] | 1,07 | 45,2 | +0,002 | c2,c3,c7,c8 |
| `F_tf4h_rsi45-55_stopatr_tp1p0` | 1215 | 52,9 | +0,025 | [-0,033 ; +0,080] | 1,05 | 34,5 | -0,019 | c2,c3,c4,c7,c8 |
| `F_tf4h_rsi45-55_stoppivot_tp1p0` | 898 | 53,0 | +0,021 | [-0,044 ; +0,087] | 1,04 | 21,8 | -0,019 | c2,c3,c4,c7 |
| `F_tf4h_rsi40-60_stopatr_tp1p0` | 714 | 52,4 | +0,016 | [-0,060 ; +0,089] | 1,03 | 28,6 | -0,034 | c2,c3,c4,c7,c8 |
| `F_tf1h_rsi40-60_stoppivot_tp1p5` | 2078 | 41,0 | -0,039 | [-0,092 ; +0,015] | 0,94 | 82,9 | -0,114 | c2,c3,c4,c5,c6,c7,c8 |
| `G_tf1h_dc20_voloff_tp1p5` | 4654 | 40,4 | -0,040 | [-0,076 ; -0,005] | 0,94 | 92,9 | -0,095 | c2,c3,c4,c6,c7,c8 |
| `G_tf1h_dc55_voloff_tp1p0` | 5153 | 50,3 | -0,040 | [-0,068 ; -0,012] | 0,92 | 94,9 | -0,096 | c2,c3,c4,c5,c6,c7,c8 |
| `G_tf1h_dc55_volon_tp1p0` | 4727 | 50,2 | -0,042 | [-0,071 ; -0,013] | 0,92 | 95,1 | -0,097 | c2,c3,c4,c5,c6,c7,c8 |
| `G_tf1h_dc20_volon_tp1p5` | 4586 | 40,2 | -0,044 | [-0,079 ; -0,009] | 0,93 | 94,8 | -0,105 | c2,c3,c4,c5,c6,c7,c8 |
| `G_tf1h_dc55_voloff_tp1p5` | 3948 | 40,1 | -0,047 | [-0,086 ; -0,008] | 0,93 | 95,6 | -0,104 | c2,c3,c4,c5,c6,c7,c8 |
| `G_tf1h_dc55_volon_tp1p5` | 3700 | 40,0 | -0,049 | [-0,089 ; -0,009] | 0,92 | 95,0 | -0,111 | c2,c3,c4,c5,c6,c7,c8 |

## Lecture honnête

- Raccourcir l'objectif augmente le pourcentage de trades gagnants mais retire les gros gains qui faisaient l'essentiel du résultat du stop suiveur. Le gain moyen par trade diminue.
- Les entrées de cassure en 4h restent positives sur DEV et sur VAL quel que soit le type de sortie, mais avec un avantage faible (quelques centièmes de R), inférieur au seuil fixé et fragile face aux frais.
- Aucune de ces configurations n'a le verdict RETENU. Aucune ne doit être qualifiée de rentable.
- Ces résultats ne sont pas indépendants de ceux de l'étude 1 (mêmes données, mêmes entrées).
