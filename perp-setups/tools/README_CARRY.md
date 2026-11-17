# Suivi du carry en paper trading

**Non validé pour de l'argent réel. Alertes seulement : le script ne passe aucun ordre et n'utilise aucune clé API.**

## Règle (étude 7)

Pour chaque crypto suivie, chaque jour après 00:05 UTC :
- si le funding moyen des 14 derniers jours est **positif** : tenir « spot acheté + perpétuel vendu », même montant ;
- sinon : fermer les deux jambes.

Le script suit 10 cryptos très liquides (BTC, ETH, SOL, XRP, DOGE, BNB, ADA, LINK, AVAX, LTC) au lieu des 20 du
backtest, pour rester praticable avec un petit capital (montant minimum par ordre). C'est une adaptation pratique,
signalée comme telle : elle n'a pas été testée séparément.

## Installation

```bash
python3 tools/carry_monitor.py --exchange okx
```

Pas de dépendance à installer (bibliothèque standard de Python 3.10+). Pour recevoir le résultat sur Discord :

```bash
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." python3 tools/carry_monitor.py --exchange okx --discord
```

Le webhook se met dans la variable d'environnement, jamais dans le code. Pour le lancer chaque jour (Linux / macOS) :

```bash
crontab -e
```

puis ajouter la ligne `5 0 * * * cd /chemin/vers/perp-setups && python3 tools/carry_monitor.py --exchange okx --discord`.

Le journal `tools/carry_paper_journal.csv` garde chaque décision ; `tools/carry_state.json` mémorise les positions.
Une erreur réseau ne crée jamais de signal : la position reste inchangée et l'erreur est écrite dans le journal.
