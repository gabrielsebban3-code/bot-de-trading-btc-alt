"""Integration: the engine reproduces perp-setups study 1 exactly (skipped when the market database is absent)."""
import pytest

from bot.core.config import load_config, resolve_path


def test_engine_reproduces_study1():
    cfg = load_config()
    if not resolve_path(cfg, "market_db").exists():
        pytest.skip("market database not downloaded (python -m bot.main download-long)")
    from bot.backtest.reference_study1 import EXPECTED, run_regression
    from bot.data.storage import MarketStore
    store = MarketStore(cfg)
    if store.candles("BTCUSDT", "15m", end_ms=1_577_923_200_000).empty:
        pytest.skip("15m candles of the study-1 pairs not downloaded")
    res = run_regression(cfg, store)
    got = res["got"]
    assert got["n_trades"] == EXPECTED["n_trades"]
    for k in ("expectancy_r", "profit_factor", "win_rate", "max_dd_pct"):
        assert got[k] == pytest.approx(EXPECTED[k], abs=1e-4 if k == "max_dd_pct" else 1e-5), k
