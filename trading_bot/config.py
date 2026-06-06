# Configuration principale du bot de trading SMC
# Modifier ces paramètres selon vos besoins

# Paires Binance Futures USDT perpetual à surveiller
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
    "ASTR/USDT",
    "HYPE/USDT",
    "ONDO/USDT",
]

# Intervalle de scan en secondes (15 minutes)
SCAN_INTERVAL = 900

# Timeframes utilisés pour l'analyse multi-timeframe
TIMEFRAMES = {
    "1d": "1d",
    "4h": "4h",
    "1h": "1h",
    "15m": "15m",
}

# Nombre de bougies à récupérer par timeframe
CANDLES_LIMIT = 200

# Paramètres EMA
EMA_SHORT = 21
EMA_MID = 50
EMA_LONG = 200

# Paramètre RSI
RSI_PERIOD = 14
RSI_LONG_MIN = 40
RSI_LONG_MAX = 65
RSI_SHORT_MIN = 35
RSI_SHORT_MAX = 60

# Paramètre ATR
ATR_PERIOD = 14

# Seuils de volatilité ATR (en % du prix)
ATR_LOW_THRESHOLD = 0.5    # < 0.5% = Low
ATR_HIGH_THRESHOLD = 1.5   # > 1.5% = High

# Multiplicateur volume pour spike
VOLUME_SPIKE_MULTIPLIER = 1.5
VOLUME_AVG_PERIOD = 20

# Tolérance pour equal highs/lows (liquidity sweeps) en %
LIQUIDITY_TOLERANCE = 0.0015  # 0.15%

# Score de confluence minimum pour déclencher un signal
MIN_CONFLUENCE_SCORE = 4  # sur 6 conditions

# Nombre minimum de timeframes alignés
MIN_TF_ALIGNED = 3  # sur 4

# Délai anti-doublon en secondes (4 heures)
SIGNAL_COOLDOWN = 4 * 3600

# Buffer SL en pourcentage
SL_BUFFER = 0.002  # 0.2%

# Ratios Risk/Reward pour les 3 niveaux de TP
TP1_RR = 1.5
TP2_RR = 2.5
TP3_RR = 4.0

# Nombre de tentatives pour les requêtes API
API_RETRY_COUNT = 3
API_RETRY_DELAY = 5  # secondes entre chaque tentative
