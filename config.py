"""
Central configuration — edit this file to change pairs, thresholds, and timing.
"""

# ── Pairs ──────────────────────────────────────────────────────────────────────
# Top-10 by market cap (USDT perpetuals on Binance Futures) + 3 fixed extras
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
    # Fixed extras
    "ASTR/USDT",
    "HYPE/USDT",
    "ONDO/USDT",
]

# ── Timeframes ─────────────────────────────────────────────────────────────────
TIMEFRAMES = ["1d", "4h", "1h", "15m"]
# Minimum number of timeframes that must agree for a signal to fire
MIN_TF_CONFLUENCE = 3

# ── EMA ────────────────────────────────────────────────────────────────────────
EMA_FAST   = 21
EMA_MID    = 50
EMA_SLOW   = 200

# ── RSI ────────────────────────────────────────────────────────────────────────
RSI_PERIOD         = 14
RSI_LONG_MIN       = 40
RSI_LONG_MAX       = 65
RSI_SHORT_MIN      = 35
RSI_SHORT_MAX      = 60

# ── Volume ─────────────────────────────────────────────────────────────────────
VOLUME_MA_PERIOD   = 20
VOLUME_SPIKE_MULT  = 1.5       # entry candle volume must be > this × MA

# ── ATR ────────────────────────────────────────────────────────────────────────
ATR_PERIOD         = 14
ATR_LOW_THRESHOLD  = 0.01      # ATR/price ratio below this → "Low"
ATR_HIGH_THRESHOLD = 0.03      # ATR/price ratio above this → "High"

# ── SMC ────────────────────────────────────────────────────────────────────────
OB_LOOKBACK        = 50        # candles to look back for Order Blocks
FVG_MIN_GAP_PCT    = 0.001     # minimum gap size as fraction of price
LIQUIDITY_TOLERANCE = 0.0015   # 0.15% tolerance for equal highs/lows

# ── SL/TP ──────────────────────────────────────────────────────────────────────
SL_BUFFER_PCT      = 0.002     # 0.2% buffer beyond OB wick
TP1_RR             = 1.5
TP2_RR             = 2.5
TP3_RR             = 4.0

# ── Bot loop ───────────────────────────────────────────────────────────────────
SCAN_INTERVAL_SECONDS = 300    # how often to scan all pairs (5 minutes)
CANDLES_LIMIT         = 300    # number of candles to fetch per timeframe

# ── Exchange ───────────────────────────────────────────────────────────────────
EXCHANGE_ID    = "binanceusdm"  # ccxt id for Binance USDT-M Futures
