"""The carry monitor applies the study 7 rule and never turns an error into a signal (no network used)."""
import importlib.util
from datetime import datetime, timezone
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("carry_monitor", Path(__file__).parents[1] / "tools" / "carry_monitor.py")
cm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cm)
DAY = 86_400_000


def test_decision_uses_the_last_14_days_only():
    now = 1_800_000_000_000 // DAY * DAY
    hist = [(now - k * 8 * 3_600_000, 0.0001) for k in range(1, 43)]       # 42 settlements = 14 days at 0.01 %
    d = cm.decide(hist + [(now + 1, -1.0), (now - 20 * DAY, -1.0)], now)  # a future and a too-old rate are ignored
    assert d["n"] == 42 and d["hold"] and d["annual_pct"] == pytest.approx(10.95)
    assert not cm.decide([(now - DAY, -0.0001)], now)["hold"]


def test_actions_state_and_errors(tmp_path, monkeypatch):
    monkeypatch.setattr(cm, "JOURNAL", tmp_path / "j.csv")
    monkeypatch.setattr(cm, "STATE", tmp_path / "s.json")
    monkeypatch.setattr(cm, "PAIRS", ["AAA", "BBB", "CCC"])
    now = datetime(2027, 1, 10, 0, 5, tzinfo=timezone.utc)
    t0 = int(now.replace(minute=0).timestamp() * 1000)
    rates = {"AAA": 0.0001, "BBB": -0.0001}
    def fetch(ex, coin, since):
        if coin == "CCC":
            raise ConnectionError("down")
        return [(t0 - k * 8 * 3_600_000, rates[coin]) for k in range(1, 43)]
    first = {r["coin"]: r["action"] for r in cm.run("binance", False, now, fetch)}
    assert first["AAA"] == "OUVRIR" and first["BBB"] == "rien" and first["CCC"].startswith("ERREUR")
    rates["AAA"] = -0.0002
    second = {r["coin"]: r["action"] for r in cm.run("binance", False, now, fetch)}
    assert second["AAA"] == "FERMER" and second["CCC"].startswith("ERREUR")
    assert (tmp_path / "j.csv").read_text().count("\n") == 7                # header + 2 days x 3 pairs
