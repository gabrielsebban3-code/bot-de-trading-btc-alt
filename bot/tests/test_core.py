import json

import numpy as np
import pandas as pd
import pytest

from bot.core.types import Direction, ExitKind, ExitRule, Signal
from bot.data.fetcher import LiveClient
from bot.data.storage import FinalTestLockedError, MarketStore
from bot.data.universe import classify_symbol, is_holdout, monthly_universe
from bot.core.timeutil import DAY_MS, to_ms


def _sig(**kw):
    base = dict(symbol="BTCUSDT", direction=Direction.LONG, concept="C1", variant="dc55", tf_signal="4h",
                tf_context="1d", generated_at=1_700_000_000_000, entry=100.0, order_type="market", stop=95.0,
                exit_rule=ExitRule(ExitKind.TRAIL_CHANDELIER, atr_mult=3, tf="4h"))
    base.update(kw)
    return Signal(**base)


def test_signal_id_is_deterministic_and_json_valid():
    a, b = _sig(), _sig(score=50.0, reasons=("x",))
    assert a.id == b.id                                   # same setup -> same id (idempotence)
    assert a.id != _sig(direction=Direction.SHORT).id
    d = json.loads(a.to_json())
    assert d["direction"] == "long" and d["exit_rule"]["kind"] == "trail_chandelier"


def test_final_test_lock(cfg):
    st = MarketStore(cfg)
    lock = to_ms(cfg["final_test"]["start"])
    df = pd.DataFrame({"open_time": [lock - DAY_MS, lock], "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0,
                       "volume": 1.0, "quote_volume": 1.0, "trades": 1, "taker_buy_quote": 0.5})
    assert st.upsert_candles("BTCUSDT", "1d", df) == 1     # the locked row is never stored
    assert len(st.candles("BTCUSDT", "1d")) == 1
    with pytest.raises(FinalTestLockedError):
        st.candles("BTCUSDT", "1d", end_ms=lock + DAY_MS)


def test_holdout_frozen_once(cfg):
    st = MarketStore(cfg)
    st.set_holdout([("AUSDT", 1, "r", "now")])
    with pytest.raises(RuntimeError):
        st.set_holdout([("BUSDT", 0, "r", "now")])


def test_classify_and_holdout_rule(cfg):
    assert classify_symbol("BTCUSDT", cfg)[0]
    assert not classify_symbol("USDCUSDT", cfg)[0]
    assert not classify_symbol("BTCDOMUSDT", cfg)[0]
    assert not classify_symbol("BTCUSDT_230331", cfg)[0]
    assert not is_holdout("BTCUSDT", cfg) and not is_holdout("SOLUSDT", cfg)


def test_universe_uses_only_days_closed_before_the_month(cfg):
    start = to_ms("2024-03-01")
    days = start + np.arange(-60, 10) * DAY_MS
    big = pd.DataFrame({"open_time": days, "quote_volume": np.where(days >= start, 1e12, 1e8)})
    small = pd.DataFrame({"open_time": days, "quote_volume": np.full(len(days), 5e8)})
    top = monthly_universe({"AUSDT": big, "BUSDT": small}, "2024-03", cfg)
    assert [s for s, _ in top] == ["BUSDT", "AUSDT"]     # A's huge volume of March is not visible yet


def test_live_client_drops_candle_in_progress():
    rows = [[0, 1, 1, 1, 1, 1], [60_000, 1, 1, 1, 1, 1], [120_000, 1, 1, 1, 1, 1]]
    assert LiveClient.closed_only(rows, "1m", now_ms=150_000) == rows[:2]
    assert LiveClient.closed_only(rows, "1m", now_ms=180_000) == rows
