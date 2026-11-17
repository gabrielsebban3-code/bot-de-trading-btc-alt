# Bot Dinexo : détection de setups sur les perpétuels Binance USDT-M

Système de **détection** de setups (jamais d'ordre, aucune clé API de trading). Plusieurs concepts concurrents
sont testés avec le même moteur ; seuls ceux qui prouvent un avantage net de frais, hors échantillon et
statistiquement significatif seront activés. Protocole : [`PROTOCOLE.md`](PROTOCOLE.md). Décisions :
[`DECISIONS.md`](DECISIONS.md).

> Ceci n'est pas un conseil financier. Les signaux viennent d'un backtest, sans garantie de résultat,
> avec un risque de perte totale.

## État d'avancement

| Phase | Contenu | État |
|---|---|---|
| 0 | Plan | validé |
| 1 | Données, moteur de backtest, tests anti-lookahead | **livrée** (voir `reports/PHASE1.md`) |
| 2 | C1 et C2 sur BTC et ETH, 1h / 4h / 1D | à faire après validation |
| 3 | Tournoi complet C3, C4, C5, toutes les paires, ablation | — |
| 4 | Alertes Discord, suivi, surveillance (alertes seules) | — |
| 5 | Déploiement gratuit et affichage sur Dinexo | seulement si un concept est « edge confirmé » |

## Installation

Python 3.11 ou plus récent.

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install -r bot/requirements.txt
```

Secrets : copier `bot/.env.example` en `bot/.env` (ignoré par git). Aucun secret n'est nécessaire en Phase 1.

## Configuration

Tous les paramètres sont dans [`config.yaml`](config.yaml) : données, univers, paires mises de côté, verrou du
test final, coûts, risque simulé, indicateurs, structure, statistiques. Rien n'est codé en dur.

## Données (Phase 1)

Toutes les commandes se lancent depuis la racine du dépôt.

```bash
python -m bot.main catalog          # catalogue des symboles + liste figée des paires mises de côté
```

```bash
python -m bot.main download-daily   # bougies 1d de tous les symboles éligibles (~23 000 fichiers, ~15 min)
```

```bash
python -m bot.main universe         # top 30 point-in-time de chaque mois
```

```bash
python -m bot.main download-long    # 15m + funding de tous les symboles passés dans l'univers
```

```bash
python -m bot.main download-fine    # 1m des 12 derniers mois
```

```bash
python -m bot.main native-check     # archives natives 1h / 4h pour contrôler le rééchantillonnage
```

```bash
python -m bot.main oi-depth         # profondeur réelle de l'historique d'open interest
```

```bash
python -m bot.main quality          # rapport reports/data_quality.md
```

```bash
python -m bot.main regression       # le moteur doit reproduire exactement l'étude 1 de perp-setups
```

Les téléchargements sont reprenables : un fichier déjà enregistré dans la table `files` n'est pas retéléchargé.
La base SQLite est dans `bot/var/` (non versionnée).

## Tests

```bash
python -m pytest bot/tests -q
```

Les tests couvrent : indicateurs calculés à la main, pivots connus à l'avance (fractals, ZigZag ATR,
hiérarchiques), BOS / CHoCH, FVG, order blocks, sweeps, **anti-lookahead** (les détections sur les N premières
bougies sont identiques avec ou sans les bougies suivantes, et ne changent pas si l'on modifie le futur),
règles d'exécution du moteur, limites du portefeuille, verrou du test final, idempotence des identifiants de
signal, et la non-régression contre l'étude 1 (sautée si la base n'est pas téléchargée).

## Backtest, tournoi, mode live

Ajoutés en Phases 2 à 4.

## Limites connues

- `fapi.binance.com` répond HTTP 451 depuis certains pays et hébergeurs (États-Unis, dont les serveurs de
  GitHub Actions). L'historique vient des archives `data.binance.vision`, qui ne sont pas bloquées. La source
  live sera choisie en Phase 4 après un essai réel.
- Liquidations : aucune archive publique. Open interest : seulement à partir de 2020-09 pour BTC, plus tard
  pour la plupart des paires (voir `reports/data_quality.md`).
- Toute la période 2020-2026 a déjà été utilisée par les études de `perp-setups/`. Le seul test vraiment
  neuf est le futur (à partir du 2026-11-01) et les paires mises de côté.
