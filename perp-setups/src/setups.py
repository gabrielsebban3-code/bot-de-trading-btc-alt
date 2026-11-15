"""Signal generation: one function per setup family (A to E).

Every function reads closed candles only and returns orders to be placed at the close of the
signal candle (``order_time`` = close time of that candle = open time of the next one).
The functions do not know anything about the portfolio, the costs or the future.
"""
from __future__ import annotations

import itertools

import numpy as np
import pandas as pd

from . import indicators as ind
from . import structure as st
from .data import TF_MS, align_htf, resample
from .engine import SIGNAL_COLUMNS

DAY_MS = 86_400_000


# ---------------------------------------------------------------- per-symbol context

class Bars:
    """Candles of one symbol on one timeframe, with lazily computed, cached indicators."""

    def __init__(self, df: pd.DataFrame, tf: str, cfg: dict):
        self.tf = tf
        self.cfg = cfg
        self.ot = df["open_time"].to_numpy(dtype="int64")
        self.ct = df["close_time"].to_numpy(dtype="int64")
        self.o = df["open"].to_numpy(dtype="float64")
        self.h = df["high"].to_numpy(dtype="float64")
        self.l = df["low"].to_numpy(dtype="float64")
        self.c = df["close"].to_numpy(dtype="float64")
        self.v = df["volume"].to_numpy(dtype="float64")
        self.contig = df["contig"].to_numpy(dtype=bool)
        self.size = len(self.ot)
        self._cache: dict = {}

    def get(self, key, fn):
        if key not in self._cache:
            self._cache[key] = fn()
        return self._cache[key]

    @property
    def atr(self):
        return self.get("atr", lambda: ind.atr(self.h, self.l, self.c, self.cfg["indicators"]["atr_period"]))

    @property
    def rsi(self):
        return self.get("rsi", lambda: ind.rsi(self.c, self.cfg["indicators"]["rsi_period"]))

    @property
    def adx(self):
        return self.get("adx", lambda: ind.adx(self.h, self.l, self.c, self.cfg["indicators"]["adx_period"]))

    def ema(self, period: int):
        return self.get(("ema", period), lambda: ind.ema(self.c, period))

    def bb(self, k: float):
        return self.get(("bb", k), lambda: ind.bollinger(self.c, self.cfg["indicators"]["bb_period"], k))

    def pivots(self, n: int):
        return self.get(("piv", n), lambda: st.confirmed_pivots(self.h, self.l, n))

    def last_pivot_levels(self, n: int):
        """(last confirmed pivot-high level, last confirmed pivot-low level) for every candle."""
        def _build():
            p = self.pivots(n)
            hi, _ = st.last_confirmed_level(self.size, p["ph_idx"], p["ph_level"], n)
            lo, _ = st.last_confirmed_level(self.size, p["pl_idx"], p["pl_level"], n)
            return hi, lo
        return self.get(("lastpiv", n), _build)

    def valid(self, warmup_ms: int) -> np.ndarray:
        """True for candles at least ``warmup_ms`` after the start of history and after the last data gap."""
        def _build():
            if self.size == 0:
                return np.zeros(0, dtype=bool)
            brk = np.where(~self.contig, self.ot, np.int64(-1))
            brk[0] = self.ot[0]
            last_break = np.maximum.accumulate(brk)
            return (self.ot - last_break) >= warmup_ms
        return self.get(("valid", warmup_ms), _build)


class SymbolContext:
    """Everything the setup functions may look at for one symbol."""

    def __init__(self, symbol: str, df15: pd.DataFrame, funding: pd.DataFrame | None, cfg: dict,
                 warmup_ms: int | None = None):
        self.symbol = symbol
        self.cfg = cfg
        self.warmup_ms = cfg["data"]["warmup_days"] * DAY_MS if warmup_ms is None else warmup_ms
        self.bars = {tf: Bars(resample(df15, tf), tf, cfg) for tf in ("15m", "1h", "4h")}
        if funding is not None and len(funding):
            self.f_time = (funding["funding_time"].to_numpy(dtype="int64") // 60_000) * 60_000
            self.f_rate = funding["funding_rate"].to_numpy(dtype="float64")
        else:
            self.f_time = np.zeros(0, dtype="int64")
            self.f_rate = np.zeros(0)
        self._cache: dict = {}


def _empty_signals() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype="object" if c in ("symbol", "order_type", "tf") else "float64")
                         for c in SIGNAL_COLUMNS}).astype({"order_time": "int64", "direction": "int64"})


def _frame(ctx: SymbolContext, tf: str, rows: list[dict]) -> pd.DataFrame:
    if not rows:
        return _empty_signals()
    df = pd.DataFrame(rows)
    df["symbol"] = ctx.symbol
    df["tf"] = tf
    for col in SIGNAL_COLUMNS:
        if col not in df.columns:
            df[col] = np.nan
    df = df[SIGNAL_COLUMNS].copy()
    df["order_time"] = df["order_time"].astype("int64")
    df["direction"] = df["direction"].astype("int64")
    for col in ("limit_price", "stop_price", "stop_dist", "tp_r", "tp_price", "trail_mult", "max_hold_ms",
                "expiry_ms", "atr"):
        df[col] = df[col].astype("float64")
    return df.sort_values("order_time", kind="stable").reset_index(drop=True)


def _rolling_any_incl(flag: np.ndarray, window: int) -> np.ndarray:
    """True when ``flag`` was true on at least one of the last ``window`` candles (current included)."""
    x = flag.astype("float64")
    out = np.zeros(len(x), dtype=bool)
    if len(x) >= window:
        win = np.lib.stride_tricks.sliding_window_view(x, window)
        out[window - 1:] = win.max(axis=1) > 0
    return out


def _edge(cond: np.ndarray) -> np.ndarray:
    """First candle of each run of True values."""
    out = cond.copy()
    out[1:] &= ~cond[:-1]
    return out


# ---------------------------------------------------------------- family A: SMC

def _a_base(ctx: SymbolContext, tf: str, n: int, structure: str, zone: str) -> list[dict]:
    """Orders of family A before the take-profit and higher-timeframe variants are applied."""
    key = ("A", tf, n, structure, zone)
    if key in ctx._cache:
        return ctx._cache[key]
    fx = ctx.cfg["families"]["A"]["fixed"]
    b = ctx.bars[tf]
    piv = b.pivots(n)
    last_ph, last_pl = b.last_pivot_levels(n)
    last_bull, last_bear = b.get("lastopp", lambda: st.last_opposite_candle(b.o, b.c))
    atr = b.atr
    valid = b.valid(ctx.warmup_ms)
    step = TF_MS[tf]
    rows: list[dict] = []
    for side, direction in (("high", -1), ("low", 1)):
        sweeps = b.get(("sweeps", n, side), lambda: st.find_sweeps(
            b.h, b.l, b.c, piv, side, fx["pivot_lookback_bars"], fx["equal_level_tol"], fx["min_group_size"]))
        for t, level in sweeps:
            if not np.isfinite(atr[t]):
                continue
            if direction < 0:
                stop = b.h[t] + fx["stop_margin_atr"] * atr[t]
                ref = last_pl[t]
            else:
                stop = b.l[t] - fx["stop_margin_atr"] * atr[t]
                ref = last_ph[t]
            u = st.find_mss(t, direction, ref, stop, b.o, b.h, b.l, b.c, atr, fx["mss_window_bars"],
                            structure == "deplacement", fx["displacement_atr_mult"])
            if u < 0:
                continue
            if zone == "FVG":
                z = st.fvg_zone(u, direction, b.h, b.l)
                c = u + 1
                if z is None:
                    continue
                # the stop must not be touched while the gap forms
                if (direction < 0 and b.h[c] >= stop) or (direction > 0 and b.l[c] <= stop):
                    continue
            else:
                z = st.order_block_zone(u, direction, b.o, b.c, last_bull, last_bear)
                c = u
                if z is None:
                    continue
            limit = 0.5 * (z[0] + z[1])
            # the limit must rest on the passive side of the market and inside the stop
            if direction < 0 and not (b.c[c] < limit < stop):
                continue
            if direction > 0 and not (stop < limit < b.c[c]):
                continue
            if not valid[c] or not np.isfinite(atr[c]):
                continue
            rows.append({"order_time": int(b.ct[c]), "direction": direction, "order_type": "limit",
                         "limit_price": float(limit), "stop_price": float(stop),
                         "expiry_ms": float(b.ct[c] + fx["limit_validity_bars"] * step),
                         "atr": float(atr[c]), "_c": c, "_sweep": t})
    rows.sort(key=lambda r: (r["order_time"], r["_sweep"], -r["direction"]))
    ctx._cache[key] = rows
    return rows


def htf_trend(ctx: SymbolContext, tf: str) -> np.ndarray:
    """+1 / -1 / 0 for every candle of ``tf``: sign of EMA50 - EMA200 on the last CLOSED 4h candle."""
    def _build():
        icfg = ctx.cfg["indicators"]
        b, hb = ctx.bars[tf], ctx.bars[ctx.cfg["families"]["A"]["fixed"]["htf"]]
        fast = align_htf(b.ct, hb.ct, hb.ema(icfg["ema_mid"]))
        slow = align_htf(b.ct, hb.ct, hb.ema(icfg["ema_slow"]))
        with np.errstate(invalid="ignore"):
            return np.where(fast > slow, 1, np.where(fast < slow, -1, 0))
    return ctx.bars[tf].get("htf_trend", _build)


def signals_A(ctx: SymbolContext, p: dict) -> pd.DataFrame:
    tf = p["timeframe"]
    base = _a_base(ctx, tf, int(p["pivot_n"]), p["structure"], p["zone"])
    trend = htf_trend(ctx, tf) if p["htf_filter"] == "on" else None
    rows = []
    for r in base:
        if trend is not None and trend[r["_c"]] != r["direction"]:
            continue
        row = {k: v for k, v in r.items() if not k.startswith("_")}
        row["tp_r"] = float(p["tp_r"])
        rows.append(row)
    return _frame(ctx, tf, rows)


# ---------------------------------------------------------------- family B: trend pullback

def signals_B(ctx: SymbolContext, p: dict, fam: str = "B") -> pd.DataFrame:
    fx = ctx.cfg["families"][fam]["fixed"]
    icfg = ctx.cfg["indicators"]
    tf = p["timeframe"]
    b = ctx.bars[tf]
    lo_thr, hi_thr = (float(x) for x in p["rsi_thresholds"].split("/"))
    e20, e50, e200 = b.ema(icfg["ema_fast"]), b.ema(icfg["ema_mid"]), b.ema(icfg["ema_slow"])
    rsi, atr = b.rsi, b.atr
    last_ph, last_pl = b.last_pivot_levels(fx["pivot_n"])
    valid = b.valid(ctx.warmup_ms)
    win = fx["pullback_window_bars"]
    with np.errstate(invalid="ignore"):
        rsi_min_prev = ind.rolling_min_prev(rsi, fx["rsi_lookback_bars"])
        rsi_max_prev = ind.rolling_max_prev(rsi, fx["rsi_lookback_bars"])
        cond_long = ((e50 > e200) & _rolling_any_incl(b.l <= e20, win) & (b.c > e20)
                     & (rsi > lo_thr) & (rsi_min_prev < lo_thr))
        cond_short = ((e50 < e200) & _rolling_any_incl(b.h >= e20, win) & (b.c < e20)
                      & (rsi < hi_thr) & (rsi_max_prev > hi_thr))
    rows = []
    for direction, cond in ((1, _edge(cond_long)), (-1, _edge(cond_short))):
        for t in np.nonzero(cond & valid & np.isfinite(atr))[0]:
            row = {"order_time": int(b.ct[t]), "direction": direction, "order_type": "market", "atr": float(atr[t])}
            if p["stop"] == "atr":
                row["stop_dist"] = float(fx["stop_atr_mult"] * atr[t])
            else:
                level = last_pl[t] if direction > 0 else last_ph[t]
                if not np.isfinite(level):
                    continue
                row["stop_price"] = float(level)
            if "tp_r" in p:                 # family F: fixed target given by the grid
                row["tp_r"] = float(p["tp_r"])
            elif p["exit"] == "tp2r":
                row["tp_r"] = float(fx["tp_r"])
            else:
                row["trail_mult"] = float(fx["trail_atr_mult"])
            rows.append(row)
    return _frame(ctx, tf, rows)


# ---------------------------------------------------------------- family C: range breakout

def signals_C(ctx: SymbolContext, p: dict, fam: str = "C") -> pd.DataFrame:
    fx = ctx.cfg["families"][fam]["fixed"]
    tf = p["timeframe"]
    b = ctx.bars[tf]
    n = int(p["donchian_n"])
    atr = b.atr
    valid = b.valid(ctx.warmup_ms)
    dc_hi, dc_lo = ind.donchian(b.h, b.l, n)
    with np.errstate(invalid="ignore"):
        long_c = b.c > dc_hi
        short_c = b.c < dc_lo
        if p["volume_filter"] == "on":
            vol_ok = b.v > fx["volume_mult"] * ind.rolling_mean_prev(b.v, fx["volume_window_bars"])
            long_c &= vol_ok
            short_c &= vol_ok
    rows = []
    for direction, cond in ((1, long_c), (-1, short_c)):
        for t in np.nonzero(cond & valid & np.isfinite(atr))[0]:
            row = {"order_time": int(b.ct[t]), "direction": direction, "order_type": "market",
                   "stop_dist": float(fx["stop_atr_mult"] * atr[t]), "atr": float(atr[t])}
            if "tp_r" in p:                 # family G: fixed target given by the grid
                row["tp_r"] = float(p["tp_r"])
            else:
                row["trail_mult"] = float(fx["trail_atr_mult"])
            rows.append(row)
    return _frame(ctx, tf, rows)


# ---------------------------------------------------------------- family D: mean reversion

def signals_D(ctx: SymbolContext, p: dict) -> pd.DataFrame:
    fx = ctx.cfg["families"]["D"]["fixed"]
    tf = p["timeframe"]
    b = ctx.bars[tf]
    lo_thr, hi_thr = (float(x) for x in p["rsi_thresholds"].split("/"))
    mid, upper, lower = b.bb(float(p["bb_k"]))
    rsi, atr, adx = b.rsi, b.atr, b.adx
    valid = b.valid(ctx.warmup_ms)
    with np.errstate(invalid="ignore"):
        regime = adx < fx["adx_max"]
        long_c = regime & (b.c < lower) & (rsi <= lo_thr)
        short_c = regime & (b.c > upper) & (rsi >= hi_thr)
    rows = []
    hold = float(fx["max_hold_bars"] * TF_MS[tf])
    for direction, cond in ((1, long_c), (-1, short_c)):
        for t in np.nonzero(cond & valid & np.isfinite(atr) & np.isfinite(mid))[0]:
            rows.append({"order_time": int(b.ct[t]), "direction": direction, "order_type": "market",
                         "stop_dist": float(fx["stop_atr_mult"] * atr[t]), "tp_price": float(mid[t]),
                         "max_hold_ms": hold, "atr": float(atr[t])})
    return _frame(ctx, tf, rows)


# ---------------------------------------------------------------- family E: funding extremes

def funding_zscore(rates: np.ndarray, window: int) -> np.ndarray:
    """z-score of each funding rate against the ``window`` settlements before it (current excluded)."""
    rates = np.asarray(rates, dtype="float64")
    z = np.full(len(rates), np.nan)
    if len(rates) > window:
        win = np.lib.stride_tricks.sliding_window_view(rates, window)[:-1]
        mean = win.mean(axis=1)
        sd = win.std(axis=1, ddof=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            z[window:] = np.where(sd > 0, (rates[window:] - mean) / sd, np.nan)
    return z


def signals_E(ctx: SymbolContext, p: dict) -> pd.DataFrame:
    fx = ctx.cfg["families"]["E"]["fixed"]
    tf = fx["timeframe"]
    b = ctx.bars[tf]
    atr = b.atr
    valid = b.valid(ctx.warmup_ms)
    z = ctx._cache.setdefault(("E_z", fx["z_window"]), funding_zscore(ctx.f_rate, fx["z_window"]))
    thr = float(p["z"])
    n_win = int(fx["confirm_window_hours"] * 3_600_000 // TF_MS[tf])
    hold = float(p["max_hold_hours"]) * 3_600_000.0
    rows, seen = [], set()
    with np.errstate(invalid="ignore"):
        extreme = np.nonzero(np.abs(z) >= thr)[0]
    for s in extreme:
        direction = -1 if z[s] > 0 else 1
        t0 = int(ctx.f_time[s])
        k0 = int(np.searchsorted(b.ot, t0))
        for k in range(k0, min(k0 + n_win, b.size)):
            if b.ct[k] > t0 + n_win * TF_MS[tf]:
                break
            if k == 0 or not b.contig[k]:
                continue
            confirmed = b.c[k] < b.l[k - 1] if direction < 0 else b.c[k] > b.h[k - 1]
            if confirmed:
                if valid[k] and np.isfinite(atr[k]) and (k, direction) not in seen:
                    seen.add((k, direction))
                    rows.append({"order_time": int(b.ct[k]), "direction": direction, "order_type": "market",
                                 "stop_dist": float(fx["stop_atr_mult"] * atr[k]), "tp_r": float(fx["tp_r"]),
                                 "max_hold_ms": hold, "atr": float(atr[k])})
                break
    return _frame(ctx, tf, rows)


# ---------------------------------------------------------------- grids

SIGNAL_FUNCS = {"A": signals_A, "B": signals_B, "C": signals_C, "D": signals_D, "E": signals_E,
                "F": lambda ctx, p: signals_B(ctx, p, "F"),      # study 3: entries of B, fixed target
                "G": lambda ctx, p: signals_C(ctx, p, "G")}      # study 3: entries of C, fixed target


_ALIAS = {"timeframe": "tf", "pivot_n": "n", "structure": "", "zone": "", "tp_r": "tp", "htf_filter": "htf",
          "rsi_thresholds": "rsi", "stop": "stop", "exit": "exit", "donchian_n": "dc", "volume_filter": "vol",
          "bb_k": "k", "z": "z", "max_hold_hours": "hold"}


def _fmt(value) -> str:
    return str(value).replace("/", "-").replace(".", "p")


def all_configs(cfg: dict) -> list[dict]:
    """The closed list of configurations (100), in a deterministic order."""
    out = []
    for fam in sorted(cfg["families"]):
        grid = cfg["families"][fam]["grid"]
        keys = list(grid.keys())
        for combo in itertools.product(*(grid[k] for k in keys)):
            params = dict(zip(keys, combo))
            config_id = fam + "_" + "_".join(f"{_ALIAS[k]}{_fmt(v)}" for k, v in params.items())
            out.append({"family": fam, "config_id": config_id, "params": params, "index": len(out)})
    return out


def neighbours(config: dict, configs: list[dict]) -> list[dict]:
    """Configurations of the same family differing by exactly one parameter."""
    res = []
    for other in configs:
        if other["family"] != config["family"] or other["config_id"] == config["config_id"]:
            continue
        diff = sum(1 for k in config["params"] if config["params"][k] != other["params"][k])
        if diff == 1:
            res.append(other)
    return res


def timeframe_of(cfg: dict, config: dict) -> str:
    return config["params"].get("timeframe", cfg["families"][config["family"]]["fixed"].get("timeframe"))


def exit_spec(cfg: dict, config: dict) -> dict:
    """Exit structure of a configuration, used to build the random-entry baseline."""
    fam, p = config["family"], config["params"]
    fx = cfg["families"][fam]["fixed"]
    tf = timeframe_of(cfg, config)
    spec = {"tf": tf, "entry_is_limit": fam == "A", "tp_mode": "none", "tp_r": None,
            "trail_mult": None, "max_hold_ms": None}
    if fam == "A":
        spec.update(tp_mode="r", tp_r=float(p["tp_r"]))
    elif fam == "B":
        if p["exit"] == "tp2r":
            spec.update(tp_mode="r", tp_r=float(fx["tp_r"]))
        else:
            spec.update(trail_mult=float(fx["trail_atr_mult"]))
    elif fam == "C":
        spec.update(trail_mult=float(fx["trail_atr_mult"]))
    elif fam == "D":
        spec.update(tp_mode="atr", max_hold_ms=float(fx["max_hold_bars"] * TF_MS[tf]))
    elif fam == "E":
        spec.update(tp_mode="r", tp_r=float(fx["tp_r"]), max_hold_ms=float(p["max_hold_hours"]) * 3_600_000.0)
    elif fam in ("F", "G"):
        spec.update(tp_mode="r", tp_r=float(p["tp_r"]))
    return spec


def generate_signals(ctx: SymbolContext, config: dict) -> pd.DataFrame:
    return SIGNAL_FUNCS[config["family"]](ctx, config["params"])
