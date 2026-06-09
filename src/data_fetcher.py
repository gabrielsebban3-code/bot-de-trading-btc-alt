"""
Récupération des données de marché (klines/OHLCV) — multi-exchange avec fallback.

⚠️ Pourquoi un fallback ? Binance.com bloque les IP de datacenter/cloud (US
notamment), or Railway tourne sur des IP cloud US. Pour que le bot fonctionne
quel que soit l'hébergeur, on essaie plusieurs exchanges dans l'ordre et on
garde le premier qui répond : Binance → Bybit → OKX → KuCoin.

Tous les adaptateurs renvoient un format NORMALISÉ identique : un DataFrame
avec les colonnes open, high, low, close, volume + open_time/close_time (UTC),
trié par ordre chronologique croissant, sans la bougie en cours (non clôturée).

Aucune clé API nécessaire (données de marché publiques uniquement).
"""

import time
import logging

import requests
import pandas as pd

import config

logger = logging.getLogger("bot.data")

_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; BotIntraday/1.0)"}

# Durée d'un intervalle en millisecondes (sert à calculer close_time et à
# retirer la bougie non clôturée).
_INTERVAL_MS = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
    "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000,
    "1d": 86_400_000,
}


class ProviderError(Exception):
    """Erreur lors de la récupération chez un exchange donné."""


# ---------------------------------------------------------------------------
# Helpers de symbole
# ---------------------------------------------------------------------------
_QUOTES = ("USDT", "USDC", "BUSD", "USD")


def _split_symbol(symbol: str) -> tuple[str, str]:
    """'BTCUSDT' -> ('BTC', 'USDT')."""
    for q in _QUOTES:
        if symbol.endswith(q):
            return symbol[: -len(q)], q
    return symbol, "USDT"


def _dashed(symbol: str) -> str:
    """'BTCUSDT' -> 'BTC-USDT' (OKX, KuCoin)."""
    base, quote = _split_symbol(symbol)
    return f"{base}-{quote}"


# ---------------------------------------------------------------------------
# Adaptateurs par exchange : renvoient une liste de lignes
# [open_time_ms, open, high, low, close, volume] triée croissante.
# ---------------------------------------------------------------------------
def _adapter_binance(symbol, interval, limit):
    binance_int = interval  # même format ("15m", "1h")
    url = config.BINANCE_BASE_URL + "/api/v3/klines"
    params = {"symbol": symbol, "interval": binance_int, "limit": limit}
    data = _get_json(url, params)
    if not isinstance(data, list):
        raise ProviderError(f"binance: réponse inattendue {str(data)[:120]}")
    return [[int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])]
            for r in data]


def _adapter_bybit(symbol, interval, limit):
    bmap = {"1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
            "1h": "60", "2h": "120", "4h": "240", "1d": "D"}
    url = "https://api.bybit.com/v5/market/kline"
    params = {"category": "spot", "symbol": symbol,
              "interval": bmap[interval], "limit": min(limit, 1000)}
    data = _get_json(url, params)
    if data.get("retCode") != 0:
        raise ProviderError(f"bybit: {data.get('retMsg')}")
    rows = data["result"]["list"]  # ordre décroissant (récent -> ancien)
    out = [[int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])]
           for r in rows]
    out.reverse()
    return out


def _adapter_okx(symbol, interval, limit):
    omap = {"1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
            "1h": "1H", "2h": "2H", "4h": "4H", "1d": "1D"}
    url = "https://www.okx.com/api/v5/market/candles"
    params = {"instId": _dashed(symbol), "bar": omap[interval], "limit": min(limit, 300)}
    data = _get_json(url, params)
    if data.get("code") != "0":
        raise ProviderError(f"okx: {data.get('msg')}")
    rows = data["data"]  # ordre décroissant ; [ts,o,h,l,c,vol,...]
    out = [[int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])]
           for r in rows]
    out.reverse()
    return out


def _adapter_kucoin(symbol, interval, limit):
    kmap = {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min",
            "1h": "1hour", "4h": "4hour", "1d": "1day"}
    url = "https://api.kucoin.com/api/v1/market/candles"
    params = {"type": kmap[interval], "symbol": _dashed(symbol)}
    data = _get_json(url, params)
    if str(data.get("code")) != "200000":
        raise ProviderError(f"kucoin: {data.get('msg')}")
    # KuCoin : [time(sec), open, close, high, low, volume, turnover], décroissant.
    rows = data["data"]
    out = [[int(r[0]) * 1000, float(r[1]), float(r[3]), float(r[4]), float(r[2]), float(r[5])]
           for r in rows]
    out.reverse()
    return out


_ADAPTERS = {
    "binance": _adapter_binance,
    "bybit": _adapter_bybit,
    "okx": _adapter_okx,
    "kucoin": _adapter_kucoin,
}


def _get_json(url, params, timeout=15):
    """GET + parse JSON. Lève ProviderError sur erreur réseau/HTTP."""
    try:
        resp = requests.get(url, params=params, headers=_HEADERS, timeout=timeout)
    except requests.RequestException as exc:
        raise ProviderError(f"réseau: {exc}") from exc
    if resp.status_code != 200:
        raise ProviderError(f"HTTP {resp.status_code}: {resp.text[:120]}")
    try:
        return resp.json()
    except ValueError as exc:
        raise ProviderError(f"JSON invalide: {exc}") from exc


# ---------------------------------------------------------------------------
# Normalisation commune
# ---------------------------------------------------------------------------
def _normalize(rows, interval) -> pd.DataFrame:
    """Liste de lignes -> DataFrame propre, trié, sans bougie non clôturée."""
    df = pd.DataFrame(rows, columns=["open_time", "open", "high", "low", "close", "volume"])
    df = df.sort_values("open_time").reset_index(drop=True)

    step = _INTERVAL_MS.get(interval, 900_000)
    df["close_time_ms"] = df["open_time"] + step
    now_ms = int(time.time() * 1000)
    df = df[df["close_time_ms"] <= now_ms].reset_index(drop=True)  # retire bougie en cours

    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    df["close_time"] = pd.to_datetime(df["close_time_ms"], unit="ms", utc=True)
    return df[["open_time", "open", "high", "low", "close", "volume", "close_time"]]


# ---------------------------------------------------------------------------
# Source de données avec fallback + mémorisation du provider qui marche
# ---------------------------------------------------------------------------
class DataSource:
    def __init__(self, providers: list[str]):
        self.providers = [p for p in providers if p in _ADAPTERS]
        if not self.providers:
            self.providers = ["binance"]
        self._preferred: str | None = None

    def fetch(self, symbol: str, interval: str, limit: int = 200) -> pd.DataFrame | None:
        # On essaie d'abord le provider qui a déjà fonctionné, puis les autres.
        order = ([self._preferred] if self._preferred else []) + \
                [p for p in self.providers if p != self._preferred]

        last_err = None
        for provider in order:
            try:
                rows = _ADAPTERS[provider](symbol, interval, limit)
                if not rows:
                    raise ProviderError("aucune donnée")
                df = _normalize(rows, interval)
                if self._preferred != provider:
                    logger.info("Source de données : %s (%d bougies %s %s)",
                                provider, len(df), symbol, interval)
                    self._preferred = provider
                return df
            except ProviderError as exc:
                last_err = exc
                logger.debug("%s a échoué pour %s %s : %s", provider, symbol, interval, exc)
                continue
        logger.warning("Tous les providers ont échoué pour %s %s. Dernière erreur : %s",
                       symbol, interval, last_err)
        return None


# Singleton réutilisé par tout le bot.
_source = DataSource(config.DATA_PROVIDERS)


def fetch_ohlcv(symbol: str, interval: str, limit: int = 200) -> pd.DataFrame | None:
    """Point d'entrée public — délègue au DataSource avec fallback."""
    return _source.fetch(symbol, interval, limit)
