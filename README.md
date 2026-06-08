# Trend-Pullback Scalper Bot

Bot d'analyse crypto qui tourne 24h/24 sur Railway et envoie des signaux via Discord.

> ⚠️ **AVERTISSEMENT IMPORTANT**
> Ce bot émet uniquement des **signaux d'analyse technique**. Il ne passe **aucun ordre réel**.
> Les signaux ne constituent pas des conseils financiers ou d'investissement.
> Les résultats de backtest ne garantissent en aucun cas les performances futures.
> Vous êtes seul responsable de vos décisions de trading.
> **Paper-tradez systématiquement tous les signaux avant d'envisager quoi que ce soit avec de l'argent réel.**

---

## Stratégie : Trend-Pullback Scalper

**Multi-timeframe** : 5m pour le biais directionnel, 1m pour le déclencheur.

### Filtre de biais (5m)
- **Haussier** : EMA9 > EMA21 > EMA50 ET close > VWAP → longs autorisés
- **Baissier** : EMA9 < EMA21 < EMA50 ET close < VWAP → shorts autorisés
- **Range** ou ATR% trop faible → aucun signal

### Déclencheur d'entrée (1m) — 5 conditions
1. Pullback vers l'EMA21 (1m) ou le VWAP
2. RSI retourné (passé sous 45 puis > 50 pour les longs / miroir pour les shorts)
3. Bougie déclencheur haussière/baissière clôturant au-dessus/dessous de l'EMA9
4. Volume > 1.2× la moyenne
5. Histogramme MACD confirmant le momentum

### Gestion du risque
- **SL** = entrée ± 1.5 × ATR
- **TP1** = 1R (pour sortie partielle si vous tradez réellement)
- **TP2** = 2R (objectif principal)
- Signal émis uniquement si R:R ≥ 1.5

---

## Architecture

```
scalping-bot/
├── strategy/
│   ├── config.py          # Tous les paramètres (variables d'env)
│   ├── indicators.py      # EMA, VWAP, RSI, MACD, ATR, volume
│   └── strategy.py        # Logique de signal PARTAGÉE live + backtest
├── live/
│   ├── bot.py             # Boucle async principale
│   ├── discord_client.py  # Envoi des embeds Discord
│   └── signal_manager.py  # Anti-spam + cooldown
├── backtest/
│   ├── run_backtest.py    # Point d'entrée backtest
│   ├── engine.py          # Simulation barre-par-barre
│   ├── metrics.py         # Statistiques + graphiques
│   └── results/           # CSV + summary + equity_curve.png
```

**Principe DRY** : `strategy/strategy.py` contient l'unique source de vérité de la logique de signal. Le live et le backtest appellent exactement la même fonction `evaluate()`.

---

## Installation locale

```bash
# Cloner et installer
git clone <repo>
cd <repo>
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Configuration
cp .env.example .env
# Éditez .env et remplissez DISCORD_WEBHOOK_URL
```

---

## Créer un webhook Discord

1. Ouvrez votre serveur Discord → **Paramètres du serveur**
2. **Intégrations** → **Webhooks** → **Nouveau webhook**
3. Choisissez le canal cible, donnez un nom (ex: "Scalper Bot")
4. Copiez l'URL du webhook
5. Collez-la dans votre `.env` ou dans les variables d'env Railway

---

## Lancer le backtest en local

```bash
# Backtest sur 30 jours, 3 paires par défaut (BTC, ETH, SOL)
python -m backtest.run_backtest

# Backtest personnalisé
python -m backtest.run_backtest --symbols BTC/USDT,ETH/USDT --days 30

# Toutes les paires configurées
python -m backtest.run_backtest --symbols BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT,XRP/USDT --days 30
```

Les résultats sont dans `backtest/results/` :
- `trades.csv` — détail de tous les trades
- `summary.txt` — statistiques de performance
- `equity_curve.png` — courbe d'equity

---

## Déploiement sur Railway

### 1. Créer le projet Railway

1. Allez sur [railway.app](https://railway.app) et créez un nouveau projet
2. Connectez votre repository GitHub
3. Railway détectera le `Procfile` automatiquement

### 2. Configurer les variables d'environnement

Dans Railway → votre service → **Variables**, ajoutez :

| Variable | Valeur | Description |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | `https://discord.com/api/webhooks/...` | **Obligatoire** |
| `SYMBOLS` | `BTC/USDT,ETH/USDT,SOL/USDT` | Paires à surveiller |
| `SCAN_INTERVAL_SECONDS` | `15` | Fréquence d'analyse |
| `COOLDOWN_MINUTES` | `15` | Anti-spam par paire |
| `RISK_REWARD_MIN` | `1.5` | R:R minimum |
| `ATR_MULTIPLIER` | `1.5` | Taille du stop-loss |
| `MIN_ATR_PERCENT` | `0.05` | Filtre volatilité |

### 3. Déployer

Railway lance automatiquement `python -m live.bot` (défini dans le `Procfile`).

> **Note Railway** : Le service est configuré comme **worker** (pas un web service). Railway le garde en vie tant qu'il produit des logs. Le bot log toutes les 5 minutes même sans signal, ce qui suffit à prouver sa vitalité.

### 4. Surveiller les logs

Railway → votre service → **Logs** pour voir les scans et signaux en temps réel.

---

## Variables d'environnement complètes

Voir `.env.example` pour la liste complète avec descriptions.

---

## Dépendances

- `ccxt` — accès aux données publiques Binance Futures (klines)
- `pandas` + `numpy` — calcul des indicateurs
- `aiohttp` — webhooks Discord async
- `asyncio` — boucle concurrente multi-paires
- `python-dotenv` — config locale
- `matplotlib` — courbe d'equity backtest

**Aucune clé API requise** — le bot utilise uniquement les données publiques de Binance Futures USDT-M.
