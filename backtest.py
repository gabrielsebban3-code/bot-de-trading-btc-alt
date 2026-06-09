"""
Backtest du Bot Intraday — 4 mois, 1000€ de capital de départ.

Usage :
    python backtest.py                  # données réelles (Binance/Bybit/OKX/KuCoin)
    python backtest.py --synthetic      # données synthétiques (si exchange bloqué)
    python backtest.py --discord        # envoie le rapport sur Discord

Hypothèses du backtest :
    - Capital initial : 1000 € (traité comme 1000 USDT, 1:1)
    - Risque par trade : 2% du capital courant (position sizing dynamique)
    - Stop Loss : ATR x 1.5 (calculé par la stratégie)
    - Take Profit : ratio 2:1
    - Commission : 0.1% par côté (0.2% aller-retour), type taker Binance/Bybit
    - Un seul trade à la fois par symbole
    - Pas de levier
    - SL et TP évalués sur les bougies suivantes (prix high/low de la bougie)
    - En cas de gap (SL et TP dans la même bougie), le SL prime (scénario conservateur)

⚠️  Ce backtest est indicatif. Les performances passées ne garantissent pas
    les résultats futurs. Les données synthétiques ne reproduisent pas
    parfaitement la réalité du marché.
"""

import sys
import time
import logging
import argparse
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta

import numpy as np
import pandas as pd

import config
from src import indicators as ind
from src.utils import setup_logging, fmt_price

logger = logging.getLogger("backtest")

# ---------------------------------------------------------------------------
# Paramètres du backtest
# ---------------------------------------------------------------------------
CAPITAL_INITIAL = 1000.0     # €/USDT
RISK_PCT        = 0.02       # 2% par trade
COMMISSION_PCT  = 0.001      # 0.1% par côté
BACKTEST_DAYS   = 120        # ~4 mois


# ---------------------------------------------------------------------------
# Données synthétiques réalistes (régimes de marché)
# ---------------------------------------------------------------------------
def _make_ohlcv(prices: np.ndarray, base_vol: float = 1000.0) -> pd.DataFrame:
    """Construit un DataFrame OHLCV à partir d'une série de prix de clôture."""
    n = len(prices)
    noise = np.abs(np.random.normal(0, 1, n))
    spread = prices * 0.002 + noise * prices * 0.001
    opens  = np.roll(prices, 1); opens[0] = prices[0]
    highs  = np.maximum(opens, prices) + spread * 0.5
    lows   = np.minimum(opens, prices) - spread * 0.5
    # Volume : plus élevé lors des moves forts
    vol_factor = 1 + 3 * np.abs(np.diff(np.log(prices), prepend=np.log(prices[0])))
    volumes = base_vol * vol_factor * np.abs(np.random.normal(1, 0.3, n))
    return pd.DataFrame({"open": opens, "high": highs, "low": lows,
                         "close": prices, "volume": volumes})


def generate_synthetic(symbol: str, seed: int = 42) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Génère 4 mois de données 1h et 15m avec 4 régimes :
      - Phase 1 (25j)  : range / consolidation (peu de signaux)
      - Phase 2 (45j)  : tendance haussière forte
      - Phase 3 (5j)   : crash violent (-25%) puis rebond  ← type 2 fév 2026
      - Phase 4 (45j)  : recovery + tendance haussière modérée
    """
    rng = np.random.default_rng(seed)

    # Prix de départ réalistes selon le symbole
    starts = {"BTCUSDT": 94000, "ETHUSDT": 3200, "BNBUSDT": 580, "SOLUSDT": 165,
              "XRPUSDT": 0.55, "ADAUSDT": 0.42, "AVAXUSDT": 35, "DOGEUSDT": 0.18,
              "DOTUSDT": 7.5, "LINKUSDT": 14}
    p0 = starts.get(symbol, 100.0)

    # Volatilité horaire (annuelle / sqrt(8760))
    sigma_h = {"BTCUSDT": 0.65, "ETHUSDT": 0.75, "BNBUSDT": 0.70, "SOLUSDT": 0.90,
               "XRPUSDT": 0.80, "ADAUSDT": 0.85, "AVAXUSDT": 0.90, "DOGEUSDT": 0.95,
               "DOTUSDT": 0.85, "LINKUSDT": 0.80}.get(symbol, 0.75) / np.sqrt(8760)

    total_1h = BACKTEST_DAYS * 24
    prices_1h = np.zeros(total_1h)
    prices_1h[0] = p0
    t = 0

    def gbm(n, mu_annual, vol_h, p_start):
        mu_h = mu_annual / 8760
        ret = rng.normal(mu_h, vol_h, n)
        return p_start * np.cumprod(1 + ret)

    # Phase 1 : range (25j)
    n1 = 25 * 24
    prices_1h[1:n1] = gbm(n1 - 1, 0.0, sigma_h * 0.7, p0)
    t += n1

    # Phase 2 : bull trend (45j)
    n2 = 45 * 24
    prices_1h[t:t + n2] = gbm(n2, 0.8, sigma_h, prices_1h[t - 1])
    t += n2

    # Phase 3 : crash (-25% en 5j) puis micro-rebond
    n3 = 5 * 24
    crash_path = gbm(n3, -15.0, sigma_h * 3.0, prices_1h[t - 1])
    crash_path = np.minimum(crash_path, prices_1h[t - 1])  # force la baisse
    prices_1h[t:t + n3] = crash_path
    t += n3

    # Phase 4 : recovery (45j)
    n4 = total_1h - t
    prices_1h[t:] = gbm(n4, 0.6, sigma_h * 1.2, prices_1h[t - 1])

    # Clamp : pas de prix négatifs ou nuls
    prices_1h = np.maximum(prices_1h, p0 * 0.01)

    # 1h DataFrame
    start_dt = datetime(2026, 2, 1, tzinfo=timezone.utc)
    df_1h = _make_ohlcv(prices_1h, base_vol=p0 * 10)
    df_1h["open_time"]  = pd.date_range(start_dt, periods=total_1h, freq="1h", tz="UTC")
    df_1h["close_time"] = df_1h["open_time"] + pd.Timedelta(hours=1)

    # Interpole 15m depuis le 1h (chaque 1h -> 4 bougies 15m)
    total_15m = total_1h * 4
    prices_15m = np.zeros(total_15m)
    for i in range(total_1h - 1):
        seg = gbm(4, 0, sigma_h / 2, prices_1h[i])
        seg[-1] = prices_1h[i + 1]
        prices_15m[i * 4:(i + 1) * 4] = seg
    prices_15m[(total_1h - 1) * 4:] = prices_1h[-1]
    prices_15m = np.maximum(prices_15m, p0 * 0.01)

    df_15m = _make_ohlcv(prices_15m, base_vol=p0 * 2.5)
    df_15m["open_time"]  = pd.date_range(start_dt, periods=total_15m, freq="15min", tz="UTC")
    df_15m["close_time"] = df_15m["open_time"] + pd.Timedelta(minutes=15)

    return df_1h, df_15m


# ---------------------------------------------------------------------------
# Récupération données réelles (multi-exchange avec fallback)
# ---------------------------------------------------------------------------
def fetch_real(symbol: str) -> tuple[pd.DataFrame | None, pd.DataFrame | None]:
    from src import data_fetcher
    limit = BACKTEST_DAYS * 24 + 10

    logger.info("Fetch réel %s ...", symbol)
    df_1h  = data_fetcher.fetch_ohlcv(symbol, "1h",  min(limit, 1000))
    time.sleep(0.3)
    df_15m = data_fetcher.fetch_ohlcv(symbol, "15m", min(limit * 4, 1000))

    if df_1h is None or df_15m is None or len(df_1h) < 100 or len(df_15m) < 200:
        return None, None
    return df_1h, df_15m


# ---------------------------------------------------------------------------
# Moteur de simulation trade par trade
# ---------------------------------------------------------------------------
@dataclass
class Trade:
    symbol:    str
    mode:      str      # TREND | CRASH
    direction: str      # LONG | SHORT
    entry_idx: int
    entry_price: float
    sl:          float
    tp:          float
    risk_eur:    float
    exit_idx:    int   = -1
    exit_price:  float = 0.0
    result:      str   = ""   # WIN | LOSS | OPEN
    pnl_eur:     float = 0.0


@dataclass
class Portfolio:
    capital: float = CAPITAL_INITIAL
    trades:  list  = field(default_factory=list)
    peak:    float = CAPITAL_INITIAL


COOLDOWN_CANDLES = 48  # bougies 15m de silence après un trade (= 12h min entre trades)


def _simulate_symbol(symbol: str, df_1h: pd.DataFrame, df_15m: pd.DataFrame) -> list[Trade]:
    """Rejoue la stratégie bougie par bougie et collecte les trades."""
    from src import strategy, crash_bounce

    df_1h_e  = ind.enrich(df_1h,  config.EMA_FAST, config.EMA_SLOW,
                           config.RSI_PERIOD, config.ADX_PERIOD, config.ATR_PERIOD)
    df_15m_e = ind.enrich(df_15m, config.EMA_FAST, config.EMA_SLOW,
                           config.RSI_PERIOD, config.ADX_PERIOD, config.ATR_PERIOD)

    trades: list[Trade] = []
    open_trade: Trade | None = None
    cooldown_until = 0          # index 15m à partir duquel on peut reprendre
    min_bars = max(config.EMA_SLOW + 10, 60)

    for i15 in range(min_bars, len(df_15m_e)):
        t15 = df_15m_e.iloc[i15]["open_time"]
        mask_1h = df_1h_e["open_time"] <= t15
        i1h = mask_1h.sum() - 1
        if i1h < min_bars:
            continue

        candle = df_15m_e.iloc[i15]

        # --- Gestion de la position ouverte ---
        if open_trade is not None:
            if open_trade.direction == "LONG":
                if candle["low"] <= open_trade.sl:
                    open_trade.result = "LOSS"
                    open_trade.exit_price = open_trade.sl
                    open_trade.exit_idx = i15
                elif candle["high"] >= open_trade.tp:
                    open_trade.result = "WIN"
                    open_trade.exit_price = open_trade.tp
                    open_trade.exit_idx = i15
            else:  # SHORT
                if candle["high"] >= open_trade.sl:
                    open_trade.result = "LOSS"
                    open_trade.exit_price = open_trade.sl
                    open_trade.exit_idx = i15
                elif candle["low"] <= open_trade.tp:
                    open_trade.result = "WIN"
                    open_trade.exit_price = open_trade.tp
                    open_trade.exit_idx = i15

            if open_trade.result in ("WIN", "LOSS"):
                trades.append(open_trade)
                cooldown_until = i15 + COOLDOWN_CANDLES
                open_trade = None

        # --- Cherche un nouveau signal ---
        if open_trade is None and i15 >= cooldown_until:
            slice_1h  = df_1h_e.iloc[:i1h + 1].reset_index(drop=True)
            slice_15m = df_15m_e.iloc[:i15 + 1].reset_index(drop=True)
            sig = crash_bounce.check(symbol, slice_1h, slice_15m)
            if sig is None:
                sig = strategy.check(symbol, slice_1h, slice_15m)
            if sig is not None:
                open_trade = Trade(
                    symbol=symbol, mode=sig["mode"],
                    direction=sig["direction"],
                    entry_idx=i15, entry_price=sig["entry"],
                    sl=sig["stop_loss"], tp=sig["take_profit"],
                    risk_eur=0.0,
                )

    # Trade encore ouvert en fin de période → clôture au dernier prix (mark-to-market)
    if open_trade is not None:
        last = df_15m_e.iloc[-1]
        open_trade.result = "OPEN"
        open_trade.exit_price = float(last["close"])
        open_trade.exit_idx = len(df_15m_e) - 1
        trades.append(open_trade)

    return trades


def _apply_sizing(all_trades: list[Trade]) -> Portfolio:
    """
    Applique le position sizing dynamique (2% du capital) sur les trades triés.
    Calcule le P&L ici (pas dans _simulate_symbol) pour avoir le capital à jour.
    """
    port = Portfolio()
    sorted_trades = sorted(all_trades, key=lambda t: t.entry_idx)
    for t in sorted_trades:
        risk = port.capital * RISK_PCT
        t.risk_eur = risk
        # qty = nombre d'unités achetées (taille de position)
        qty = risk / max(abs(t.entry_price - t.sl), 1e-9)
        # Commission aller-retour sur le notionnel
        commission = qty * (t.entry_price + (t.exit_price if t.result != "OPEN" else t.entry_price)) * COMMISSION_PCT

        if t.result == "WIN":
            gross = qty * abs(t.tp - t.entry_price)
            t.pnl_eur = gross - commission
        elif t.result == "LOSS":
            gross = qty * abs(t.entry_price - t.sl)
            t.pnl_eur = -(gross + commission)
        else:  # OPEN : mark-to-market
            move = t.exit_price - t.entry_price
            if t.direction == "SHORT":
                move = -move
            t.pnl_eur = qty * move - commission

        port.capital = max(port.capital + t.pnl_eur, 0.01)
        if port.capital > port.peak:
            port.peak = port.capital
        port.trades.append(t)
    return port


# ---------------------------------------------------------------------------
# Rapport
# ---------------------------------------------------------------------------
def _report(port: Portfolio, use_synthetic: bool) -> str:
    trades = [t for t in port.trades if t.result in ("WIN", "LOSS")]
    if not trades:
        return "Aucun trade finalisé."

    wins   = [t for t in trades if t.result == "WIN"]
    losses = [t for t in trades if t.result == "LOSS"]
    opens  = [t for t in port.trades if t.result == "OPEN"]

    total_trades = len(trades)
    win_rate = len(wins) / total_trades * 100 if total_trades else 0
    total_pnl = sum(t.pnl_eur for t in trades)
    final_cap = CAPITAL_INITIAL + total_pnl
    roi = total_pnl / CAPITAL_INITIAL * 100
    max_dd = (port.peak - min(CAPITAL_INITIAL + sum(t.pnl_eur for t in trades[:i+1])
                              for i in range(len(trades)))) / port.peak * 100 if trades else 0

    by_mode = {}
    for t in trades:
        by_mode.setdefault(t.mode, []).append(t)

    data_label = "⚠️ DONNÉES SYNTHÉTIQUES" if use_synthetic else "✅ DONNÉES RÉELLES"

    lines = [
        "=" * 56,
        "   BOT INTRADAY — BACKTEST 4 MOIS (1 000 €)",
        f"   {data_label}",
        "=" * 56,
        f"  Capital initial   : {fmt_price(CAPITAL_INITIAL)} €",
        f"  Capital final     : {fmt_price(final_cap)} €",
        f"  P&L total         : {'+' if total_pnl >= 0 else ''}{fmt_price(total_pnl)} €",
        f"  ROI               : {'+' if roi >= 0 else ''}{roi:.1f}%",
        f"  Drawdown max      : -{max_dd:.1f}%",
        "-" * 56,
        f"  Trades finalisés  : {total_trades}  ({len(opens)} encore ouverts ignorés)",
        f"  Victoires         : {len(wins)} ({win_rate:.1f}%)",
        f"  Défaites          : {len(losses)} ({100 - win_rate:.1f}%)",
        f"  Gain moyen/win    : +{fmt_price(sum(t.pnl_eur for t in wins)/max(len(wins),1))} €",
        f"  Perte moy/loss    : -{fmt_price(abs(sum(t.pnl_eur for t in losses)/max(len(losses),1)))} €",
    ]

    for mode, mt in by_mode.items():
        mw = sum(1 for t in mt if t.result == "WIN")
        lines.append(f"  Module {mode:<6}     : {len(mt)} trades, {mw/len(mt)*100:.0f}% WR")

    lines += [
        "-" * 56,
        "  Par symbole (top 5 P&L) :",
    ]
    sym_pnl = {}
    for t in trades:
        sym_pnl.setdefault(t.symbol, []).append(t.pnl_eur)
    sym_sorted = sorted(sym_pnl.items(), key=lambda x: sum(x[1]), reverse=True)
    for sym, pnls in sym_sorted[:5]:
        tot = sum(pnls)
        lines.append(f"    {sym:<12} {'+' if tot>=0 else ''}{fmt_price(tot):>8} € "
                     f"({len(pnls)} trades)")
    lines.append("=" * 56)

    if use_synthetic:
        lines += [
            "",
            "  ⚠️  Résultats sur données SIMULÉES (régimes synthétiques).",
            "     Lance 'python backtest.py' chez toi (avec accès internet)",
            "     pour obtenir les vrais résultats sur données historiques.",
        ]

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    setup_logging()
    parser = argparse.ArgumentParser()
    parser.add_argument("--synthetic", action="store_true",
                        help="Utiliser des données synthétiques (pas d'accès réseau requis)")
    parser.add_argument("--discord", action="store_true",
                        help="Envoyer le rapport sur Discord")
    args = parser.parse_args()

    use_synthetic = args.synthetic
    all_trades: list[Trade] = []

    logger.info("Backtest sur %d symboles — %d jours", len(config.SYMBOLS), BACKTEST_DAYS)

    for i, symbol in enumerate(config.SYMBOLS):
        logger.info("[%d/%d] %s ...", i + 1, len(config.SYMBOLS), symbol)

        if not use_synthetic:
            df_1h, df_15m = fetch_real(symbol)
            if df_1h is None:
                logger.warning("%s : données réelles indisponibles → synthétiques.", symbol)
                use_synthetic_fallback = True
                df_1h, df_15m = generate_synthetic(symbol, seed=i * 7)
            else:
                use_synthetic_fallback = False
        else:
            df_1h, df_15m = generate_synthetic(symbol, seed=i * 7)
            use_synthetic_fallback = True

        trades = _simulate_symbol(symbol, df_1h, df_15m)
        logger.info("  %s : %d trade(s) générés", symbol, len(trades))
        all_trades.extend(trades)

    if not all_trades:
        logger.warning("Aucun trade généré sur aucun symbole.")
        return

    port = _apply_sizing(all_trades)
    report = _report(port, use_synthetic or use_synthetic_fallback)

    print("\n" + report + "\n")

    if args.discord:
        from src import discord_notifier
        discord_notifier.send_text(f"```\n{report}\n```")
        logger.info("Rapport envoyé sur Discord.")


if __name__ == "__main__":
    main()
