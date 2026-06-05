# SMC Trading-Signal Bot 📡

A Python bot that continuously monitors **Binance USDT-M Futures** and pushes
high-probability **LONG / SHORT** alerts to a **Discord webhook**, with precise
**Entry / Stop-Loss / Take-Profit** levels derived from **Smart Money Concepts
(SMC)** structure and multi-timeframe confluence.

---

## ✨ Features

- **Dynamic watch-list** — top 10 Binance Futures pairs by 24h volume, plus the
  always-on fixed pairs `ASTR/USDT`, `HYPE/USDT`, `ONDO/USDT`.
- **Multi-timeframe confluence** — `1D` (macro bias), `4H` (trend + OB/FVG),
  `1H` (entry + BOS/CHOCH), `15m` (timing + SL refinement). A signal needs at
  least **3 of 4 timeframes aligned**.
- **Smart Money Concepts** — Order Blocks, Fair Value Gaps, BOS/CHOCH,
  liquidity sweeps (equal highs/lows), RSI divergence.
- **Classic filters** — EMA 21/50/200 alignment, RSI(14) momentum window,
  volume spike (> 1.5× the 20-period average), ATR(14) volatility label.
- **SMC-based SL/TP** — SL beyond the tapped OB wick (+0.2% buffer), three TPs
  scaled to ~1:1.5 / 1:2.5 / 1:4 RR and snapped toward real structure levels.
- **Discord embeds** — green for LONG, red for SHORT, matching the spec layout.
- **Anti-spam** — never repeats the same pair+direction within 4 hours.
- **Resilient loop** — catches all API errors, backs off on rate limits, and
  never crashes; scans every 5 minutes.

---

## 📂 Project structure

```
trading-bot/
├── main.py           # Entry point, watch-list, data fetch, scan loop
├── indicators.py     # All TA calculations (OB, FVG, BOS, EMA, RSI, ATR, Volume)
├── signals.py        # Signal detection logic and scoring
├── discord_alert.py  # Discord embed builder and sender
├── config.py         # Pairs list, timeframes, thresholds
├── .env.example      # Template for your secrets (copy to .env)
├── .gitignore
└── requirements.txt
```

---

## 1. Installation

Requires **Python 3.11+**.

```bash
cd trading-bot
python -m venv .venv && source .venv/bin/activate   # optional but recommended
pip install -r requirements.txt
```

---

## 2. Configure `.env`

Copy the template and fill in your values:

```bash
cp .env.example .env
```

```dotenv
# Required — the Discord webhook that receives alerts
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/XXXX/YYYY

# Optional — a read-only Binance API key raises rate limits
# (public market data works without keys)
BINANCE_API_KEY=
BINANCE_API_SECRET=
```

**Creating the Discord webhook:** Server Settings → *Integrations* →
*Webhooks* → *New Webhook* → copy the URL into `DISCORD_WEBHOOK_URL`.

---

## 3. Run

```bash
python main.py
```

The bot logs every scanned pair to the console and writes every emitted alert
to `alerts.log`. It scans on a loop every 5 minutes — leave it running.

Stop it any time with `Ctrl+C`.

---

## 4. Add / remove pairs

Everything is driven from **`config.py`**:

```python
# Always-monitored pairs (regardless of volume ranking)
FIXED_PAIRS = [
    "ASTR/USDT",
    "HYPE/USDT",
    "ONDO/USDT",
    # "TIA/USDT",   # <- add your own here
]

# How many top-volume pairs to auto-include
TOP_N_PAIRS = 10
```

Other useful knobs in `config.py`:

| Setting | Meaning |
|---|---|
| `MIN_CONFLUENCE_SCORE` | Minimum score (out of 6) to emit a signal |
| `MIN_TIMEFRAMES_ALIGNED` | Timeframes that must agree (default 3/4) |
| `VOLUME_SPIKE_MULTIPLIER` | Volume spike threshold (default 1.5×) |
| `RSI_LONG_MIN/MAX`, `RSI_SHORT_MIN/MAX` | RSI momentum windows |
| `SL_BUFFER` | Stop-loss buffer beyond the OB wick (default 0.2%) |
| `TP_RR` | Take-profit RR multiples (default 1.5 / 2.5 / 4.0) |
| `SCAN_INTERVAL_SECONDS` | Scan cadence (default 300s) |
| `ALERT_COOLDOWN_SECONDS` | Anti-spam window (default 4h) |

---

## 📨 Example alert

```
🟢 LONG SIGNAL — BTC/USDT

📍 Entry zone : $67,420.00 – $67,510.00
🛑 Stop Loss  : $66,980.00  (-0.71%)
🎯 TP1        : $68,150.00  (+1.07%) — RR 1:1.5
🎯 TP2        : $68,640.00  (+1.79%) — RR 1:2.5
🎯 TP3        : $69,380.00  (+2.86%) — RR 1:4.0

📊 Confluence score : 5/6
⏱ Timeframes OK    : 1D ✅ | 4H ✅ | 1H ✅ | 15m ❌
📈 RSI (1H)        : 58.2
⚡ Volatilité ATR  : Medium
🧱 Trigger         : OB + Liquidity sweep

⏰ 2026-06-05 22:20:00 UTC
```

---

## ⚠️ Disclaimer

This bot generates **informational trading signals only**. It is **not financial
advice** and does **not place orders**. Crypto futures are high-risk — always do
your own research and manage your risk. Use a **read-only** Binance API key.
