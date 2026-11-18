"""Command line entry point.

    python -m bot.main catalog            # symbol catalogue + frozen held-out list (names only)
    python -m bot.main download-daily     # 1d candles of every eligible symbol (universe ranking)
    python -m bot.main universe           # point-in-time top-N per month
    python -m bot.main download-long      # 15m candles + funding of every symbol ever in the universe
    python -m bot.main download-fine      # 1m candles of the last 12 months (universe members)
    python -m bot.main oi-depth           # first/last day of open-interest archives per symbol
    python -m bot.main quality            # data quality report (bot/reports/data_quality.md)
    python -m bot.main regression         # engine regression against perp-setups study 1
    python -m bot.main phase2             # C1 + C2 on BTC/ETH, walk-forward, report bot/reports/phase2/PHASE2.md

Phase 2+ commands (backtest, tournament, scan, live) are added with their phase.
"""
from __future__ import annotations

import argparse
import json
import sys

from .core.config import load_config, resolve_path
from .core.logs import get_logger, setup_logging
from .core.timeutil import month_of, month_start_ms, months_between, to_ms

log = get_logger("bot.main")


def _store(cfg):
    from .data.storage import MarketStore
    return MarketStore(cfg)


def cmd_catalog(cfg, args) -> None:
    from .data.fetcher import ArchiveClient
    from .data.universe import classify_symbol, freeze_holdout
    store, client = _store(cfg), ArchiveClient(cfg)
    symbols = client.symbols()
    rows, eligible = [], []
    for s in symbols:
        ok, base, reason = classify_symbol(s, cfg)
        rows.append((s, base, int(ok), reason, None, None))
        if ok:
            eligible.append(s)
    store.set_catalog(rows)
    log.info("catalogue", archive_symbols=len(symbols), eligible=len(eligible))
    if store.holdout().empty:
        h = freeze_holdout(store, cfg, eligible)
        log.info("held-out list frozen", held_out=int(h["holdout"].sum()), total=len(h))
        out = resolve_path(cfg, "reports") / "holdout_pairs.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({
            "frozen_at": h["frozen_at"].iloc[0], "rule": h["rule"].iloc[0],
            "held_out": sorted(h.loc[h["holdout"] == 1, "symbol"].tolist()),
            "development": sorted(h.loc[h["holdout"] == 0, "symbol"].tolist()),
        }, indent=1) + "\n", encoding="utf-8")
    else:
        log.info("held-out list already frozen, unchanged")


def cmd_reclassify(cfg, args) -> None:
    """Re-apply the eligibility rules of config.yaml to the catalogue (keeps months and the held-out list)."""
    from .data.universe import classify_symbol
    store = _store(cfg)
    cat = store.catalog(eligible_only=False)
    with store.tx() as con:
        for s in cat["symbol"]:
            ok, base, reason = classify_symbol(s, cfg)
            con.execute("UPDATE catalog SET eligible=?, reason=?, base=? WHERE symbol=?", (int(ok), reason, base, s))
    log.info("catalogue reclassified", eligible=int(len(store.catalog())))


def _periods_upto(client, kind, symbol, tf, last_month):
    from .data.fetcher import month_range_closed
    return month_range_closed(client.periods(kind, symbol, tf), last_month)


def cmd_download_daily(cfg, args) -> None:
    from concurrent.futures import ThreadPoolExecutor
    from .data.fetcher import ArchiveClient, kline_jobs, parse_klines
    store, client = _store(cfg), ArchiveClient(cfg)
    syms = store.catalog()["symbol"].tolist()
    if args.symbols:
        syms = [s for s in syms if s in args.symbols]
    last = cfg["data"]["last_month"]
    first = cfg["data"]["history_start"][:7]
    with ThreadPoolExecutor(max_workers=client.workers) as pool:
        periods = dict(zip(syms, pool.map(lambda s: _periods_upto(client, "klines", s, "1d", last), syms)))
    jobs = []
    for s, months in periods.items():
        months = [m for m in months if m >= first]
        jobs += kline_jobs(client, s, "1d", months)
        if months:
            with store.tx() as con:
                con.execute("UPDATE catalog SET first_month=?, last_month=? WHERE symbol=?", (months[0], months[-1], s))
    stats = client.ingest(store, jobs, parse_klines, lambda sym, tf, df: store.upsert_candles(sym, tf, df))
    log.info("daily candles", **stats)


def cmd_universe(cfg, args) -> None:
    from .data.universe import build_universe
    store = _store(cfg)
    u = build_universe(store, cfg)
    log.info("universe built", months=u["month"].nunique(), distinct_symbols=u["symbol"].nunique())


def _long_symbols(cfg, store) -> list[str]:
    u = store.universe()
    syms = set(u["symbol"])
    syms |= set(cfg["holdout"]["already_used"][:20])   # study 1 pairs, needed by the engine regression test
    eligible = set(store.catalog()["symbol"])
    return sorted(syms & eligible)


def cmd_download_long(cfg, args) -> None:
    from .data.fetcher import ArchiveClient, funding_jobs, kline_jobs, parse_funding, parse_klines
    store, client = _store(cfg), ArchiveClient(cfg)
    syms = args.symbols or _long_symbols(cfg, store)
    tf = cfg["data"]["long_tf"]
    last = cfg["data"]["last_month"]
    first = cfg["data"]["history_start"][:7]
    cat = store.catalog().set_index("symbol")
    jobs_k, jobs_f = [], []
    for s in syms:
        f0 = max(first, cat.loc[s, "first_month"] or first) if s in cat.index else first
        l0 = min(last, cat.loc[s, "last_month"] or last) if s in cat.index else last
        months = months_between(f0, l0)
        jobs_k += kline_jobs(client, s, tf, months)
        jobs_f += funding_jobs(client, s, months)
    log.info("long download", symbols=len(syms), kline_files=len(jobs_k), funding_files=len(jobs_f))
    st_k = client.ingest(store, jobs_k, parse_klines, lambda sym, t, df: store.upsert_candles(sym, t, df))
    log.info("15m candles", **st_k)
    st_f = client.ingest(store, jobs_f, parse_funding, lambda sym, t, df: store.upsert_funding(sym, df))
    log.info("funding", **st_f)


def cmd_download_fine(cfg, args) -> None:
    import pandas as pd
    from .data.fetcher import ArchiveClient, kline_jobs, parse_klines
    store, client = _store(cfg), ArchiveClient(cfg)
    last = cfg["data"]["last_month"]
    first = str(pd.Period(last, freq="M") - int(cfg["data"]["fine_months"]) + 1)
    u = store.universe()
    u = u[(u["month"] >= first) & (u["month"] <= last)]
    jobs = []
    for s, months in u.groupby("symbol")["month"]:
        if args.symbols and s not in args.symbols:
            continue
        jobs += kline_jobs(client, s, cfg["data"]["fine_tf"], sorted(months))
    log.info("fine download", files=len(jobs))
    st = client.ingest(store, jobs, parse_klines, lambda sym, t, df: store.upsert_candles(sym, t, df))
    log.info("1m candles", **st)


def cmd_native_check(cfg, args) -> None:
    """Download native 1h/4h/1d archives of a few symbol-months to check the resampler."""
    from .data.fetcher import ArchiveClient, kline_jobs, parse_klines
    store, client = _store(cfg), ArchiveClient(cfg)
    months = args.months or ["2021-05", "2024-03", "2026-10"]
    jobs = []
    for s in args.symbols or ["BTCUSDT", "ETHUSDT", "DOGEUSDT"]:
        for tf in cfg["data"]["native_check_tfs"]:
            if tf == "1d":
                continue  # 1d is already stored natively
            jobs += kline_jobs(client, s, tf, months)
    st = client.ingest(store, jobs, parse_klines, lambda sym, t, df: store.upsert_candles(sym, t, df))
    log.info("native archives", **st)


def cmd_oi_depth(cfg, args) -> None:
    from concurrent.futures import ThreadPoolExecutor
    from .data.fetcher import ArchiveClient
    store, client = _store(cfg), ArchiveClient(cfg)
    syms = args.symbols or sorted(set(store.universe()["symbol"]))
    lock_day = cfg["final_test"]["start"]

    def _one(s):
        try:
            days = [d for d in client.periods("metrics", s, None, freq="daily") if d < lock_day]
        except Exception as exc:  # reported, not hidden
            return s, None, None, 0, str(exc)
        return s, (days[0] if days else None), (days[-1] if days else None), len(days), ""

    with ThreadPoolExecutor(max_workers=client.workers) as pool:
        rows = list(pool.map(_one, syms))
    out = resolve_path(cfg, "reports") / "oi_depth.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps([{"symbol": s, "first_day": a, "last_day": b, "n_days": n, "error": e}
                               for s, a, b, n, e in rows], indent=1) + "\n", encoding="utf-8")
    log.info("oi depth written", path=str(out), symbols=len(rows))


def cmd_quality(cfg, args) -> None:
    from .data.quality import write_quality_report
    path = write_quality_report(cfg, _store(cfg))
    log.info("quality report", path=str(path))


def cmd_regression(cfg, args) -> None:
    from .backtest.reference_study1 import run_regression
    res = run_regression(cfg, _store(cfg))
    print(json.dumps(res, indent=1, default=str))


def cmd_phase2(cfg, args) -> None:
    from .backtest.report import write_phase2_report
    from .backtest.tournament import run_phase2
    res = run_phase2(cfg, _store(cfg), None)
    path = write_phase2_report(res, resolve_path(cfg, "reports") / "phase2", cfg)
    log.info("phase 2 report", path=str(path), seconds=round(res["seconds"]))


COMMANDS = {
    "catalog": cmd_catalog,
    "reclassify": cmd_reclassify,
    "download-daily": cmd_download_daily,
    "universe": cmd_universe,
    "download-long": cmd_download_long,
    "download-fine": cmd_download_fine,
    "native-check": cmd_native_check,
    "oi-depth": cmd_oi_depth,
    "quality": cmd_quality,
    "regression": cmd_regression,
    "phase2": cmd_phase2,
}


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="bot")
    p.add_argument("command", choices=sorted(COMMANDS))
    p.add_argument("--symbols", nargs="*")
    p.add_argument("--months", nargs="*")
    p.add_argument("--log-level", default="INFO")
    args = p.parse_args(argv)
    cfg = load_config()
    setup_logging(args.log_level, resolve_path(cfg, "reports").parent / "var" / "bot.log")
    COMMANDS[args.command](cfg, args)


if __name__ == "__main__":
    main(sys.argv[1:])
