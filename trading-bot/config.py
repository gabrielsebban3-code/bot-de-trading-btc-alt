"""
Configuration centrale du bot de trading.

Tous les paramètres modifiables (paires surveillées, timeframes, seuils des
indicateurs, anti-spam, etc.) sont regroupés ici pour pouvoir les ajuster
sans toucher au reste du code.
"""

# ---------------------------------------------------------------------------
# PAIRES À SURVEILLER
# ---------------------------------------------------------------------------
# Top 10 cryptos par capitalisation (perpétuels USDT sur Binance Futures)
# + 3 paires supplémentaires demandées (ASTR, HYPE, ONDO).
# Liste éditable : ajoute / retire simplement une ligne.
PAIRS = [
    "BTC/USDT",
    "ETH/USDT",
    "XRP/USDT",
    "BNB/USDT",
    "SOL/USDT",
    "DOGE/USDT",
    "ADA/USDT",
    "TRX/USDT",
    "LINK/USDT",
    "AVAX/USDT",
    # Paires supplémentaires toujours incluses
    "ASTR/USDT",
    "HYPE/USDT",
    "ONDO/USDT",
]

# ---------------------------------------------------------------------------
# TIMEFRAMES (confluence multi-timeframe)
# ---------------------------------------------------------------------------
# 1D  : biais macro (structure haussière / baissière)
# 4H  : tendance intermédiaire + zones OB / FVG
# 1H  : confirmation d'entrée + détection BOS / CHOCH
# 15m : timing d'entrée précis + affinage du SL
TIMEFRAMES = {
    "1d": "1d",
    "4h": "4h",
    "1h": "1h",
    "15m": "15m",
}

# Nombre de bougies récupérées par timeframe (assez pour EMA200 + structure)
CANDLE_LIMIT = 300

# Au moins N timeframes sur 4 doivent être alignés dans la même direction.
MIN_TIMEFRAMES_ALIGNED = 3

# ---------------------------------------------------------------------------
# SEUILS DES INDICATEURS
# ---------------------------------------------------------------------------
# EMA
EMA_PERIODS = (21, 50, 200)

# RSI (14)
RSI_PERIOD = 14
RSI_LONG_MIN, RSI_LONG_MAX = 40, 65   # momentum haussier sans surachat
RSI_SHORT_MIN, RSI_SHORT_MAX = 35, 60  # momentum baissier sans survente

# Volume : la bougie d'entrée doit dépasser X fois la moyenne sur N périodes
VOLUME_MA_PERIOD = 20
VOLUME_SPIKE_MULTIPLIER = 1.5

# ATR (14) — contexte volatilité uniquement
ATR_PERIOD = 14
# Seuils de classification de la volatilité, exprimés en % du prix (ATR/price)
ATR_LOW_THRESHOLD = 0.005   # < 0.5%  -> Low
ATR_HIGH_THRESHOLD = 0.015  # > 1.5%  -> High (entre les deux -> Medium)

# Liquidité : tolérance pour considérer deux extrêmes comme "égaux"
EQUAL_LEVEL_TOLERANCE = 0.0015  # 0.15%

# ---------------------------------------------------------------------------
# CALCUL SL / TP
# ---------------------------------------------------------------------------
SL_BUFFER = 0.002  # 0.2% de marge au-delà du wick de l'Order Block

# Ratios Risk/Reward cibles pour les 3 take-profits
RR_TP1 = 1.5
RR_TP2 = 2.5
RR_TP3 = 4.0

# Score de confluence minimal (sur 6) pour émettre un signal
MIN_CONFLUENCE_SCORE = 4

# ---------------------------------------------------------------------------
# ANTI-SPAM
# ---------------------------------------------------------------------------
# Ne pas renvoyer le même signal (paire + direction) avant N heures.
COOLDOWN_HOURS = 4

# ---------------------------------------------------------------------------
# BOUCLE DE SCAN
# ---------------------------------------------------------------------------
SCAN_INTERVAL_SECONDS = 300  # 5 minutes

# Délai d'attente en cas de rate-limit Binance
RATE_LIMIT_SLEEP_SECONDS = 10

# ---------------------------------------------------------------------------
# FICHIERS / LOGS
# ---------------------------------------------------------------------------
ALERTS_LOG_FILE = "alerts.log"
