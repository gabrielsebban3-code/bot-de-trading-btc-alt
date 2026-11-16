# perp-setups

Recherche et validation de setups de trading sur les futures perpétuels Binance USDT-M.
Cinq familles de setups (100 configurations, grilles fermées) sont testées avec les mêmes données, les mêmes
coûts et les mêmes règles de validation. **Aucun ordre réel, aucune clé API** : données publiques uniquement.

Les résultats sont dans [`REPORT.md`](REPORT.md) et [`SETUPS_RETENUS.md`](SETUPS_RETENUS.md).
Les choix non spécifiés sont consignés dans [`DECISIONS.md`](DECISIONS.md), tous les essais dans `TRIALS.csv`.

## Installation

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
```

## Reproduction (commande unique)

```bash
python -m src.run download && python -m src.run validate-data && python -m src.run backtest --set dev,val && python -m src.run report
```

- `download` : télécharge les archives mensuelles `data.binance.vision` (klines 15m et funding) des 20 paires de
  `config/pairs.json`, vérifie les sommes SHA-256 et écrit `data/parquet/`.
  La liste des paires est **figée** : `pairs.json` n'est jamais recalculé s'il existe.
- `validate-data` : contrôles qualité, écrit `results/data_quality.md`.
- `backtest --set dev,val` : les 100 configurations sur DEV, sélection (DEV + plateau), évaluation sur VAL,
  baseline aléatoire, coûts ×2. Écrit `results/` et `TRIALS.csv`.
- `report` : graphiques, `REPORT.md`, `SETUPS_RETENUS.md`.

Le jeu TEST (à partir du 2025-01-01) est **verrouillé** : `backtest --set test` échoue tant que
`final_test_unlocked: true` n'est pas écrit dans `config/config.yaml`. Il ne s'exécute qu'une fois et seulement sur
les configurations qui ont rempli les 9 critères sur VAL.

## Études complémentaires

Après le verdict de l'étude 1 (aucun setup validé), deux études ont été menées avec des protocoles enregistrés avant calcul :

- **Étude 3** (`PROTOCOLE_ETUDE_3.md`, `RAPPORT_ETUDE_3.md`) : mêmes entrées de tendance avec objectif fixe à 1 R ou 1,5 R.
  32 configurations, aucune ne remplit les 9 critères sur VAL.
- **Étude 2** (`PROTOCOLE_ETUDE_2.md`, `RAPPORT_ETUDE_2.md`) : `C_tf4h_dc55_volon` avec 0,5 % de risque par trade,
  test final unique sur 2025-2026. Verdict : **REJETÉ** (7 critères sur 9). Aucun setup validé, scanner non construit.

```bash
python -m src.run --study etude3 backtest --set dev,val
```

Le jeu TEST a été ouvert une seule fois, pour l'étude 2 ; il ne peut plus servir de test indépendant.

- **Étude 4** (`PROTOCOLE_ETUDE_4.md`, `rapport.md`) : sept méthodes en 15m et 1H (SMC, breakout, suivi de tendance,
  mean reversion, VWAP, funding, momentum), 56 variantes, découpe 60 / 20 / 20. Aucune ne remplit tous les critères
  sur la validation ; le test final de cette étude n'a pas été ouvert et le scanner n'est pas construit.

```bash
python -m src.etude4 run && python -m src.etude4 report
```

## Tests

```bash
python -m pytest -q
```

## Organisation

```
config/config.yaml   paramètres (périodes, frais, seuils, grilles)   config/pairs.json   20 paires figées
src/data.py          téléchargement, nettoyage, qualité, verrou TEST  src/indicators.py   EMA, ATR, RSI, ADX, Bollinger, Donchian
src/structure.py     pivots, sweeps, cassure, FVG, order blocks       src/setups.py       signaux des familles A à E
src/engine.py        moteur de simulation (résolution 15m)            src/metrics.py      statistiques, sélection, verdict
src/run.py           ligne de commande et rapport                     tests/              pytest
results/             trades CSV, tableaux, graphiques
```

## Remarque sur l'accès à Binance

L'API `fapi.binance.com` refuse les serveurs situés dans certains pays (HTTP 451). Le projet n'en a besoin que pour
créer `pairs.json` (endpoint `exchangeInfo`) ; si elle est inaccessible, placez la réponse de
`https://fapi.binance.com/fapi/v1/exchangeInfo` dans `data/raw/exchangeInfo.json` avant `download`.
Tout le reste vient de `data.binance.vision`.
