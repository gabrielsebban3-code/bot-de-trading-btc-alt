"""Symbol catalogue, frozen held-out pairs and point-in-time universe (Step 1).

* Catalogue: every USDT-margined perpetual that ever had archives, delisted ones included
  (survivorship bias: a pair that died is still traded by the backtest while it was in the top).
* Held-out pairs: a deterministic hash rule decided on 2026-11-17 from symbol NAMES only, before any
  price was downloaded. They are never used for development or tuning (PROTOCOLE.md).
* Universe: for each calendar month, the top N by average daily quote volume over the previous
  ``volume_window_days`` CLOSED days, with a minimum volume and a minimum history. Decided with data
  available before the month starts (no lookahead).
"""
from __future__ import annotations

import hashlib
import time

import numpy as np
import pandas as pd

from ..core.timeutil import DAY_MS, month_start_ms, months_between
from .storage import MarketStore


def classify_symbol(symbol: str, cfg: dict) -> tuple[bool, str, str]:
    """(eligible, base, reason) for one archive symbol."""
    d = cfg["data"]
    quote = d["quote_asset"]
    if "_" in symbol:
        return False, "", "dated_future"
    if not symbol.endswith(quote):
        return False, "", "other_quote"
    base = symbol[: -len(quote)]
    if base in set(d["stablecoin_bases"]):
        return False, base, "stablecoin"
    if base in set(d["index_bases"]) or any(base.endswith(s) for s in d["index_suffixes"]):
        return False, base, "index"
    return True, base, ""


def is_holdout(symbol: str, cfg: dict) -> bool:
    h = cfg["holdout"]
    if symbol in set(h["never_holdout"]) or symbol in set(h["already_used"]):
        return False
    digest = hashlib.sha256(f"{h['salt']}:{symbol}".encode()).hexdigest()
    return int(digest, 16) % int(h["modulo"]) == 0


def freeze_holdout(store: MarketStore, cfg: dict, symbols: list[str]) -> pd.DataFrame:
    """Write the held-out flag of every eligible symbol once. Refuses to run twice."""
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    rule = f"sha256('{cfg['holdout']['salt']}:'+symbol) mod {cfg['holdout']['modulo']} == 0, " \
           f"excluding already_used and never_holdout"
    rows = [(s, int(is_holdout(s, cfg)), rule, now) for s in symbols]
    store.set_holdout(rows)
    return store.holdout()


def monthly_universe(daily: dict[str, pd.DataFrame], month: str, cfg: dict) -> list[tuple[str, float]]:
    """Top-N symbols for ``month`` from daily candles (``open_time`` ms, ``quote_volume``).

    Only daily candles CLOSED before the first instant of the month are used.
    """
    u = cfg["universe"]
    start = month_start_ms(month)
    win_start = start - int(u["volume_window_days"]) * DAY_MS
    scored = []
    for sym, df in daily.items():
        ot = df["open_time"].to_numpy()
        closed = ot + DAY_MS <= start
        if closed.sum() < int(u["min_history_days"]):
            continue
        in_win = closed & (ot >= win_start)
        if in_win.sum() < 0.9 * int(u["volume_window_days"]):
            continue  # not enough recent candles (delisted or halted): not tradable this month
        avg = float(df["quote_volume"].to_numpy()[in_win].sum() / int(u["volume_window_days"]))
        if avg >= float(u["min_avg_daily_quote_volume"]):
            scored.append((sym, avg))
    scored.sort(key=lambda x: (-x[1], x[0]))
    return scored[: int(u["top_n"])]


def build_universe(store: MarketStore, cfg: dict, first_month: str | None = None) -> pd.DataFrame:
    """Compute and store the universe of every month from ``first_month`` to ``data.last_month``."""
    cat = store.catalog(eligible_only=True)
    daily = {s: store.candles(s, "1d") for s in cat["symbol"]}
    daily = {s: d for s, d in daily.items() if len(d)}
    first = first_month or str((pd.Period(cfg["data"]["history_start"], freq="M") + 1))
    for month in months_between(first, cfg["data"]["last_month"]):
        store.set_universe(month, monthly_universe(daily, month, cfg))
    return store.universe()


def members(store: MarketStore, include_holdout: bool = False, only_holdout: bool = False) -> pd.DataFrame:
    """Universe rows joined with the held-out flag. By default held-out pairs are removed (development)."""
    u = store.universe()
    h = store.holdout()[["symbol", "holdout"]]
    u = u.merge(h, on="symbol", how="left").fillna({"holdout": 0})
    if only_holdout:
        return u[u["holdout"] == 1].reset_index(drop=True)
    if not include_holdout:
        return u[u["holdout"] == 0].reset_index(drop=True)
    return u


def member_mask(open_times: np.ndarray, symbol: str, universe: pd.DataFrame) -> np.ndarray:
    """True where the candle opening at ``open_times`` belongs to a month in which ``symbol`` is a member."""
    months = set(universe.loc[universe["symbol"] == symbol, "month"])
    if not months:
        return np.zeros(len(open_times), dtype=bool)
    m = pd.to_datetime(open_times, unit="ms", utc=True).tz_localize(None).to_period("M").astype(str)
    return np.isin(np.asarray(m), list(months))
