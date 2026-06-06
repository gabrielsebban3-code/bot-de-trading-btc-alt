"""
Boucle principale du bot de trading SMC.
Scan 13 paires Binance Futures toutes les 15 minutes et envoie les signaux sur Discord.
Conçu pour Railway : worker pur, logs vers stdout, pas de serveur web.
"""

import sys
import time
import logging
from datetime import datetime, timezone

import ccxt
import pandas as pd
from dotenv import load_dotenv

from config import PAIRS, SCAN_INTERVAL, TIMEFRAMES, CANDLES_LIMIT, SIGNAL_COOLDOWN, API_RETRY_COUNT, API_RETRY_DELAY
from signal_engine import analyze_pair
from discord_notifier import send_signal, send_startup_message

# ── Configuration du logging vers stdout (requis pour Railway) ──────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

load_dotenv()

# ── Anti-doublon en mémoire : {pair: timestamp_dernier_signal} ──────────────
last_signal_time: dict[str, float] = {}


def create_exchange() -> ccxt.binance:
    """
    Initialise la connexion à Binance Futures via ccxt en mode public.
    Pas de clés API requises — données de marché uniquement, aucune restriction géographique.
    """
    exchange = ccxt.binance({
        "options": {
            "defaultType": "future",  # Binance Futures USDT perpetual
        },
        "enableRateLimit": True,
    })
    return exchange


def fetch_candles(exchange: ccxt.binance, pair: str, timeframe: str, limit: int) -> pd.DataFrame | None:
    """
    Récupère les bougies OHLCV pour une paire et un timeframe donnés.
    Retente jusqu'à API_RETRY_COUNT fois en cas d'erreur.
    """
    for attempt in range(1, API_RETRY_COUNT + 1):
        try:
            ohlcv = exchange.fetch_ohlcv(pair, timeframe=timeframe, limit=limit)
            if not ohlcv:
                return None

            df = pd.DataFrame(ohlcv, columns=["timestamp", "open", "high", "low", "close", "volume"])
            df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
            df = df.set_index("timestamp")
            df = df.astype(float)
            return df

        except ccxt.NetworkError as e:
            logger.warning(f"Erreur réseau [{pair} {timeframe}] tentative {attempt}/{API_RETRY_COUNT} : {e}")
            if attempt < API_RETRY_COUNT:
                time.sleep(API_RETRY_DELAY * attempt)
        except ccxt.ExchangeError as e:
            logger.error(f"Erreur exchange [{pair} {timeframe}] : {e}")
            return None
        except Exception as e:
            logger.error(f"Erreur inattendue [{pair} {timeframe}] : {e}")
            return None

    return None


def fetch_all_timeframes(exchange: ccxt.binance, pair: str) -> dict | None:
    """
    Récupère les bougies pour les 4 timeframes d'une paire.
    Retourne un dict {tf: DataFrame} ou None si une requête échoue.
    """
    candles = {}
    for tf_key, tf_value in TIMEFRAMES.items():
        df = fetch_candles(exchange, pair, tf_value, CANDLES_LIMIT)
        if df is None:
            logger.warning(f"Impossible de récupérer {pair} {tf_value} — paire ignorée")
            return None
        candles[tf_key] = df
        # Petite pause pour respecter le rate limit
        time.sleep(0.2)
    return candles


def is_signal_on_cooldown(pair: str) -> bool:
    """
    Vérifie si un signal a déjà été envoyé pour cette paire dans les dernières 4h.
    Anti-doublon en mémoire — se remet à zéro au redémarrage.
    """
    last_time = last_signal_time.get(pair)
    if last_time is None:
        return False
    elapsed = time.time() - last_time
    return elapsed < SIGNAL_COOLDOWN


def scan_pair(exchange: ccxt.binance, pair: str) -> None:
    """Analyse une paire et envoie le signal sur Discord si les conditions sont réunies."""
    if is_signal_on_cooldown(pair):
        logger.debug(f"[{pair}] Signal en cooldown — ignoré")
        return

    candles = fetch_all_timeframes(exchange, pair)
    if candles is None:
        return

    signal = analyze_pair(pair, candles)

    if signal is not None:
        logger.info(
            f"🎯 SIGNAL DÉTECTÉ [{pair}] {signal['direction'].upper()} "
            f"— Score {signal['confluence_score']}/6 "
            f"— {signal['tf_aligned']}/4 TF alignés"
        )
        sent = send_signal(signal)
        if sent:
            last_signal_time[pair] = time.time()
    else:
        logger.debug(f"[{pair}] Aucun signal — conditions non remplies")


def run_scan_cycle(exchange: ccxt.binance) -> None:
    """Exécute un cycle complet de scan sur toutes les paires."""
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    logger.info(f"─── Début du scan [{now_utc}] — {len(PAIRS)} paires ───")

    for pair in PAIRS:
        try:
            logger.info(f"📡 Analyse {pair}...")
            scan_pair(exchange, pair)
        except Exception as e:
            logger.error(f"Erreur lors du scan de {pair} : {e}")

    logger.info(f"─── Scan terminé — prochain scan dans {SCAN_INTERVAL // 60} minutes ───")


def main() -> None:
    """Point d'entrée principal du bot."""
    logger.info("=" * 60)
    logger.info(f"✅ Bot démarré — {len(PAIRS)} paires surveillées")
    logger.info(f"📡 Scan interval : {SCAN_INTERVAL // 60} minutes")
    logger.info(f"💹 Paires : {', '.join(PAIRS)}")
    logger.info("=" * 60)

    # Initialiser la connexion Binance en mode public (sans clés API)
    try:
        exchange = create_exchange()
        # Test de connexion via endpoint public uniquement
        exchange.fetch_ticker("BTC/USDT")
        logger.info("✅ Connexion Binance Futures établie (mode public)")
    except Exception as e:
        logger.error(f"❌ Impossible de se connecter à Binance : {e}")
        sys.exit(1)

    # Notifier Discord du démarrage
    send_startup_message(len(PAIRS))

    # Boucle principale
    while True:
        try:
            run_scan_cycle(exchange)
        except KeyboardInterrupt:
            logger.info("🛑 Bot arrêté manuellement")
            break
        except Exception as e:
            logger.error(f"Erreur critique dans le cycle de scan : {e}")
            # Continuer malgré l'erreur — Railway va redémarrer si le process plante

        logger.info(f"💤 Attente {SCAN_INTERVAL // 60} minutes...")
        time.sleep(SCAN_INTERVAL)


if __name__ == "__main__":
    main()
