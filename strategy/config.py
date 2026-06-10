"""
Paramètres centralisés de la stratégie.
Toutes les constantes viennent d'ici — jamais en dur dans la logique.
Les variables d'env surchargent les valeurs par défaut.
"""
import os
from dotenv import load_dotenv

load_dotenv()

# ─── Paires à surveiller ───────────────────────────────────────────────────────
# 5 paires par défaut : les plus liquides = meilleure qualité de signal
SYMBOLS: list[str] = [
    s.strip()
    for s in os.getenv(
        "SYMBOLS",
        "BTC/USDT,ETH/USDT,SOL/USDT,BNB/USDT,XRP/USDT",
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
# ATR en % du close : marché trop calme → skip (augmenté pour plus de sélectivité)
MIN_ATR_PERCENT: float = float(os.getenv("MIN_ATR_PERCENT", "0.08"))

# ─── Déclencheur 1m ───────────────────────────────────────────────────────────
# Pullback : le low/high doit être dans cette zone % autour de l'EMA21 ou VWAP
# Plus petit = plus précis = moins de signaux
PULLBACK_PROXIMITY_PCT: float = float(os.getenv("PULLBACK_PROXIMITY_PCT", "0.10"))

# Fenêtre RSI lookback (en bougies 1m)
RSI_LOOKBACK: int = int(os.getenv("RSI_LOOKBACK", "5"))

# RSI plus strict : doit avoir touché 40 (long) ou 60 (short) pour être valide
RSI_OVERSOLD: float = float(os.getenv("RSI_OVERSOLD", "40"))
RSI_OVERBOUGHT: float = float(os.getenv("RSI_OVERBOUGHT", "60"))
RSI_CROSS_LEVEL: float = 50.0

# Volume : 1.5× minimum pour confirmer l'impulsion (plus strict que 1.2×)
VOLUME_MULTIPLIER: float = float(os.getenv("VOLUME_MULTIPLIER", "1.5"))

# Corps de bougie minimum : le corps doit représenter au moins N% de la range totale
# Filtre les dojis et les bougies indécises
MIN_BODY_RATIO: float = float(os.getenv("MIN_BODY_RATIO", "0.40"))

# ─── Gestion du risque ────────────────────────────────────────────────────────
ATR_MULTIPLIER: float = float(os.getenv("ATR_MULTIPLIER", "1.5"))
RISK_REWARD_MIN: float = float(os.getenv("RISK_REWARD_MIN", "1.5"))

# ─── Bot live ─────────────────────────────────────────────────────────────────
SCAN_INTERVAL_SECONDS: int = int(os.getenv("SCAN_INTERVAL_SECONDS", "15"))
# 4h de cooldown par paire → max ~6 signaux/paire/jour, en pratique 1-2
COOLDOWN_MINUTES: int = int(os.getenv("COOLDOWN_MINUTES", "240"))
# Score minimum 75/100 — seuls les setups vraiment propres passent
MIN_SCORE: int = int(os.getenv("MIN_SCORE", "75"))

KLINES_LIMIT: int = 200

# ─── Frais & slippage (backtest) ──────────────────────────────────────────────
FEE_PERCENT: float = float(os.getenv("FEE_PERCENT", "0.04"))
SLIPPAGE_PERCENT: float = float(os.getenv("SLIPPAGE_PERCENT", "0.02"))

# ─── Discord ──────────────────────────────────────────────────────────────────
DISCORD_WEBHOOK_URL: str = os.getenv("DISCORD_WEBHOOK_URL", "")
