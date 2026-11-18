"""Live scanner (Phase 4): one scan = update closed candles -> signals -> paper tracking -> events -> monitor.

A scan is idempotent: running it twice, or after a restart, never duplicates a signal, a status or an event.
The same concept code and the same engine as the backtest are used; only the data source differs.
"""
from __future__ import annotations

import copy
import json
import time

import numpy as np
import pandas as pd

from ..alerts.discord import DiscordSender, chart_png, followup_embed, signal_embed
from ..backtest.engine import SymbolMarket
from ..concepts import c1_trend_breakout as c1
from ..concepts import c2_trend_pullback as c2
from ..concepts import c3_mean_reversion as c3
from ..concepts import c4_funding_oi as c4
from ..concepts import c5_smc_reversal as c5
from ..concepts.base import SymbolData, variant_id
from ..core.config import REPO_DIR, resolve_path
from ..core.logs import get_logger
from ..core.timeutil import DAY_MS, month_of, to_ms
from ..core.types import Signal
from ..data.storage import MarketStore
from ..data.universe import classify_symbol
from ..monitor.decay import check as decay_check
from ..risk.portfolio import CorrelationGroups
from .state import StateStore
from .tracker import replay

log = get_logger(__name__)
MODULES = {"C1": c1, "C2": c2, "C3": c3, "C4": c4, "C5": c5}
M15 = 15 * 60_000


def live_cfg(cfg: dict) -> dict:
    """Configuration of the live market store: its own file, no final-test lock (it IS the forward data)."""
    c = copy.deepcopy(cfg)
    c["paths"]["market_db"] = cfg["live"]["market_db"]
    c["final_test"]["unlocked"] = True
    return c


def load_list(path_str: str) -> list[dict]:
    p = REPO_DIR / path_str
    if not p.exists():
        return []
    return json.loads(p.read_text(encoding="utf-8"))


def holdout_set() -> set[str]:
    p = REPO_DIR / "bot" / "reports" / "holdout_pairs.json"
    return set(json.loads(p.read_text())["held_out"]) if p.exists() else set()


# ---------------------------------------------------------------- data update

def update_symbol(store: MarketStore, client, symbol: str, now_ms: int, bootstrap_days: int) -> int:
    """Fetch every closed 15m candle missing since the last stored one (gap fill), or bootstrap the history."""
    last = store.candles(symbol, "15m", now_ms - 3 * DAY_MS)
    since = int(last["open_time"].iloc[-1]) + M15 if len(last) else now_ms - bootstrap_days * DAY_MS
    if not len(last):
        old = store.candles(symbol, "15m", now_ms - bootstrap_days * DAY_MS)
        if len(old):
            since = int(old["open_time"].iloc[-1]) + M15
    df = client.fetch_closed(symbol, "15m", since, now_ms)
    return store.upsert_candles(symbol, "15m", df) if len(df) else 0


def update_derivatives(store: MarketStore, client, symbol: str, now_ms: int, days: int) -> None:
    """Funding and open interest, only needed when a C4 variant is observed."""
    f = store.funding(symbol, now_ms - days * DAY_MS)
    since = int(f["time"].iloc[-1]) + 1 if len(f) else now_ms - days * DAY_MS
    fr = client.fetch_funding(symbol, since)
    if len(fr):
        store.upsert_funding(symbol, fr)
    o = store.open_interest(symbol, now_ms - days * DAY_MS)
    since = int(o["time"].iloc[-1]) + 1 if len(o) else now_ms - min(days, 29) * DAY_MS
    oi = client.fetch_open_interest(symbol, since)
    if len(oi):
        store.upsert_oi(symbol, oi)


def monthly_universe_live(state: StateStore, client, cfg: dict, month: str, now_ms: int) -> list[str]:
    """Top N by 30-day average quote volume of CLOSED days, computed once at the first scan of the month."""
    have = state.universe(month)
    if have:
        return have
    u = cfg["universe"]
    syms = [s for s in client.usdt_perpetuals() if classify_symbol(s, cfg)[0]]
    vol24 = client.quote_volume_24h(syms)
    cand = sorted(syms, key=lambda s: -vol24.get(s, 0.0))[: int(cfg["live"]["universe_candidates"])]
    month_start = to_ms(pd.Period(month, freq="M").start_time)
    scored = []
    for s in cand:
        d = client.fetch_closed(s, "1d", month_start - (int(u["volume_window_days"]) + 2) * DAY_MS, month_start)
        d = d[d["open_time"] + DAY_MS <= month_start].tail(int(u["volume_window_days"]))
        if len(d) < 0.9 * int(u["volume_window_days"]):
            continue
        avg = float(d["quote_volume"].sum() / int(u["volume_window_days"]))
        if avg >= float(u["min_avg_daily_quote_volume"]):
            scored.append((s, avg))
    scored.sort(key=lambda x: (-x[1], x[0]))
    top = scored[: int(u["top_n"])]
    state.set_universe(month, top)
    log.info("live universe", month=month, symbols=len(top))
    return [s for s, _ in top]


# ---------------------------------------------------------------- one scan

def build_market(store: MarketStore, cfg: dict, symbols: list[str], now_ms: int, days: int, need_deriv: bool):
    data, market = {}, {}
    for sym in symbols:
        df = store.candles(sym, "15m", now_ms - days * DAY_MS)
        df = df[df["open_time"] + M15 <= now_ms]                 # closed candles only
        if len(df) < 96 * 30:
            continue
        sd = SymbolData(sym, df, cfg)
        fund = store.funding(sym, now_ms - days * DAY_MS)
        if need_deriv:
            sd.funding = fund
            sd.oi = store.open_interest(sym, now_ms - days * DAY_MS)
        m = SymbolMarket(sym, df, "15m", fund, sd.bars["1d"].df, cfg)
        for tf in ("1h", "4h", "1d"):
            m.add_tf(tf, sd.bars[tf].df, donchian_ns=(16, 20, 24))
        data[sym], market[sym] = sd, m
    if need_deriv and data:
        allf = pd.concat([sd.funding.assign(h=(sd.funding["time"] // 3_600_000) * 3_600_000)
                          for sd in data.values() if sd.funding is not None and len(sd.funding)] or [pd.DataFrame({"h": [], "rate": []})])
        xs = allf.groupby("h")["rate"].median().reset_index()
        xs = pd.DataFrame({"time": xs["h"].to_numpy(dtype="int64"), "median": xs["rate"].to_numpy()})
        for sd in data.values():
            sd.xs_funding = xs
    return data, market


def _events_for(prev: dict | None, new: dict, sig: Signal, significant: float) -> list[tuple[str, int, dict]]:
    """Transitions between two tracking results of the same signal."""
    ev = []
    ps = prev["status"] if prev else None
    ns = new["status"]
    t_now = int(new.get("exit_time") or new.get("entry_time") or sig.generated_at)
    if prev is None:
        ev.append(("signal", sig.generated_at, {}))
    if ns in ("actif", "stop remonté", "sorti en gain", "sorti en perte") and (ps in (None, "en attente")):
        ev.append(("entry", int(new.get("entry_time") or sig.generated_at), new))
    if ns == "stop remonté" and prev and prev.get("stop") is not None and new.get("stop") is not None:
        atr = sig.atr if np.isfinite(sig.atr) and sig.atr > 0 else 0.0
        if abs(new["stop"] - prev["stop"]) >= significant * atr:
            last_move = new.get("stop_moves", [[t_now]])[-1][0]
            ev.append(("stop_moved", int(last_move), new))
    if ns in ("sorti en gain", "sorti en perte") and ps not in ("sorti en gain", "sorti en perte"):
        ev.append(("exit", int(new["exit_time"]), new))
    if ns == "expiré" and ps != "expiré":
        ev.append(("expired", sig.generated_at, new))
    if ns == "invalidé" and ps != "invalidé":
        ev.append(("invalidated", sig.generated_at, new))
    return ev


def run_scan(cfg: dict, client, now_ms: int | None = None, dry_run: bool = False, update: bool = True) -> dict:
    """One full scan. ``client`` implements fetch_closed / usdt_perpetuals / quote_volume_24h (/ funding, OI)."""
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    lc = cfg["live"]
    lcfg = live_cfg(cfg)
    store = MarketStore(lcfg)
    state = StateStore(cfg)
    observed = load_list(lc["observation_list"])
    # identifiers are always recomputed from the parameters: the same id as the backtest and as the signals
    validated = {variant_id(v["concept"], v["params"]) if "params" in v else v["variant"]
                 for v in load_list(lc["validated_list"])}
    need_deriv = any(v["concept"] == "C4" for v in observed)
    days = int(lc["bootstrap_days"])
    live_start = to_ms(lc["start"])
    month = month_of(now_ms)
    universe = monthly_universe_live(state, client, cfg, month, now_ms)
    st_now = state.status()
    open_ids = set(st_now.loc[st_now["status"].isin(["en attente", "actif", "stop remonté"]), "signal_id"]) if len(st_now) else set()
    sg = state.signals()
    open_syms = set(sg.loc[sg["id"].isin(open_ids), "symbol"]) if len(sg) else set()
    symbols = sorted(set(universe) | open_syms)
    if update:
        for sym in symbols:
            try:
                update_symbol(store, client, sym, now_ms, days)
                if need_deriv:
                    update_derivatives(store, client, sym, now_ms, 60)
            except Exception as exc:                       # one symbol failing never stops the scan
                log.error("update failed", symbol=sym, error=str(exc))
    data, market = build_market(store, cfg, symbols, now_ms, days, need_deriv)
    corr = CorrelationGroups({s: sd.bars["1d"].df for s, sd in data.items()}, cfg)
    hold = holdout_set()
    members_by_month: dict[str, set[str]] = {}
    summary = {"now": now_ms, "universe": len(universe), "symbols_with_data": len(data), "new_signals": 0,
               "events": 0, "sent": 0, "mode": lc["mode"], "variants": len(observed), "disabled": []}
    sender = DiscordSender(cfg, dry_run=dry_run or lc["mode"] != "alerts")
    for v in observed:
        concept = v["concept"]
        vid = variant_id(concept, v["params"])
        if not state.concept_enabled(vid):
            continue
        sigs = MODULES[concept].generate_signals(data, cfg, v["params"])
        keep = []
        for s in sigs:
            if s.generated_at < live_start or s.generated_at + 0 > now_ms:
                continue
            mth = month_of(s.generated_at)
            if mth not in members_by_month:
                # the universe of the signal's own month, decided with data closed before that month started
                members_by_month[mth] = set(state.universe(mth)) or set(
                    monthly_universe_live(state, client, cfg, mth, now_ms))
            if s.symbol in members_by_month[mth]:
                keep.append(s)
        new_ids = state.add_signals(keep, hold)
        summary["new_signals"] += len(new_ids)
        stored = [Signal.from_dict(json.loads(p)) for p in state.signals(vid)["payload"]]
        tracked = replay(stored, market, cfg, group_fn=corr.group)
        prev = state.status().set_index("signal_id").to_dict("index")
        by_id = {s.id: s for s in stored}
        for sid, st in tracked.items():
            old = prev.get(sid)
            old_d = None if old is None else {"status": old["status"], "stop": old["stop"]}
            for kind, at, payload in _events_for(old_d, st, by_id[sid], float(cfg["engine"]["significant_stop_move_atr"])):
                if state.add_event(sid, kind, at, {k: v for k, v in payload.items() if k != "stop_moves"}):
                    summary["events"] += 1
            if old is None or old["status"] != st["status"] or old["stop"] != st.get("stop"):
                state.set_status(sid, st)
        # anti-degradation monitor
        closed = sorted((st for st in tracked.values() if st["status"] in ("sorti en gain", "sorti en perte")),
                        key=lambda x: x["exit_time"])
        ok, why = decay_check([c["r_multiple"] for c in closed], float(v.get("backtest_max_dd_r", 0.0)), lc["monitor"])
        if not ok:
            state.set_concept(vid, False, why)
            state.add_event(vid, "concept_disabled", now_ms, {"reason": why})
            summary["disabled"].append({"variant": vid, "reason": why})
            log.warning("variant disabled", variant=vid, reason=why)
    # alerts: only validated variants in "alerts" mode; otherwise events stay private
    sigs_by_id = {r.id: r for r in state.signals().itertuples()}
    cooldown = float(lc["discord"]["cooldown_hours"]) * 3_600_000
    for e in state.unsent_events().itertuples():
        row = sigs_by_id.get(e.signal_id)
        if row is None or lc["mode"] != "alerts" or row.variant not in validated:
            continue
        sig = json.loads(row.payload)
        if e.kind == "signal":
            last = state.last_event_ms(row.symbol, row.concept)
            if (last is not None and e.at_ms - last < cooldown) or sig.get("score", 0) < float(lc["discord"]["min_score"]):
                state.mark_sent(e.id)
                continue
            ok = sender.send(signal_embed(sig), chart_png(market.get(row.symbol), sig, int(lc["discord"]["chart_candles"])))
        else:
            ok = sender.send(followup_embed(sig, e.kind, json.loads(e.payload)))
        if ok:
            state.mark_sent(e.id)
            summary["sent"] += 1
    state.put("last_scan_ms", str(now_ms))
    log.info("scan done", **{k: v for k, v in summary.items() if k != "disabled"})
    return summary
