import numpy as np
import pandas as pd

from bot.core.timeutil import DAY_MS, HOUR_MS, bucket_start, to_ms
from bot.data.resampler import align_closed, find_gaps, resample
from bot.tests.conftest import M15, make_bars


def test_resample_ohlcv_and_alignment():
    df = make_bars(np.arange(1, 17, dtype=float))            # 16 x 15m = 4 hours starting 00:00 UTC
    h1 = resample(df, "15m", "1h")
    assert len(h1) == 4
    assert h1["open_time"].tolist() == [df["open_time"][0] + k * HOUR_MS for k in range(4)]
    first = df.iloc[:4]
    assert h1["open"][0] == first["open"].iloc[0]
    assert h1["close"][0] == first["close"].iloc[-1]
    assert h1["high"][0] == first["high"].max()
    assert h1["low"][0] == first["low"].min()
    assert h1["volume"][0] == first["volume"].sum()
    assert (h1["close_time"] - h1["open_time"] == HOUR_MS).all()


def test_incomplete_candles_are_dropped():
    df = make_bars(np.arange(1, 17, dtype=float)).drop(index=[5]).reset_index(drop=True)  # hole in hour 2
    h1 = resample(df, "15m", "1h")
    assert len(h1) == 3
    assert df["open_time"][0] + HOUR_MS not in h1["open_time"].tolist()
    assert h1["contig"].tolist() == [False, False, True]


def test_live_candle_in_progress_is_dropped():
    df = make_bars(np.arange(1, 17, dtype=float))
    now = int(df["open_time"].iloc[-1])                      # last 15m candle not closed yet
    part = df[df["open_time"] + M15 <= now]
    h1 = resample(part, "15m", "1h", now_ms=now)
    assert len(h1) == 3                                      # the 4th hour is incomplete


def test_daily_and_weekly_buckets_utc():
    t = to_ms("2024-03-13 17:45")                            # a Wednesday
    assert bucket_start(t, "1d") == to_ms("2024-03-13")
    assert bucket_start(t, "1w") == to_ms("2024-03-11")      # Monday 00:00 UTC
    assert bucket_start(t, "4h") == to_ms("2024-03-13 16:00")


def test_align_closed_uses_only_closed_candles():
    src_close = np.array([10, 20, 30])
    vals = np.array([1.0, 2.0, 3.0])
    out = align_closed(np.array([5, 10, 19, 20, 35]), src_close, vals)
    assert np.isnan(out[0])
    assert out.tolist()[1:] == [1.0, 1.0, 2.0, 3.0]


def test_find_gaps():
    ot = np.array([0, M15, 4 * M15], dtype="int64")
    assert find_gaps(ot, "15m") == [(2 * M15, 3 * M15, 2)]
