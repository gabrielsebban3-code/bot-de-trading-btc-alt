"""
config.py
=========
Central configuration for the SMC trading-signal bot:
pairs, timeframes, indicator parameters and signal thresholds.

Tweak values here without touching the core logic.
"""

import os

from dotenv import load_dotenv

load_dotenv()

# --------------------------------------------------------------------------- #
# Credentials / secrets (loaded from .env)
# --------------------------------------------------------------------------- #
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")
# Read-only key. Public market data does NOT require a key, but supplying one
# raises the rate limits.
BINANCE_API_KEY = os.getenv("BINANCE_API_KEY", "")
BINANCE_API_SECRET = os.getenv("BINANCE_API_SECRET", "")

# --------------------------------------------------------------------------- #
# Pairs
# --------------------------------------------------------------------------- #
# How many of the top Binance Futures pairs (by 24h quote volume) to monitor.
TOP_N_PAIRS = 10

# Pairs that are ALWAYS monitored, regardless of their volume ranking.
# Use the unified "BASE/QUOTE" notation; the exchange layer maps it to the
# correct Binance USDT-margined perpetual symbol.
FIXED_PAIRS = [
    "ASTR/USDT",
    "HYPE/USDT",
    "ONDO/USDT",
]

# Only consider USDT-margined perpetuals when ranking by volume.
QUOTE_ASSET = "USDT"

# --------------------------------------------------------------------------- #
# Timeframes (multi-timeframe confluence)
# --------------------------------------------------------------------------- #
#   1D  -> macro bias
#   4H  -> intermediate trend + OB / FVG zones
#   1H  -> entry confirmation + BOS / CHOCH
#   15m -> precise entry timing + SL refinement
TIMEFRAMES = {
    "1d": "1d",
    "4h": "4h",
    "1h": "1h",
    "15m": "15m",
}

# Number of candles to pull per timeframe (enough history for EMA200 + structure).
CANDLE_LIMIT = 300

# Minimum number of aligned timeframes (out of 4) required for a valid signal.
MIN_TIMEFRAMES_ALIGNED = 3

# --------------------------------------------------------------------------- #
# Indicator parameters
# --------------------------------------------------------------------------- #
EMA_PERIODS = (21, 50, 200)
RSI_PERIOD = 14
ATR_PERIOD = 14
VOLUME_MA_PERIOD = 20

# RSI momentum windows
RSI_LONG_MIN, RSI_LONG_MAX = 40, 65
RSI_SHORT_MIN, RSI_SHORT_MAX = 35, 60

# Volume spike: entry candle volume must exceed this multiple of the MA volume.
VOLUME_SPIKE_MULTIPLIER = 1.5

# Liquidity sweep: equal highs / lows tolerance (0.15%).
EQUAL_LEVEL_TOLERANCE = 0.0015

# Impulse detection: a move is considered an "impulse" when its body exceeds
# this fraction of the recent average range (used for OB / BOS detection).
IMPULSE_BODY_FACTOR = 1.2

# ATR volatility classification thresholds, expressed as ATR / price (percent).
ATR_LOW_THRESHOLD = 0.010     # < 1.0%  -> Low
ATR_HIGH_THRESHOLD = 0.025    # > 2.5%  -> High  (between => Medium)

# --------------------------------------------------------------------------- #
# Signal scoring
# --------------------------------------------------------------------------- #
# The confluence score is out of 6 (one point per core condition).
# A signal is only emitted at or above this score.
MIN_CONFLUENCE_SCORE = 4

# Stop-loss buffer beyond the order-block wick (0.2%).
SL_BUFFER = 0.002

# Take-profit risk/reward multiples.
TP_RR = (1.5, 2.5, 4.0)

# --------------------------------------------------------------------------- #
# Scheduling / anti-spam
# --------------------------------------------------------------------------- #
SCAN_INTERVAL_SECONDS = 5 * 60          # scan loop cadence (5 minutes)
ALERT_COOLDOWN_SECONDS = 4 * 60 * 60    # do not repeat pair+direction within 4h

# Pause after hitting a Binance rate limit before retrying.
RATE_LIMIT_BACKOFF_SECONDS = 10

# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #
ALERTS_LOG_FILE = "alerts.log"
