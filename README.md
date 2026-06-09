# 🤖 Bot Intraday — Signaux Crypto (Discord)

Bot de **signaux de trading intraday** (pas de scalping) sur le **top 10 crypto**.
Il **n'a aucun accès à ton portefeuille** : il envoie uniquement des **alertes Discord**
quand un setup de qualité se présente.

> ⚠️ **Avertissement** : ce bot fournit des signaux à but informatif/éducatif.
> Ce n'est pas un conseil financier. Le score de « fiabilité » est une **confiance
> heuristique**, pas un taux de réussite garanti. Trade à tes risques.

---

## 📊 Stratégie

Le bot combine **deux modules indépendants** en **multi-timeframe** (tendance 1h + entrée 15m).

### Module 1 — EMA Trend Rider
- **Tendance (1h)** : EMA 21 vs EMA 55 + filtre **ADX > 25** (anti-range).
- **Entrée (15m)** : retracement (pullback) sur l'**EMA 21**, puis **rebond confirmé**
  par une bougie de clôture dans le sens de la tendance.
- **LONG & SHORT**.
- **Stop Loss** = ATR(14) × 1.5 · **Take Profit** = ratio **2:1**.

### Module 2 — Crash Bounce Detector ⚡ (type 2 février 2026)
Détecte un crash violent et achète le **rebond au fond de la mèche**,
**même en tendance baissière** (override) :
- Chute **≥ 5 %** sur 3 bougies 15m.
- **RSI < 25** (capitulation).
- **Volume × 3** par rapport à la moyenne.
- Longue **mèche basse** (rejet des bas prix).
- Bougie de **confirmation** clôturant au-dessus de 50 % du range du creux.
- **Stop Loss** sous le low de la mèche · **Take Profit** = retracement 50 % de la chute.

---

## 🔔 Exemple d'alerte Discord

```
⚡ CRASH BOUNCE — BTC/USDT LONG
💰 Entrée : 95,400.00      🛑 Stop Loss : 94,780.00      🎯 Take Profit : 97,300.00
📊 Fiabilité : 81%         ⚖️ Risk/Reward : 2.1:1        📉 Chute : -7.2% · volume x4.3
Bot Intraday
```

---

## 🚀 Installation locale (test)

```bash
# 1. Cloner le repo
git clone https://github.com/gabrielsebban3-code/bot-de-trading-btc-alt.git
cd bot-de-trading-btc-alt

# 2. Installer les dépendances
pip install -r requirements.txt

# 3. Configurer le webhook Discord
cp .env.example .env
#   puis édite .env et colle ton DISCORD_WEBHOOK_URL

# 4. Tester immédiatement (un scan, affichage console)
python test_signals.py

#   ... ou envoyer aussi le résultat sur Discord :
python test_signals.py --discord

# 5. Lancer le bot en continu
python main.py
```

---

## ☁️ Déploiement sur Railway

1. Sur [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
   → choisis `bot-de-trading-btc-alt`.
2. Railway détecte Python automatiquement (Nixpacks) et lance `python main.py`
   (voir `Procfile` / `railway.json`).
3. Va dans **Variables** et ajoute :
   - `DISCORD_WEBHOOK_URL` = ton webhook Discord (**obligatoire**)
   - `SEND_STARTUP_MESSAGE` = `true` (optionnel)
   - `RUN_ON_START` = `false` (optionnel ; `true` pour un scan immédiat au boot)
4. Déploie. Le bot tourne **24/7** et s'aligne automatiquement sur la clôture des bougies 15m.

> Le bot est un **worker** (pas de port web). Si Railway demande un service web,
> garde bien le type **worker**. Pas besoin d'exposer de port.

---

## ⚙️ Configuration

Tout est dans **`config.py`** (commenté). Les principaux réglages :

| Réglage | Défaut | Description |
|---|---|---|
| `SYMBOLS` | top 10 | Liste des paires USDT à surveiller |
| `EMA_FAST` / `EMA_SLOW` | 21 / 55 | EMA (Fibonacci) |
| `ADX_MIN` | 25 | Force de tendance minimale |
| `ATR_SL_MULTIPLIER` | 1.5 | Coefficient ATR pour le Stop Loss |
| `TP_RR_RATIO` | 2.0 | Ratio Take Profit (2:1) |
| `CRASH_DROP_PCT` | -0.05 | Seuil de chute du module Crash (-5 %) |
| `CRASH_RSI_MAX` | 25 | RSI de capitulation |
| `CRASH_VOLUME_SPIKE` | 3.0 | Spike de volume requis |
| `ALLOW_LONG` / `ALLOW_SHORT` | true | Activer/désactiver les directions |

---

## 🗂️ Structure du projet

```
bot-de-trading-btc-alt/
├── main.py                  # boucle principale (point d'entrée)
├── test_signals.py          # scan unique pour tester
├── config.py                # tous les réglages
├── requirements.txt         # dépendances Python
├── Procfile / railway.json  # déploiement Railway
├── .env.example             # modèle de configuration des secrets
└── src/
    ├── data_fetcher.py      # récupération OHLCV Binance (+ retry)
    ├── indicators.py        # EMA, RSI, ADX, ATR (calcul manuel)
    ├── strategy.py          # Module 1 — EMA Trend Rider
    ├── crash_bounce.py      # Module 2 — Crash Bounce Detector
    ├── reliability.py       # score de fiabilité (%)
    ├── signal_engine.py     # orchestration des modules
    ├── discord_notifier.py  # envoi des alertes Discord
    └── utils.py             # logging, formatage, anti-doublon
```

---

## 📡 Source de données

Données de marché publiques **Binance** (`/api/v3/klines`) — **aucune clé API requise**.
Si Binance est bloqué dans ta région, change `BINANCE_BASE_URL` dans les variables d'env.
