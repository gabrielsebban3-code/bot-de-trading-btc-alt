"""Transcription faster-whisper (mise en cache SQLite par vidéo et par modèle)."""
import logging

log = logging.getLogger(__name__)
_models = {}


def get_model(tcfg):
    from faster_whisper import WhisperModel  # import tardif : lourd

    key = (tcfg["model"], tcfg["compute_type"])
    if key not in _models:
        log.info("Chargement du modèle Whisper %s", tcfg["model"])
        _models[key] = WhisperModel(tcfg["model"], device="auto", compute_type=tcfg["compute_type"])
    return _models[key]


def load_wav(wav_path):
    """WAV mono 16 kHz -> float32. Évite faster_whisper.decode_audio, incompatible avec PyAV >= 14."""
    import wave

    import numpy as np

    with wave.open(str(wav_path), "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def detect_language(wav_path, tcfg, duration):
    """Langue détectée sur 30 s prises après l'intro (évite la musique de début)."""
    audio = load_wav(wav_path)
    off = int(min(60, duration / 3) * 16000)
    lang, prob, _ = get_model(tcfg).detect_language(audio=audio[off:off + 30 * 16000])
    return lang, prob


def transcribe(wav_path, vid, tcfg, db):
    key = f"tr:{vid}:{tcfg['model']}"
    cached = db.cache_get(key)
    if cached is not None:
        return cached
    segs, _ = get_model(tcfg).transcribe(load_wav(wav_path), language=tcfg["language"], vad_filter=True)
    out = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segs if s.text.strip()]
    db.cache_set(key, out)
    return out
