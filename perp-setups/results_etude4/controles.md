### 1. Tests

Sortie de `python -m pytest -q` (après la dernière modification du code) :

```
........................................................................ [ 85%]
............                                                             [100%]
84 passed, 36 warnings in 34.62s
```

### 2. Le test final n'a pas été lu

- `final_test_unlocked: false` dans `config/etude4.yaml` ; `results_etude4/summary_test.csv` n’existe pas.
- 2 exécutions consignées dans `results_etude4/run_log.txt`, toutes avec `final_test_unlocked=False` et une dernière bougie en mémoire au 2025-05-31 23:45 : True.
- Sortie de trade la plus tardive dans tous les fichiers de trades : 2025-05-31 23:45:00+00:00 (avant le 2025-06-01).

### 3. Variantes consignées

- `TRIALS_etude4.csv` : 112 lignes, 56 variantes distinctes (56 sur l'entraînement, 56 sur la validation, 0 sur le test).
- Grille de `config/etude4.yaml` : 56 combinaisons. Hors grille : 0. Absentes : 0.

### 4. Deux exécutions identiques

- `python -m src.etude4 run` lancé deux fois (cache de signaux effacé entre les deux) : 112 fichiers de trades, empreintes SHA-256 identiques fichier par fichier : **True**. Fichiers actuels identiques à ces exécutions : **True**.
- Empreinte de la liste des empreintes : `7bdf0f804c2b2e8210c14a4499487901d77d47823d6aa442e7f7f6185da2ca10`.
- Entre les deux exécutions, seul le calcul du walk-forward a été corrigé (une erreur d'unité de temps rendait toutes les fenêtres vides) ; les trades, la sélection et les critères sont inchangés.

### 5. Trois valeurs recalculées à la main

Trois lignes tirées au hasard (graine 42), recalculées directement à partir du fichier de trades, sans passer par le code de l'étude.

| Variante | Jeu | Grandeur | Rapport | Recalcul | Écart |
|---|---|---|---:|---:|---:|
| `M3_tf15m_ema20_tp2p5` | validation | expectancy_r | -0.0788337 | -0.0788337 | 1.1e-08 |
| `M2_tf15m_dc20_tp2p5` | entraînement | profit_factor | 0.827698 | 0.827698 | 1.3e-07 |
| `M4_tf1h_rsi30_tp2p5` | validation | win_rate | 0.232804 | 0.232804 | 2.3e-07 |

Un trade vérifié (premier trade de `M7_tf1h_v3_tp2p5` sur la validation, BNBUSDT short, sortie « stop ») : PnL = sens × (sortie − entrée) × taille − frais − funding = -114.7960 USDT (fichier : -114.7960) ; frais = (entrée + sortie) × taille × 0,05 % = 12.3218 (fichier : 12.3218).

Écarts tous inférieurs à 1e-5 : **True**.
