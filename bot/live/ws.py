"""Live mode (Step 1): Binance websocket as the clock of closed candles, automatic reconnection, gap fill.

The websocket only says WHEN a 15m candle has closed (kline event with ``x: true``). Each close triggers one scan,
which downloads every missing closed candle over REST (gap fill after any disconnection) and runs the same code
as the backtest. If the websocket cannot be reached (e.g. HTTP 451 from some countries), the loop falls back to
a timer aligned on the 15m closes (UTC).
"""
from __future__ import annotations

import asyncio
import json
import time

from ..core.logs import get_logger

log = get_logger(__name__)
WS_URL = "wss://fstream.binance.com/stream?streams=btcusdt@kline_15m"
M15 = 15 * 60_000


def closed_kline_open_time(message: str) -> int | None:
    """Open time of a CLOSED kline in a combined-stream message, else None (candle still in progress)."""
    try:
        data = json.loads(message)
        k = data.get("data", data).get("k")
    except (ValueError, AttributeError):
        return None
    if not k or not k.get("x"):
        return None
    return int(k["t"])


def next_close_ms(now_ms: int, step: int = M15) -> int:
    return (now_ms // step + 1) * step


async def _scan(cfg: dict, dry_run: bool) -> None:
    from ..data.fetcher import LiveClient
    from .scanner import run_scan
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, lambda: run_scan(cfg, LiveClient(), dry_run=dry_run))
    except Exception as exc:          # a failed scan is logged; the next close retries (gap fill)
        log.error("scan failed", error=str(exc))


async def run_forever(cfg: dict, dry_run: bool = False, max_backoff: float = 60.0) -> None:
    import websockets
    delay = float(cfg["live"]["scan_delay_s"])
    await _scan(cfg, dry_run)                       # catch up immediately (gap fill)
    backoff, failures = 1.0, 0
    while True:
        try:
            async with websockets.connect(WS_URL, ping_interval=20, ping_timeout=20) as ws:
                log.info("websocket connected")
                backoff, failures = 1.0, 0
                await _scan(cfg, dry_run)           # anything missed while disconnected
                while True:
                    msg = await asyncio.wait_for(ws.recv(), timeout=120)
                    if closed_kline_open_time(msg) is not None:
                        await asyncio.sleep(delay)
                        await _scan(cfg, dry_run)
        except Exception as exc:
            failures += 1
            log.warning("websocket down, reconnecting", error=str(exc), backoff_s=backoff, failures=failures)
            if failures >= 5:
                # timer fallback until the next reconnection attempt
                now = int(time.time() * 1000)
                await asyncio.sleep(max(0.0, (next_close_ms(now) - now) / 1000.0) + delay)
                await _scan(cfg, dry_run)
            else:
                await asyncio.sleep(backoff)
            backoff = min(max_backoff, backoff * 2)
