### 1. Tests unitaires

Sortie de `python -m pytest -q` (exécutée après la dernière modification du code) :

```
...................................................................      [100%]
67 passed, 4 warnings in 21.05s
```

### 2. Aucun accès au jeu TEST

- `final_test_unlocked: false` dans `config/config.yaml` ; `results/summary_test.csv` n’existe pas.
- Toutes les exécutions consignées dans `results/run_log.txt` (4 lignes) portent `final_test_unlocked=False` et une limite de lecture au 2025-01-01 : True.
- Sortie de trade la plus tardive dans tous les fichiers `trades_*.csv` : 2024-12-31 23:45:00+00:00 (avant 2025-01-01).
- La lecture des fichiers parquet filtre `open_time < 2025-01-01` tant que le verrou est fermé (test `test_lock_and_causality.py`).
- Réserves, déjà notées dans `DECISIONS.md` : (a) en vérifiant le format des CSV j'ai vu l'en-tête et 2 bougies BTC d'octobre 2026 (D4) ; (b) le classement des paires utilise, comme l'impose la mission, le volume journalier des 90 derniers jours (août-novembre 2026), sans aucun prix de backtest.

### 3. Essais consignés

- `TRIALS.csv` : 142 lignes, 100 configurations distinctes (100 DEV, 21 VAL, 21 VAL coûts ×2, 0 TEST).
- Grille de `config.yaml` : 100 combinaisons. Configurations hors grille dans `TRIALS.csv` : 0. Combinaisons de la grille absentes : 0.

### 4. Deux exécutions identiques

- `backtest --set dev,val` lancé deux fois (cache de signaux effacé entre les deux) : 142 fichiers `trades_*.csv`, empreintes SHA-256 identiques fichier par fichier : **True**.
- Empreinte de la liste complète des empreintes : `4e853cdaf859f38eaeac0ed125f03c7e09eb57719e23970800ff1685a88b7f53` ; fichiers actuellement dans `results/` identiques à ces deux exécutions : **True**.
- `TRIALS.csv` et `selection.json` sont identiques entre les deux exécutions. Les tableaux `summary_*.csv` ne diffèrent que par la colonne `seconds` (temps de calcul).

### 5. Trois valeurs recalculées à la main

Tirage au hasard (graine 42) de 3 lignes parmi les configurations d'au moins 100 trades, puis recalcul direct à partir du fichier `trades_<config>_<jeu>.csv` (moyenne, somme et comptage simples, sans passer par `src/metrics.py`).

| Configuration | Jeu | Grandeur | Valeur du rapport | Recalcul | Écart |
|---|---|---|---:|---:|---:|
| `D_tf1h_k2p5_rsi25-75` | DEV | expectancy_r | -0.380091 | -0.380091 | 1.2e-07 |
| `A_tf15m_n3_simple_FVG_tp2_htfoff` | DEV | profit_factor | 0.943466 | 0.943466 | 4.3e-07 |
| `B_tf1h_rsi45-55_stopatr_exittrail` | VAL | win_rate | 0.312085 | 0.312085 | 3.3e-07 |

Vérification d'un trade (premier trade de `C_tf4h_dc55_volon` sur VAL, XRPUSDT short) : PnL = sens × (sortie − entrée) × taille − frais − funding = -104.1020 USDT (fichier : -104.1020) ; frais = (entrée + sortie) × taille × 0,05 % = 2.4128 (fichier : 2.4128) ; R = PnL / (|entrée − stop| × taille) = -1.0410 (fichier : -1.0410).

Écarts tous inférieurs à 1e-5 (arrondi des CSV) : **True**.

### 6. Liste de contrôle (section 15)

- [x] Tests unitaires tous au vert, sortie collée ci-dessus.
- [x] Aucun accès au TEST : il n'a jamais été ouvert (aucune configuration ne survit à VAL).
- [x] 100 configurations dans `TRIALS.csv`, aucune hors grille.
- [x] Deux exécutions donnent les mêmes fichiers de trades (mêmes empreintes).
- [x] Les chiffres du rapport correspondent aux CSV (3 valeurs tirées au hasard + 1 trade recalculés).
- [x] Section « Limites » complète, verdict rendu tel quel : aucun setup validé.
