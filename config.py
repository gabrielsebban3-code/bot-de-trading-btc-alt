"""
Configuration centrale du Bot Intraday.

Toutes les valeurs sont modifiables ici. Les secrets (webhook Discord)
sont lus depuis les variables d'environnement (fichier .env en local,
variables Railway en production).
"""

import os
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# DISCORD
# ---------------------------------------------------------------------------
# URL du webhook Discord. NE JAMAIS mettre la vraie URL en dur ici.
# En local : la mettre dans un fichier .env -> DISCORD_WEBHOOK_URL=...
# Sur Railway : la mettre dans les variables d'environnement du projet.
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")

# Envoyer un message au démarrage du bot pour confirmer qu'il tourne.
SEND_STARTUP_MESSAGE = os.getenv("SEND_STARTUP_MESSAGE", "true").lower() == "true"

# ---------------------------------------------------------------------------
# SOURCE DE DONNÉES (Binance — données publiques, aucune clé API nécessaire)
# ---------------------------------------------------------------------------
# Si Binance est bloqué dans ta région, tu peux changer cette URL de base
# (ex: "https://api.binance.us" ou un autre miroir compatible).
BINANCE_BASE_URL = os.getenv("BINANCE_BASE_URL", "https://api.binance.com")

# Ordre des exchanges essayés pour récupérer les données (fallback automatique).
# Le bot garde le premier qui répond. Binance bloque souvent les IP cloud (US),
# d'où les alternatives. Modifiable via la variable d'env DATA_PROVIDERS
# (liste séparée par des virgules, ex: "bybit,okx,kucoin,binance").
DATA_PROVIDERS = [
    p.strip().lower()
    for p in os.getenv("DATA_PROVIDERS", "binance,bybit,okx,kucoin").split(",")
    if p.strip()
]

# Top 10 crypto (paires USDT liquides sur Binance).
# Modifie librement cette liste. Note : MATIC est devenu POL sur Binance.
SYMBOLS = [
    "BTCUSDT",
    "ETHUSDT",
    "BNBUSDT",
    "SOLUSDT",
    "XRPUSDT",
    "ADAUSDT",
    "AVAXUSDT",
    "DOGEUSDT",
    "DOTUSDT",
    "LINKUSDT",
]

# Timeframes utilisés (multi-timeframe).
TF_TREND = "1h"     # détermine la tendance de fond
TF_ENTRY = "15m"    # détecte le point d'entrée

# Nombre de bougies récupérées par requête (assez pour calculer les indicateurs).
CANDLES_LIMIT = 200

# ---------------------------------------------------------------------------
# INDICATEURS
# ---------------------------------------------------------------------------
EMA_FAST = 21       # EMA rapide (Fibonacci)
EMA_SLOW = 55       # EMA lente (Fibonacci)
RSI_PERIOD = 14
ADX_PERIOD = 14
ATR_PERIOD = 14

# ---------------------------------------------------------------------------
# MODULE 1 — EMA TREND RIDER
# ---------------------------------------------------------------------------
ADX_MIN = 25.0              # tendance considérée "forte" au-dessus de ce seuil
ATR_SL_MULTIPLIER = 1.5     # Stop Loss = entrée -/+ ATR * ce coefficient
TP_RR_RATIO = 2.0           # Take Profit = 2x le risque (ratio 2:1)

# Tolérance du pullback : la mèche doit revenir à moins de
# (PULLBACK_ATR * ATR) de l'EMA21 pour valider le retracement.
PULLBACK_ATR = 0.30

# Direction(s) autorisée(s) pour le module tendance.
ALLOW_LONG = True
ALLOW_SHORT = True

# ---------------------------------------------------------------------------
# MODULE 2 — CRASH BOUNCE DETECTOR (rebond de mèche / "wick hunter")
# ---------------------------------------------------------------------------
CRASH_ENABLED = True
CRASH_DROP_PCT = -0.05          # -5% de chute pour déclencher la détection
CRASH_LOOKBACK = 3              # sur 3 bougies 15m
CRASH_RSI_MAX = 25.0            # RSI en capitulation extrême
CRASH_VOLUME_SPIKE = 3.0        # volume >= 3x la moyenne
CRASH_VOLUME_MA = 20            # période de la moyenne de volume
CRASH_WICK_MIN_RATIO = 0.40     # la mèche basse doit faire >= 40% du range de la bougie
CRASH_CONFIRM_MID = 0.50        # bougie de confirmation clôture au-dessus de 50% du range du creux
CRASH_OVERRIDE_TREND = True     # fonctionne même si la tendance 1h est baissière
CRASH_SL_ATR_BUFFER = 0.25      # SL = low de la mèche - (ATR * buffer)
# Ratio risk/reward minimum pour envoyer une alerte crash. Sous ce seuil, on
# risque trop par rapport au gain potentiel -> on n'alerte pas. Avec stop sous
# la mèche + TP à 50%, n'entrer que sur les rebonds au RR favorable.
CRASH_MIN_RR = 1.0

# ---------------------------------------------------------------------------
# BOUCLE / EXÉCUTION
# ---------------------------------------------------------------------------
# Le bot s'aligne sur la clôture des bougies 15m. Ce délai (en secondes)
# est ajouté après la clôture pour être sûr que la bougie est finalisée
# côté Binance avant l'analyse.
POST_CLOSE_BUFFER_SEC = 15

# Délai entre deux requêtes symboles (anti rate-limit Binance), en secondes.
REQUEST_SPACING_SEC = 0.25

# Mode test : si true, lance une analyse immédiate au démarrage sans attendre
# la prochaine clôture 15m (pratique pour vérifier que tout marche).
RUN_ON_START = os.getenv("RUN_ON_START", "false").lower() == "true"
