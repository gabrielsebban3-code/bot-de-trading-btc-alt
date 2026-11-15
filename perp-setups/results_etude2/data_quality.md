# Contrôle qualité des données

Périmètre contrôlé : **DEV+VAL+TEST**, bougies 15m jusqu'au 2026-10-31 23:45:00+00:00 inclus.

Source : archives mensuelles data.binance.vision (klines 15m et fundingRate), sommes de contrôle SHA-256 vérifiées. Aucune bougie n'est comblée ni interpolée.

Paires exclues (> 1.0 % de bougies manquantes) : **aucune**

| Paire | Première bougie | Attendues | Reçues | Manquantes | % manq. | Trous | Doublons retirés | Volume nul | high<low | close hors [low,high] | Bougies >30 % | Lignes funding |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| BTCUSDT | 2020-01-01 00:00 | 239616 | 239616 | 0 | 0.0000 | 0 | 0 | 15 | 0 | 0 | 1 | 7488 |
| ETHUSDT | 2020-01-01 00:00 | 239616 | 239616 | 0 | 0.0000 | 0 | 0 | 10 | 0 | 0 | 4 | 7488 |
| ZECUSDT | 2020-02-05 08:00 | 236224 | 235744 | 480 | 0.2032 | 2 | 0 | 11 | 0 | 0 | 10 | 7385 |
| SOLUSDT | 2020-09-14 07:00 | 214916 | 214436 | 480 | 0.2233 | 2 | 0 | 10 | 0 | 0 | 6 | 6793 |
| XRPUSDT | 2020-01-06 08:15 | 239103 | 238623 | 480 | 0.2008 | 2 | 0 | 11 | 0 | 0 | 8 | 7472 |
| NEARUSDT | 2020-10-15 08:00 | 211936 | 211456 | 480 | 0.2265 | 2 | 0 | 10 | 0 | 0 | 7 | 6625 |
| DOGEUSDT | 2020-07-10 09:00 | 221244 | 221244 | 0 | 0.0000 | 0 | 0 | 10 | 0 | 0 | 14 | 6914 |
| BNBUSDT | 2020-02-10 08:00 | 235744 | 235744 | 0 | 0.0000 | 0 | 0 | 10 | 0 | 0 | 5 | 7367 |
| 1000PEPEUSDT | 2023-05-05 16:30 | 122430 | 122430 | 0 | 0.0000 | 0 | 0 | 4 | 0 | 0 | 7 | 3826 |
| ENAUSDT | 2024-04-02 12:30 | 90478 | 90478 | 0 | 0.0000 | 0 | 0 | 4 | 0 | 0 | 1 | 5653 |
| SUIUSDT | 2023-05-03 16:00 | 122624 | 122624 | 0 | 0.0000 | 0 | 0 | 4 | 0 | 0 | 2 | 3832 |
| UNIUSDT | 2020-09-18 07:00 | 214532 | 214532 | 0 | 0.0000 | 0 | 0 | 10 | 0 | 0 | 6 | 6707 |
| WLDUSDT | 2023-07-24 12:00 | 114768 | 114768 | 0 | 0.0000 | 0 | 0 | 4 | 0 | 0 | 4 | 3586 |
| TRUMPUSDT | 2025-01-18 13:00 | 62540 | 62540 | 0 | 0.0000 | 0 | 0 | 0 | 0 | 0 | 4 | 3907 |
| ADAUSDT | 2020-01-31 08:00 | 236704 | 236704 | 0 | 0.0000 | 0 | 0 | 10 | 0 | 0 | 6 | 7432 |
| LINKUSDT | 2020-01-17 08:00 | 238048 | 238048 | 0 | 0.0000 | 0 | 0 | 10 | 0 | 0 | 8 | 7439 |
| QNTUSDT | 2022-10-20 02:30 | 141398 | 141398 | 0 | 0.0000 | 0 | 0 | 5 | 0 | 0 | 3 | 4418 |
| AVAXUSDT | 2020-09-23 07:00 | 214052 | 214052 | 0 | 0.0000 | 0 | 0 | 10 | 0 | 0 | 5 | 6691 |
| TAOUSDT | 2024-04-11 14:30 | 89606 | 89606 | 0 | 0.0000 | 0 | 0 | 4 | 0 | 0 | 1 | 5599 |
| ARBUSDT | 2023-03-23 15:00 | 126564 | 126564 | 0 | 0.0000 | 0 | 0 | 4 | 0 | 0 | 3 | 3956 |

## Trous (intervalles manquants)

- ZECUSDT : 2022-02-26 00:00 → 2022-02-28 23:45 (288 bougie(s))
- ZECUSDT : 2022-04-01 00:00 → 2022-04-02 23:45 (192 bougie(s))
- SOLUSDT : 2022-02-26 00:00 → 2022-02-28 23:45 (288 bougie(s))
- SOLUSDT : 2022-04-01 00:00 → 2022-04-02 23:45 (192 bougie(s))
- XRPUSDT : 2022-02-26 00:00 → 2022-02-28 23:45 (288 bougie(s))
- XRPUSDT : 2022-04-01 00:00 → 2022-04-02 23:45 (192 bougie(s))
- NEARUSDT : 2022-02-26 00:00 → 2022-02-28 23:45 (288 bougie(s))
- NEARUSDT : 2022-04-01 00:00 → 2022-04-02 23:45 (192 bougie(s))

## Bougies avec mouvement > 30 % (listées, non supprimées)

Mouvement = |close/open - 1| ou amplitude high/low - 1.

- BTCUSDT 2021-07-26 01:00 : corps 3.43 %, amplitude 31.4 %
- ETHUSDT 2020-03-13 02:30 : corps 23.42 %, amplitude 237.09 %
- ETHUSDT 2020-08-02 04:30 : corps 9.46 %, amplitude 36.56 %
- ETHUSDT 2021-05-19 12:45 : corps 3.74 %, amplitude 30.41 %
- ETHUSDT 2021-05-19 13:00 : corps 9.72 %, amplitude 69.98 %
- ZECUSDT 2020-03-13 02:15 : corps 11.17 %, amplitude 45.95 %
- ZECUSDT 2021-04-18 03:30 : corps 10.27 %, amplitude 36.29 %
- ZECUSDT 2021-05-19 12:45 : corps 20.89 %, amplitude 53.27 %
- ZECUSDT 2021-05-19 13:00 : corps 12.84 %, amplitude 44.76 %
- ZECUSDT 2021-05-19 13:15 : corps 18.14 %, amplitude 32.5 %
- ZECUSDT 2021-05-19 13:30 : corps 12.2 %, amplitude 43.09 %
- ZECUSDT 2021-05-19 13:45 : corps 6.9 %, amplitude 37.64 %
- ZECUSDT 2023-06-10 04:15 : corps 19.83 %, amplitude 31.73 %
- ZECUSDT 2025-10-10 21:15 : corps 16.7 %, amplitude 47.31 %
- ZECUSDT 2026-06-05 07:00 : corps 21.18 %, amplitude 30.96 %
- SOLUSDT 2020-09-14 07:00 : corps 4.35 %, amplitude 53.43 %
- SOLUSDT 2021-01-08 10:00 : corps 12.25 %, amplitude 30.5 %
- SOLUSDT 2021-05-19 12:45 : corps 12.06 %, amplitude 51.81 %
- SOLUSDT 2022-11-09 18:45 : corps 13.57 %, amplitude 39.95 %
- SOLUSDT 2023-06-10 04:15 : corps 15.14 %, amplitude 30.21 %
- SOLUSDT 2025-10-10 21:15 : corps 5.99 %, amplitude 31.42 %
- XRPUSDT 2020-06-02 14:45 : corps 5.53 %, amplitude 39.5 %
- XRPUSDT 2020-08-02 04:30 : corps 7.03 %, amplitude 30.76 %
- XRPUSDT 2020-10-22 23:00 : corps 1.42 %, amplitude 30.55 %
- XRPUSDT 2021-02-01 13:30 : corps 26.55 %, amplitude 49.6 %
- XRPUSDT 2021-05-19 12:45 : corps 5.75 %, amplitude 35.79 %
- XRPUSDT 2021-12-04 05:15 : corps 15.39 %, amplitude 34.39 %
- XRPUSDT 2023-08-17 21:30 : corps 24.22 %, amplitude 37.26 %
- XRPUSDT 2025-10-10 21:15 : corps 15.11 %, amplitude 96.67 %
- NEARUSDT 2021-05-19 12:45 : corps 10.61 %, amplitude 35.55 %
- NEARUSDT 2021-05-19 13:00 : corps 16.05 %, amplitude 33.01 %
- NEARUSDT 2021-09-07 15:00 : corps 2.74 %, amplitude 30.86 %
- NEARUSDT 2021-12-15 04:00 : corps 25.52 %, amplitude 90.1 %
- NEARUSDT 2024-01-03 12:00 : corps 13.5 %, amplitude 34.91 %
- NEARUSDT 2025-10-10 21:15 : corps 13.42 %, amplitude 71.55 %
- NEARUSDT 2026-08-22 05:00 : corps 11.09 %, amplitude 34.45 %
- DOGEUSDT 2021-01-28 15:15 : corps 17.21 %, amplitude 42.19 %
- DOGEUSDT 2021-01-28 15:30 : corps 12.45 %, amplitude 31.0 %
- DOGEUSDT 2021-01-29 00:30 : corps 10.12 %, amplitude 38.29 %
- DOGEUSDT 2021-01-29 03:15 : corps 24.87 %, amplitude 58.47 %
- DOGEUSDT 2021-01-29 03:45 : corps 25.63 %, amplitude 37.74 %
- DOGEUSDT 2021-01-29 06:45 : corps 11.9 %, amplitude 46.32 %
- DOGEUSDT 2021-01-31 18:45 : corps 6.55 %, amplitude 30.68 %
- DOGEUSDT 2021-04-16 13:45 : corps 14.16 %, amplitude 35.71 %
- DOGEUSDT 2021-04-23 02:15 : corps 9.56 %, amplitude 33.49 %
- DOGEUSDT 2021-05-19 12:45 : corps 14.84 %, amplitude 71.2 %
- DOGEUSDT 2021-05-19 13:00 : corps 0.07 %, amplitude 41.49 %
- DOGEUSDT 2021-12-04 05:15 : corps 15.83 %, amplitude 35.73 %
- DOGEUSDT 2022-05-11 12:45 : corps 7.86 %, amplitude 33.82 %
- DOGEUSDT 2025-10-10 21:15 : corps 15.73 %, amplitude 140.7 %
- BNBUSDT 2020-03-12 10:45 : corps 4.5 %, amplitude 32.4 %
- BNBUSDT 2021-05-19 12:45 : corps 1.78 %, amplitude 37.59 %
- BNBUSDT 2021-05-19 13:00 : corps 10.59 %, amplitude 34.57 %
- BNBUSDT 2021-05-19 13:15 : corps 1.28 %, amplitude 33.41 %
- BNBUSDT 2025-10-10 21:15 : corps 11.71 %, amplitude 36.68 %
- 1000PEPEUSDT 2023-06-10 04:15 : corps 15.62 %, amplitude 31.66 %
- 1000PEPEUSDT 2023-11-09 16:00 : corps 10.92 %, amplitude 38.13 %
- 1000PEPEUSDT 2023-12-11 02:00 : corps 11.28 %, amplitude 39.0 %
- 1000PEPEUSDT 2024-01-03 12:00 : corps 15.52 %, amplitude 41.5 %
- 1000PEPEUSDT 2024-04-12 18:30 : corps 11.66 %, amplitude 35.73 %
- 1000PEPEUSDT 2025-10-10 21:15 : corps 31.47 %, amplitude 165.18 %
- 1000PEPEUSDT 2025-10-10 21:30 : corps 27.66 %, amplitude 31.42 %
- ENAUSDT 2025-10-10 21:15 : corps 2.16 %, amplitude 231.33 %
- SUIUSDT 2023-06-10 04:15 : corps 14.04 %, amplitude 34.04 %
- SUIUSDT 2025-10-10 21:15 : corps 26.87 %, amplitude 385.48 %
- UNIUSDT 2021-02-22 14:15 : corps 2.08 %, amplitude 36.62 %
- UNIUSDT 2021-05-19 12:45 : corps 11.01 %, amplitude 43.51 %
- UNIUSDT 2021-05-19 13:00 : corps 1.79 %, amplitude 44.65 %
- UNIUSDT 2021-12-04 05:15 : corps 17.0 %, amplitude 31.82 %
- UNIUSDT 2025-10-10 21:15 : corps 34.13 %, amplitude 185.52 %
- UNIUSDT 2026-02-11 14:00 : corps 25.92 %, amplitude 35.36 %
- WLDUSDT 2024-01-03 12:00 : corps 17.67 %, amplitude 51.28 %
- WLDUSDT 2025-10-10 21:15 : corps 43.37 %, amplitude 258.51 %
- WLDUSDT 2025-10-10 21:30 : corps 39.7 %, amplitude 48.97 %
- WLDUSDT 2026-08-22 05:00 : corps 10.75 %, amplitude 49.16 %
- TRUMPUSDT 2025-01-19 21:15 : corps 20.49 %, amplitude 48.56 %
- TRUMPUSDT 2025-01-19 21:45 : corps 4.9 %, amplitude 35.0 %
- TRUMPUSDT 2025-10-10 21:15 : corps 35.08 %, amplitude 382.3 %
- TRUMPUSDT 2026-08-22 05:00 : corps 6.47 %, amplitude 43.27 %
- ADAUSDT 2020-02-28 17:15 : corps 0.17 %, amplitude 111.42 %
- ADAUSDT 2021-05-19 12:45 : corps 5.24 %, amplitude 40.32 %
- ADAUSDT 2021-05-19 13:15 : corps 17.06 %, amplitude 43.17 %
- ADAUSDT 2021-05-19 13:30 : corps 7.68 %, amplitude 32.01 %
- ADAUSDT 2025-10-10 21:15 : corps 29.16 %, amplitude 139.01 %
- ADAUSDT 2025-10-10 21:30 : corps 29.55 %, amplitude 33.64 %
- LINKUSDT 2020-03-12 10:45 : corps 6.02 %, amplitude 58.85 %
- LINKUSDT 2020-03-13 02:30 : corps 37.0 %, amplitude 47.92 %
- LINKUSDT 2020-12-23 22:15 : corps 9.18 %, amplitude 30.75 %
- LINKUSDT 2021-05-19 12:45 : corps 7.06 %, amplitude 44.29 %
- LINKUSDT 2021-05-19 13:30 : corps 3.0 %, amplitude 33.05 %
- LINKUSDT 2021-12-04 05:15 : corps 14.94 %, amplitude 30.16 %
- LINKUSDT 2025-10-10 21:15 : corps 27.52 %, amplitude 122.64 %
- LINKUSDT 2025-10-10 21:30 : corps 24.91 %, amplitude 30.0 %
- QNTUSDT 2025-10-10 21:15 : corps 20.53 %, amplitude 37.54 %
- QNTUSDT 2026-09-27 22:45 : corps 31.76 %, amplitude 44.54 %
- QNTUSDT 2026-09-27 23:00 : corps 12.4 %, amplitude 36.46 %
- AVAXUSDT 2021-04-18 03:30 : corps 18.38 %, amplitude 40.26 %
- AVAXUSDT 2021-05-19 12:45 : corps 11.54 %, amplitude 42.3 %
- AVAXUSDT 2022-05-11 12:45 : corps 17.6 %, amplitude 31.08 %
- AVAXUSDT 2023-06-10 04:15 : corps 21.18 %, amplitude 36.02 %
- AVAXUSDT 2025-10-10 21:15 : corps 21.56 %, amplitude 178.94 %
- TAOUSDT 2025-10-10 21:15 : corps 18.3 %, amplitude 143.78 %
- ARBUSDT 2024-01-03 12:00 : corps 9.81 %, amplitude 31.58 %
- ARBUSDT 2024-04-12 18:30 : corps 10.8 %, amplitude 31.03 %
- ARBUSDT 2025-10-10 21:15 : corps 32.54 %, amplitude 215.56 %

## Mois d'archives absents

Aucun.
