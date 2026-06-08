"""
Paramètres centralisés de la stratégie.
Toutes les constantes viennent d'ici — jamais en dur dans la logique.
Les variables d'env surchargent les valeurs par défaut.
"""
import os
from dotenv import load_dotenv

load_dotenv()

# ─── Paires à surveiller ───────────────────────────────────────────────────────
SYMBOLS: list[str] = [
    s.strip()
    for s in os.getenv(
        "SYMBOLS",
        "BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT,XRP/USDT,"
        "ADA/USDT,DOGE/USDT,AVAX/USDT,LINK/USDT,DOT/USDT,"
        "MATIC/USDT,LTC/USDT,UNI/USDT,ATOM/USDT,FIL/USDT",
    ).split(",")
]

# ─── Indicateurs ──────────────────────────────────────────────────────────────
EMA_FAST: int = 9
EMA_MID: int = 21
EMA_SLOW: int = 50
RSI_PERIOD: int = 14
MACD_FAST: int = 12
MACD_SLOW: int = 26
MACD_SIGNAL: int = 9
ATR_PERIOD: int = 14
VOLUME_AVG_PERIOD: int = 20

# ─── Filtres de biais (5m) ────────────────────────────────────────────────────
# ATR en % du close : en-dessous de ce seuil, marché trop calme → skip
MIN_ATR_PERCENT: float = float(os.getenv("MIN_ATR_PERCENT", "0.05"))

# ─── Déclencheur 1m ───────────────────────────────────────────────────────────
# Zone de "proximité" de l'EMA21 ou VWAP exprimée en % du close
PULLBACK_PROXIMITY_PCT: float = float(os.getenv("PULLBACK_PROXIMITY_PCT", "0.15"))

# Fenêtre (en bougies 1m) dans laquelle chercher le RSI retourné
RSI_LOOKBACK: int = int(os.getenv("RSI_LOOKBACK", "5"))

# Seuils RSI pour le rebond
RSI_OVERSOLD: float = float(os.getenv("RSI_OVERSOLD", "45"))   # long : croise sous puis au-dessus de 50
RSI_OVERBOUGHT: float = float(os.getenv("RSI_OVERBOUGHT", "55"))  # short : croise au-dessus puis sous 50
RSI_CROSS_LEVEL: float = 50.0

# Volume minimum : N × volume moyen pour confirmer l'impulsion
VOLUME_MULTIPLIER: float = float(os.getenv("VOLUME_MULTIPLIER", "1.2"))

# ─── Gestion du risque ────────────────────────────────────────────────────────
ATR_MULTIPLIER: float = float(os.getenv("ATR_MULTIPLIER", "1.5"))   # SL = entry ± ATR * multiplicateur
RISK_REWARD_MIN: float = float(os.getenv("RISK_REWARD_MIN", "1.5"))  # R:R minimum pour émettre le signal

# ─── Bot live ─────────────────────────────────────────────────────────────────
SCAN_INTERVAL_SECONDS: int = int(os.getenv("SCAN_INTERVAL_SECONDS", "15"))
COOLDOWN_MINUTES: int = int(os.getenv("COOLDOWN_MINUTES", "15"))

# Nombre de bougies à récupérer pour les calculs (laisser de la marge pour les lookback)
KLINES_LIMIT: int = 200

# ─── Frais & slippage (backtest) ──────────────────────────────────────────────
FEE_PERCENT: float = float(os.getenv("FEE_PERCENT", "0.04"))        # taker, par côté
SLIPPAGE_PERCENT: float = float(os.getenv("SLIPPAGE_PERCENT", "0.02"))  # par côté

# ─── Discord ──────────────────────────────────────────────────────────────────
DISCORD_WEBHOOK_URL: str = os.getenv("DISCORD_WEBHOOK_URL", "")
