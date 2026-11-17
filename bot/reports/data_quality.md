# Qualité des données

Généré à partir de `market.sqlite`. Période lisible : 2020-01-01 → 2026-10-31 (verrou du test final : 2026-11-01, aucune donnée postérieure n'est stockée).

## Catalogue et univers

- Symboles présents dans les archives USDT-M : 1080 ; éligibles : 740 (exclus : {'': 740, 'non_crypto': 175, 'other_quote': 104, 'dated_future': 53, 'index': 5, 'stablecoin': 3}).
- Univers mensuel (top 30, volume moyen ≥ 20 M USDT/jour sur 30 jours clos) : 81 mois, 302 symboles distincts dont 51 délistés depuis.
- Membres par mois : min 3, max 30 ; dont mis de côté (jamais lus avant le test final) : en moyenne 5.5 par mois.
- Paires de l'univers qui ne s'échangent plus (aucun volume pendant le dernier mois : délistées ou renommées) : 51 : AERGOUSDT, AGIXUSDT, AI16ZUSDT, ALPACAUSDT, ALPHAUSDT, BAKEUSDT, BLZUSDT, BNXUSDT, DEGOUSDT, DENTUSDT, EOSUSDT, FLMUSDT, FRONTUSDT, FTMUSDT, FTTUSDT, FUNUSDT, HIFIUSDT, HIGHUSDT, HNTUSDT, ICXUSDT, IPUSDT, KEEPUSDT, KLAYUSDT, LENDUSDT, LEVERUSDT, LINAUSDT, LRCUSDT, LUNAUSDT, MATICUSDT, MKRUSDT, NEIROETHUSDT, OCEANUSDT, OMGUSDT, OMUSDT, PERPUSDT, REEFUSDT, RENUSDT, RNDRUSDT, SRMUSDT, STMXUSDT, STORJUSDT, SXPUSDT, TOMOUSDT, TONUSDT, UNFIUSDT, UXLINKUSDT, VANRYUSDT, VINEUSDT, VOXELUSDT, WAVESUSDT, YFIIUSDT. Elles sont incluses tant qu'elles étaient dans le top 30 (pas de biais de survivance).
- Mois avec moins de 30 membres (volume minimum non atteint) : 2020-02 (3), 2020-03 (10), 2020-04 (10), 2020-05 (10), 2020-06 (10), 2020-07 (10), 2020-08 (17), 2020-10 (25), 2020-11 (22).

## Bougies 15m (302 symboles)

- Bougies manquantes : médiane 0.000 %, max 1.589 %. Les trous ne sont jamais comblés : un trade qui en rencontre un est annulé, et aucun signal n'est émis pendant 30 jours après.
- OHLC incohérents : 0 ; volume nul : 1868617 bougies ; mouvements > 30 % sur une bougie : 2669 (listés, non supprimés).

Symboles avec le plus de bougies manquantes :

| symbol | first | last | rows | missing | missing_pct | n_gaps | largest_gap | gaps_preview |
|---|---|---|---|---|---|---|---|---|
| BNXUSDT | 2022-04-01 03:30 | 2026-10-31 23:45 | 158231 | 2555 | 1.5891 | 4 | 2075 | [('2023-02-01 00:00', '2023-02-22 14:30', 2075), ('2022-08-10 00:00', '2022-08-12 23:45', 288), ('2022-04-17 00:00', '2022-04-17 23:45', 96)] |
| TLMUSDT | 2021-07-16 03:30 | 2026-10-31 23:45 | 182816 | 2834 | 1.5265 | 1 | 2834 | [('2023-03-01 00:00', '2023-03-30 12:15', 2834)] |
| ICPUSDT | 2021-05-11 03:00 | 2026-10-31 23:45 | 189482 | 2506 | 1.3053 | 1 | 2506 | [('2022-09-01 00:00', '2022-09-27 02:15', 2506)] |
| LUNAUSDT | 2021-01-28 07:00 | 2022-05-13 06:45 | 44640 | 480 | 1.0638 | 2 | 288 | [('2022-02-26 00:00', '2022-02-28 23:45', 288), ('2022-04-01 00:00', '2022-04-02 23:45', 192)] |
| YFIIUSDT | 2020-09-03 07:00 | 2022-04-12 09:00 | 55785 | 480 | 0.8531 | 2 | 288 | [('2022-02-26 00:00', '2022-02-28 23:45', 288), ('2022-04-01 00:00', '2022-04-02 23:45', 192)] |
| IMXUSDT | 2022-02-11 03:30 | 2026-10-31 23:45 | 165010 | 480 | 0.29 | 2 | 288 | [('2022-02-26 00:00', '2022-02-28 23:45', 288), ('2022-04-01 00:00', '2022-04-02 23:45', 192)] |
| FLOWUSDT | 2022-02-10 03:30 | 2026-10-31 23:45 | 165106 | 480 | 0.2899 | 2 | 288 | [('2022-02-26 00:00', '2022-02-28 23:45', 288), ('2022-04-01 00:00', '2022-04-02 23:45', 192)] |
| ROSEUSDT | 2021-12-31 03:30 | 2026-10-31 23:45 | 169042 | 480 | 0.2831 | 2 | 288 | [('2022-02-26 00:00', '2022-02-28 23:45', 288), ('2022-04-01 00:00', '2022-04-02 23:45', 192)] |
| PEOPLEUSDT | 2021-12-24 04:00 | 2026-10-31 23:45 | 169712 | 480 | 0.282 | 2 | 288 | [('2022-02-26 00:00', '2022-02-28 23:45', 288), ('2022-04-01 00:00', '2022-04-02 23:45', 192)] |
| LITUSDT | 2021-02-18 07:00 | 2026-10-31 23:45 | 199294 | 550 | 0.2752 | 3 | 288 | [('2022-02-26 00:00', '2022-02-28 23:45', 288), ('2022-04-01 00:00', '2022-04-02 23:45', 192), ('2025-12-23 00:00', '2025-12-23 17:15', 70)] |
| MASKUSDT | 2021-08-27 03:30 | 2026-10-31 23:45 | 181138 | 480 | 0.2643 | 2 | 288 | [('2022-02-26 00:00', '2022-02-28 23:45', 288), ('2022-04-01 00:00', '2022-04-02 23:45', 192)] |
| OGNUSDT | 2021-04-01 07:00 | 2026-10-31 23:45 | 195332 | 480 | 0.2451 | 2 | 288 | [('2022-02-26 00:00', '2022-02-28 23:45', 288), ('2022-04-01 00:00', '2022-04-02 23:45', 192)] |
| HOTUSDT | 2021-03-30 07:00 | 2026-10-31 23:45 | 195524 | 480 | 0.2449 | 2 | 288 | [('2022-02-26 00:00', '2022-02-28 23:45', 288), ('2022-04-01 00:00', '2022-04-02 23:45', 192)] |
| LINAUSDT | 2021-03-19 07:00 | 2026-10-31 23:45 | 196580 | 480 | 0.2436 | 2 | 288 | [('2022-02-26 00:00', '2022-02-28 23:45', 288), ('2022-04-01 00:00', '2022-04-02 23:45', 192)] |
| ONEUSDT | 2021-03-18 07:00 | 2026-10-31 23:45 | 196676 | 480 | 0.2435 | 2 | 288 | [('2022-02-26 00:00', '2022-02-28 23:45', 288), ('2022-04-01 00:00', '2022-04-02 23:45', 192)] |


## Bougies 1m (116 symboles, mois où ils étaient membres de l'univers sur les 12 derniers mois)

- 360 fichiers mensuels, 15768000 bougies sur 15768000 attendues (0.000 % manquantes).

## Contrôle du rééchantillonnage (15m → 1h / 4h / 1d) contre les archives natives Binance

| symbol | tf | native | compared | max_rel_diff_open | max_rel_diff_high | max_rel_diff_low | max_rel_diff_close | max_rel_diff_volume |
|---|---|---|---|---|---|---|---|---|
| BTCUSDT | 1h | 2232 | 2232 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 2.23e-16 |
| BTCUSDT | 4h | 558 | 558 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 3.79e-16 |
| BTCUSDT | 1d | 2496 | 2496 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 1.08e-01 |
| ETHUSDT | 1h | 2232 | 2232 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 1.16e-04 |
| ETHUSDT | 4h | 558 | 558 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 2.86e-05 |
| ETHUSDT | 1d | 2496 | 2496 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 3.21e-02 |
| DOGEUSDT | 1h | 2232 | 2232 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 0.00e+00 |
| DOGEUSDT | 4h | 558 | 558 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 0.00e+00 |
| DOGEUSDT | 1d | 2305 | 2304 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 0.00e+00 | 2.78e-02 |


## Funding

- 302 symboles, 1506511 règlements. Intervalle maximal entre deux règlements > 8 h pour 3 symboles (archives incomplètes ou changement d'intervalle).

## Open interest (fichiers `metrics`, pas de 5 minutes)

- 301 symboles sur 302 ont un historique. Premier jour : le plus ancien 2020-09-01, médiane 2023-08-10.
- BTCUSDT : ['2020-09-01'] ; ETHUSDT : ['2021-12-01'].
- Liquidations : aucune archive publique (`liquidationSnapshot` vide pour les USDT-M). Aucune donnée de liquidation n'est utilisée en backtest.

