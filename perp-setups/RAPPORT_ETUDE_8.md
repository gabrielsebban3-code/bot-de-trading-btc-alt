# Étude 8 : les bots du commerce (grid et DCA) — résultats

Protocole : `PROTOCOLE_ETUDE_8.md` (écrit avant le calcul). Code : `src/etude8*.py`. Résultats : `results_etude8/`.

## Verdict

**Aucune des deux familles ne remplit les critères.** Le grid perd hors échantillon. Le DCA sans stop gagne un peu, mais moins bien que la simple détention en rendement ajusté du risque, et son résultat est flatté par le biais de survie (les cryptos tombées à zéro ne sont pas dans les paires testées).

## Variante gardée (choisie sur 2020-2023)

| Bot | Variante | 2020-2023 : Sharpe / rendement annuel / drawdown | 2024-2026 | 20 nouvelles paires | Critères ratés |
|---|---|---|---|---|---|
| **DCA** | `DCA_step0p02_take_profit0p015_stopnone` | 0,92 / +9,5 % / 13,7 % | 0,48 / +4,6 % / 12,5 % | 0,29 / +2,9 % / 15,1 % | Sharpe ≥ 1 ; IC du Sharpe > 0 ; ≥ 60 % des trimestres positifs ; mieux que le buy & hold |
| **GRID** | `GRID_levels10_lookback_days14` | 0,78 / +4,9 % / 12,5 % | -0,68 / -6,8 % / 25,9 % | -0,10 / -1,0 % / 26,1 % | Sharpe ≥ 1 ; IC du Sharpe > 0 ; drawdown < 25 % ; positif avec coûts ×2 ; ≥ 60 % des trimestres positifs ; positif dans 2 régimes sur 3 ; mieux que le buy & hold |

Buy & hold du panier égal : Sharpe 1,33, 0,57 et 0,68.

## Toutes les variantes

| Variante | Trades (nouvelles paires) | 2020-2023 : Sharpe | 2024-2026 : Sharpe | Nouvelles paires : Sharpe | Drawdown max (nouvelles paires) |
|---|---:|---:|---:|---:|---:|
| `DCA_step0p02_take_profit0p015_stopnone` | 4616 | 0,92 | 0,48 | 0,29 | 15,1 % |
| `DCA_step0p02_take_profit0p015_stop0p25` | 8721 | -0,18 | 0,14 | -0,34 | 37,2 % |
| `DCA_step0p02_take_profit0p03_stopnone` | 1876 | 0,86 | 0,47 | 0,30 | 23,2 % |
| `DCA_step0p02_take_profit0p03_stop0p25` | 5777 | -0,05 | -0,00 | -0,08 | 38,3 % |
| `DCA_step0p03_take_profit0p015_stopnone` | 6432 | 0,86 | 1,17 | 0,70 | 10,8 % |
| `DCA_step0p03_take_profit0p015_stop0p25` | 8473 | -0,36 | -0,11 | -0,31 | 29,8 % |
| `DCA_step0p03_take_profit0p03_stopnone` | 2596 | 0,91 | 0,93 | 0,50 | 16,3 % |
| `DCA_step0p03_take_profit0p03_stop0p25` | 5649 | -0,18 | 0,06 | -0,11 | 31,8 % |
| `GRID_levels10_lookback_days7` | 31853 | 0,56 | -1,09 | -0,73 | 50,4 % |
| `GRID_levels10_lookback_days14` | 19352 | 0,78 | -0,68 | -0,10 | 26,1 % |
| `GRID_levels20_lookback_days7` | 103482 | -0,16 | -1,59 | -1,28 | 78,7 % |
| `GRID_levels20_lookback_days14` | 70166 | 0,31 | -1,03 | -0,49 | 35,7 % |

## Lecture honnête

- **Grid** : il gagne dans les marchés calmes et perd dès que le prix sort de la fourchette. Hors échantillon, les quatre variantes perdent ; plus la grille est serrée, plus il perd (frais).
- **DCA** : le stop à −25 % rend toutes les variantes négatives. Sans stop, le DCA gagne un peu (4 à 10 % par an) parce qu'il finit par revendre sur les rebonds, mais il fait moins bien que la détention en rendement ajusté du risque.
- **Biais de survie, décisif pour le DCA sans stop** : les paires testées sont celles qui existent encore en 2026. Un DCA sans stop sur une crypto qui s'effondre (LUNA, FTT en 2022) bloque sa part pour toujours ; ces cas sont absents du test, qui est donc trop favorable.
- Une variante non choisie (DCA pas de 3 %, objectif 1,5 %) a un Sharpe de 1,17 sur 2024-2026 ; la choisir maintenant serait sélectionner après coup. Elle reste à 0,70 sur les nouvelles paires.
- 12 variantes (+ 4 décalées) ; environ 234 au total sur ces marchés.
