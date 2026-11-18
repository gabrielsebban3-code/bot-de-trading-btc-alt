"""Phase 4: live scanner with a fake exchange (no network)."""
import json
import subprocess

import numpy as np
import pandas as pd
import pytest

from bot.alerts.discord import DiscordSender, followup_embed, signal_embed
from bot.core.config import REPO_DIR
from bot.live.scanner import run_scan
from bot.live.state import STATUSES, StateStore
from bot.live.ws import closed_kline_open_time, next_close_ms
from bot.monitor.decay import check, live_drawdown_r
from bot.tests.conftest import make_bars

M15 = 15 * 60_000
NOW = 1_790_000_100_000 - (1_790_000_100_000 % M15)       # aligned on a 15m close
DAYS = 450


class FakeClient:
    def __init__(self, frames):
        self.frames = frames
        self.calls = []

    def usdt_perpetuals(self):
        return sorted(self.frames)

    def quote_volume_24h(self, symbols):
        return {s: 1e9 for s in symbols}

    def fetch_closed(self, symbol, tf, since, now=None, limit=1500):
        self.calls.append((symbol, tf, since))
        df = self.frames[symbol]
        if tf == "1d":
            from bot.data.resampler import resample
            df = resample(df, "15m", "1d")
            step = 86_400_000
        else:
            step = M15
        df = df[(df["open_time"] >= since) & (df["open_time"] + step <= now)]
        return df[["open_time", "open", "high", "low", "close", "volume", "quote_volume"]].assign(trades=1, taker_buy_quote=0.0)

    def fetch_funding(self, symbol, since):
        return pd.DataFrame({"time": [], "rate": []})

    def fetch_open_interest(self, symbol, since):
        return pd.DataFrame({"time": [], "oi": [], "oi_value": []})


@pytest.fixture
def setup(cfg, tmp_path):
    rng = np.random.default_rng(4)
    t0 = NOW - DAYS * 86_400_000
    frames = {}
    for k, sym in enumerate(["AAAUSDT", "BBBUSDT", "CCCUSDT"]):
        n = DAYS * 96
        close = 50 * (k + 1) * np.exp(np.cumsum(rng.normal(0.00004, 0.004, n)))
        frames[sym] = make_bars(close, t0=t0, spread=0.002, volume=rng.lognormal(10, 0.5, n) * 1000)
    obs = tmp_path / "observation.json"
    obs.write_text(json.dumps([
        {"group": "C1|1h|both", "concept": "C1", "variant": "C1_test", "backtest_max_dd_r": 30.0,
         "params": {"tf": "1h", "direction": "both", "entry_n": "20", "trail": "chandelier"}, "oos_expectancy_r": 0.05},
        {"group": "C3|1h|both", "concept": "C3", "variant": "C3_test", "backtest_max_dd_r": 30.0,
         "params": {"tf": "1h", "rsi_period": 2, "deviation": "bb"}, "oos_expectancy_r": 0.01}]))
    cfg["live"].update(market_db=str(tmp_path / "live.sqlite"), observation_list=str(obs),
                       validated_list=str(tmp_path / "validated.json"), start="2026-01-01", bootstrap_days=DAYS)
    cfg["universe"]["min_avg_daily_quote_volume"] = 0.0
    cfg["engine"]["warmup_days"] = 5
    return cfg, frames


def test_scan_is_idempotent_and_private_in_observation_mode(setup):
    cfg, frames = setup
    client = FakeClient(frames)
    s1 = run_scan(cfg, client, now_ms=NOW - 20 * 86_400_000, dry_run=True)
    assert s1["symbols_with_data"] == 3 and s1["new_signals"] > 0 and s1["events"] > 0 and s1["sent"] == 0
    s2 = run_scan(cfg, client, now_ms=NOW - 20 * 86_400_000, dry_run=True)        # restart: same instant
    assert s2["new_signals"] == 0 and s2["events"] == 0
    s3 = run_scan(cfg, client, now_ms=NOW, dry_run=True)                          # 20 days later: gap fill
    st = StateStore(cfg)
    assert set(st.status()["status"]) <= set(STATUSES)
    assert len(st.signals()) == len(set(st.signals()["id"]))
    assert s3["sent"] == 0                                                        # observation: nothing sent
    assert {"actif", "stop remonté", "sorti en gain", "sorti en perte"} & set(st.status()["status"])
    for p in st.signals()["payload"]:
        json.loads(p)
    # the second update only asked for candles after the last stored one
    later = [c for c in client.calls if c[1] == "15m" and c[2] > NOW - 21 * 86_400_000]
    assert later and all(c[2] >= NOW - 20 * 86_400_000 for c in later)


def test_alerts_only_for_validated_variants(setup):
    cfg, frames = setup
    cfg["live"]["mode"] = "alerts"
    (REPO_DIR / cfg["live"]["validated_list"]).write_text(json.dumps([{"concept": "C1", "params": {
        "tf": "1h", "direction": "both", "entry_n": "20", "trail": "chandelier"}}]))
    s = run_scan(cfg, FakeClient(frames), now_ms=NOW, dry_run=True)
    st = StateStore(cfg)
    ev = pd.read_sql_query("SELECT e.sent, s.variant FROM events e JOIN signals s ON s.id=e.signal_id", st.con)
    assert len(ev) and (ev.loc[ev["variant"].str.startswith("C3"), "sent"] == 0).all()   # not validated: never sent
    assert s["sent"] >= 1 and (ev.loc[ev["variant"].str.startswith("C1"), "sent"] == 1).any()


def test_embeds_are_complete_and_json():
    sig = {"id": "x1", "symbol": "BTCUSDT", "direction": "long", "concept": "C1", "variant": "C1_v", "tf_signal": "4h",
           "tf_context": "1d", "generated_at": 1_790_000_000_000, "entry": 100.0, "stop": 95.0, "order_type": "market",
           "exit_rule": {"kind": "trail_chandelier", "atr_mult": 3.0, "tf": "4h", "donchian_n": None, "tp_r": None,
                         "tp_price": None, "max_hold_bars": None}, "score": 0, "reasons": ["régime haussier (1d)", "cassure"],
           "invalidation": "stop"}
    e = signal_embed(sig)
    names = {f["name"] for f in e["fields"]}
    assert {"Paire", "Direction", "Concept", "Entrée", "Stop initial", "Sortie", "R:R estimé", "Score", "Biais HTF",
            "Raisons", "Invalidation"} <= names
    json.dumps(e)
    json.dumps(followup_embed(sig, "exit", {"exit_price": 110.0, "exit_reason": "trail", "r_multiple": 1.9}))
    snd = DiscordSender({}, dry_run=True)
    assert snd.send(e) and snd.sent and snd.url is None


def test_ws_parsing_and_clock():
    assert closed_kline_open_time(json.dumps({"stream": "x", "data": {"k": {"t": 123, "x": True}}})) == 123
    assert closed_kline_open_time(json.dumps({"data": {"k": {"t": 123, "x": False}}})) is None
    assert closed_kline_open_time("not json") is None
    assert next_close_ms(M15 + 1) == 2 * M15


def test_decay_monitor():
    assert live_drawdown_r([1, -1, -1, -1, 2]) == 3
    ok, _ = check([0.5] * 60, 10.0, {"rolling_n": 50, "dd_mult": 1.5})
    assert ok
    ok, why = check([-0.1] * 60, 100.0, {"rolling_n": 50, "dd_mult": 1.5})
    assert not ok and "espérance" in why
    ok, why = check([-1.0] * 20, 10.0, {"rolling_n": 50, "dd_mult": 1.5})
    assert not ok and "drawdown" in why


def test_no_secret_in_the_repository():
    import re
    real_webhook = re.compile(r"discord(?:app)?\.com/api/webhooks/\d{5,}/[A-Za-z0-9_-]{20,}")
    files = subprocess.run(["git", "ls-files"], cwd=REPO_DIR, capture_output=True, text=True).stdout.split()
    assert "bot/.env" not in files
    for f in files:
        if f.endswith((".py", ".yaml", ".yml", ".md", ".json", ".example", ".mjs", ".js")):
            text = (REPO_DIR / f).read_text(encoding="utf-8", errors="ignore")
            assert not real_webhook.search(text), f
