"""
Paramètres centralisés — Liquidity Sweep + MSS Strategy.
"""
import os
from dotenv import load_dotenv

load_dotenv()

# ─── Paires ───────────────────────────────────────────────────────────────────
SYMBOLS: list[str] = [
    s.strip() for s in os.getenv("SYMBOLS", "BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT,XRP/USDT").split(",")
]

# ─── Pivots (Swing Highs / Lows) ──────────────────────────────────────────────
# Nombre de bougies de chaque côté pour confirmer un pivot
SWING_LOOKBACK: int = int(os.getenv("SWING_LOOKBACK", "5"))

# ─── Sweep ────────────────────────────────────────────────────────────────────
# Fenêtre en arrière pour chercher un sweep récent (nb de bougies 1m)
SWEEP_LOOKBACK_BARS: int = int(os.getenv("SWEEP_LOOKBACK_BARS", "50"))
# Bornes de la fenêtre MSS après le sweep
MSS_MIN_BARS: int = int(os.getenv("MSS_MIN_BARS", "2"))
MSS_MAX_BARS: int = int(os.getenv("MSS_MAX_BARS", "25"))

# ─── Fibonacci / OTE ──────────────────────────────────────────────────────────
# Retracement 61.8% : limite la moins profonde de la zone OTE
FIB_OTE_UPPER: float = float(os.getenv("FIB_OTE_UPPER", "0.618"))
# Retracement 78.6% : limite la plus profonde de la zone OTE
FIB_OTE_LOWER: float = float(os.getenv("FIB_OTE_LOWER", "0.786"))

# ─── Risk management ──────────────────────────────────────────────────────────
# Buffer SL en % du prix (au-delà de la mèche du sweep)
SL_BUFFER_PCT: float = float(os.getenv("SL_BUFFER_PCT", "0.05"))
TP1_RR: float = float(os.getenv("TP1_RR", "2.0"))   # 1:2
TP2_RR: float = float(os.getenv("TP2_RR", "3.0"))   # 1:3
RISK_REWARD_MIN: float = float(os.getenv("RISK_REWARD_MIN", "2.0"))

# ─── Filtres qualité ──────────────────────────────────────────────────────────
SWEEP_VOLUME_MULTIPLIER: float = float(os.getenv("SWEEP_VOLUME_MULTIPLIER", "1.2"))
MSS_VOLUME_MULTIPLIER: float = float(os.getenv("MSS_VOLUME_MULTIPLIER", "1.2"))
MIN_ATR_PERCENT: float = float(os.getenv("MIN_ATR_PERCENT", "0.05"))

# ─── Bot live ─────────────────────────────────────────────────────────────────
SCAN_INTERVAL_SECONDS: int = int(os.getenv("SCAN_INTERVAL_SECONDS", "15"))
COOLDOWN_MINUTES: int = int(os.getenv("COOLDOWN_MINUTES", "240"))
MIN_SCORE: int = int(os.getenv("MIN_SCORE", "100"))
KLINES_LIMIT: int = 200

# ─── Backtest ─────────────────────────────────────────────────────────────────
FEE_PERCENT: float = float(os.getenv("FEE_PERCENT", "0.04"))
SLIPPAGE_PERCENT: float = float(os.getenv("SLIPPAGE_PERCENT", "0.02"))

# ─── Discord ──────────────────────────────────────────────────────────────────
DISCORD_WEBHOOK_URL: str = os.getenv("DISCORD_WEBHOOK_URL", "")
