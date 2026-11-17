# Bilan de la Phase 1 : données, moteur de backtest, tests anti-lookahead

Date : 2026-11-17. Aucune stratégie n'a été backtestée dans cette phase (le seul backtest est la reproduction
d'un résultat déjà connu, pour vérifier le moteur).

## Critères de fin

| Critère | Résultat |
|---|---|
| Tests verts | **54 tests passent** (`python -m pytest bot/tests -q`) |
| Test anti-lookahead obligatoire | Vert : pour chaque détecteur (pivots fractals, ZigZag ATR, hiérarchiques, BOS/CHoCH, tendance, FVG, order blocks, equal highs/lows, sweeps), les détections des N premières bougies sont identiques avec ou sans les bougies suivantes, et ne changent pas quand on remplace tout le futur par un autre chemin. Même test pour les indicateurs |
| Moteur vérifié | Le nouveau moteur reproduit **exactement** l'étude 1 de `perp-setups` (`C_tf4h_dc55_volon`, 2020-2022) : 455 trades, +0,2228 R, PF 1,497, 39,56 % de gagnants, drawdown 18,82 %. Test automatique (`test_regression_study1.py`) |
| Rapport généré | `reports/data_quality.md` (qualité), `reports/oi_depth.json`, `reports/cost_share_*.csv`, `reports/pivots_precision_2020_2021.csv` |

## Ce qui est disponible réellement (vérifié)

| Donnée | Disponible | Remarque |
|---|---|---|
| Bougies USDT-M | 2020-01 → 2026-10, archives mensuelles `data.binance.vision`, paires délistées comprises | 15m pour 302 symboles (34 M bougies), 1m pour les 12 derniers mois (15,8 M bougies, 100 % complètes), 1d natif pour 740 symboles |
| Funding | Même période, 1,5 M règlements | 10 paires-mois sans archive pendant leur présence dans l'univers : retirés de l'univers ces mois-là (D16) |
| Open interest | BTC depuis le 2020-09-01 ; la plupart des grandes paires depuis le 2021-12-01 | C4 (partie OI) testable sur environ 5 ans seulement |
| Liquidations | **Aucune archive publique** | Non utilisées en backtest |
| API live `fapi.binance.com` | **Bloquée depuis ce serveur (HTTP 451)**, probablement aussi depuis GitHub Actions | À trancher en Phase 4 par un essai réel |
| Frais | Maker 0,02 %, taker 0,05 % (grille Binance vérifiée le 2026-11-17) | |

Qualité : aucune bougie incohérente ; trous médians 0 %, au plus 1,6 % (trous réels des archives Binance, jamais
comblés, trades qui les rencontrent annulés). Rééchantillonnage 15m → 1h / 4h / 1d identique aux archives natives
pour les prix.

## Univers

- Top 30 par volume, recalculé chaque mois sur les 30 jours clos précédents, volume minimum 20 M USDT/jour.
- 302 symboles passés dans l'univers entre 2020-02 et 2026-10, dont **51 ne s'échangent plus** (LUNA, FTT, FTM,
  MATIC, SRM, WAVES…) : inclus tant qu'ils étaient dans le top 30, donc pas de biais de survivance.
- **Contrats non crypto exclus** (actions, ETF, or, pétrole, change, pré-IPO, ~175 tickers) : ils entraient dans
  le top 30 en 2026 (SNDK, XAU, SPCX, KORU…).
- Début 2020 : moins de 30 paires dépassent le volume minimum (3 en février, 10 de mars à juillet).
- **313 symboles mis de côté** par une règle de hachage figée avant tout téléchargement de prix ; en moyenne
  5,5 membres de l'univers par mois sont ainsi réservés au test final.

## Mesures faites avant toute stratégie

**Poids des coûts par timeframe** (stop à 2 ATR, aller-retour taker + slippage du modèle) :

| Timeframe | Coût en R par trade |
|---|---|
| 1m | 0,9 à 1,4 R |
| 5m | 0,37 à 0,52 R |
| 15m | 0,16 à 0,27 R |
| 1h | 0,08 à 0,13 R |
| 4h | 0,04 à 0,06 R |
| 1D | ≈ 0,015 R |

Conséquence : **1m et 5m sont désactivés comme signaux autonomes** (D18). Un setup 15m doit gagner plus de
0,2 R avant frais simplement pour finir à zéro. Les volatilités des 12 derniers mois sont plus basses qu'en
2020-2021, donc les coûts pèsent plus aujourd'hui.

**Pivots : le retard est le prix de la fiabilité** (BTC et ETH, 2020-2021, part des pivots qui restent l'extrême
pendant 20 bougies après leur confirmation) :

| Méthode | Retard moyen | Pivots qui tiennent |
|---|---|---|
| Fractal 3 bougies | 3 bougies | ~38-42 % |
| ZigZag 3 ATR | 8-9 bougies | ~70-83 % |
| Pivots intermédiaires | ~16 bougies | ~62-84 % |
| Pivots majeurs | ~110 bougies | > 90 % |

Un sommet n'est jamais connu au moment où il se forme : ces pivots servent de structure (stops, tendance, replis).

## Ce qui ne marche pas ou reste fragile

- **L'historique n'est plus neuf.** Toute la période 2020-2026 a déjà servi aux études 1 à 8 (environ 232 essais).
  Le seul test vraiment neuf sera le futur (à partir du 2026-11-01) et les paires mises de côté.
- **Source live non résolue** : l'API futures Binance est bloquée depuis les serveurs américains. Le site Dinexo
  utilise déjà OKX depuis GitHub Actions ; à décider en Phase 4.
- Liste des contrats non crypto tenue à la main (pas d'accès à `exchangeInfo`) : elle devra être revue si
  Binance ajoute d'autres actions ou ETF.
- Le modèle de slippage est une estimation (≈ 3,5 bp BTC, 7 à 9 bp altcoins moyens). Il n'a pas été mesuré sur des
  ordres réels. Le test coûts × 1,5 couvre une partie de ce risque.
- Données du test final : depuis le 2026-11-01, il n'y a que 16 jours. Le verdict « edge confirmé » ne sera pas
  possible avant plusieurs mois de données futures (au moins 100 trades et 3 mois, PROTOCOLE.md).

## Risque de surapprentissage à ce stade

Aucun paramètre de stratégie n'a été choisi. Les seuls réglages faits (slippage, liste non crypto, univers) ont été
décidés sans voir de résultat de backtest et sont journalisés (`DECISIONS.md`, D1 à D18).

## Prochaine étape (Phase 2, après ta validation)

1. Écrire et committer `PROTOCOLE_PHASE2.md` (grille fermée de C1 et C2, règle de sélection du walk-forward)
   **avant** tout calcul.
2. Coder C1 (cassure Donchian 20 / 55 / 100 / ensemble, filtre de régime EMA 50/200 + ADX + momentum, stop 2-3 ATR,
   trailing chandelier ou Donchian opposé) et C2 (repli EMA 20/50 ou zone, reprise + CHoCH/BOS LTF).
3. Backtest sur BTC et ETH, en 1h / 4h / 1D, walk-forward 2022-01 → 2026-10, long / short / les deux, baseline
   d'entrées aléatoires, coûts × 1,5, rapport complet.

Attendu honnête : sur 2 paires seulement, le nombre de trades sera faible en 1D (non concluant probable), et les
études précédentes suggèrent que la cassure 4h est proche de zéro une fois les coûts et le hasard pris en compte.
