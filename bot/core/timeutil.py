"""UTC time helpers. Every timestamp in the bot is an int64 number of milliseconds since the epoch (UTC).

A candle is identified by its open time; it is usable (closed) from ``open_time + tf_ms`` on.
"""
from __future__ import annotations

import pandas as pd

MINUTE_MS = 60_000
HOUR_MS = 3_600_000
DAY_MS = 86_400_000
WEEK_MS = 7 * DAY_MS

TF_MS: dict[str, int] = {
    "1m": MINUTE_MS,
    "5m": 5 * MINUTE_MS,
    "15m": 15 * MINUTE_MS,
    "1h": HOUR_MS,
    "4h": 4 * HOUR_MS,
    "1d": DAY_MS,
    "1w": WEEK_MS,
}

# The Unix epoch (1970-01-01) is a Thursday. Weekly candles open on Monday 00:00 UTC (Binance convention).
WEEK_OFFSET_MS = 4 * DAY_MS


def tf_ms(tf: str) -> int:
    try:
        return TF_MS[tf]
    except KeyError as exc:
        raise ValueError(f"unknown timeframe {tf!r}") from exc


def bucket_start(t_ms, tf: str):
    """Open time of the ``tf`` candle containing ``t_ms`` (UTC aligned; weeks start on Monday)."""
    step = tf_ms(tf)
    if tf == "1w":
        return ((t_ms - WEEK_OFFSET_MS) // step) * step + WEEK_OFFSET_MS
    return (t_ms // step) * step


def to_ms(ts) -> int:
    """Date/time string, datetime or Timestamp (naive = UTC) -> epoch milliseconds."""
    t = pd.Timestamp(ts)
    if t.tzinfo is None:
        t = t.tz_localize("UTC")
    return int(t.value // 1_000_000)


def ms_to_ts(ms: int) -> pd.Timestamp:
    return pd.Timestamp(int(ms), unit="ms", tz="UTC")


def ms_to_str(ms: int, fmt: str = "%Y-%m-%d %H:%M") -> str:
    return ms_to_ts(ms).strftime(fmt)


def month_start_ms(month: str) -> int:
    """'2026-10' -> epoch ms of 2026-10-01 00:00 UTC."""
    return to_ms(pd.Period(month, freq="M").start_time)


def month_end_ms(month: str) -> int:
    """Exclusive end of a month: first ms of the next month."""
    return to_ms((pd.Period(month, freq="M") + 1).start_time)


def months_between(first: str, last: str) -> list[str]:
    return [str(p) for p in pd.period_range(pd.Period(first, freq="M"), pd.Period(last, freq="M"), freq="M")]


def month_of(ms: int) -> str:
    return str(ms_to_ts(ms).tz_localize(None).to_period("M"))
