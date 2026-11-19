"""Transcription faster-whisper (mise en cache SQLite par vidéo et par modèle)."""
import hashlib
import json
import logging
import os

log = logging.getLogger(__name__)
_models = {}


def get_model(tcfg):
    from faster_whisper import WhisperModel  # import tardif : lourd

    threads = int(tcfg.get("cpu_threads") or 0) or (os.cpu_count() or 4)  # défaut ctranslate2 : 4 cœurs
    key = (tcfg["model"], tcfg["compute_type"], threads)
    if key not in _models:
        log.info("Chargement du modèle Whisper %s (%d cœurs)", tcfg["model"], threads)
        _models[key] = WhisperModel(tcfg["model"], device="auto", compute_type=tcfg["compute_type"],
                                    cpu_threads=threads)
    return _models[key]


# mode -> (transcrire seulement autour des moments candidats, beam_size)
MODES = {"complete": (False, 5), "rapide": (True, 5), "tres_rapide": (True, 1)}


def mode_of(tcfg):
    return MODES.get(tcfg.get("mode", "complete"), MODES["complete"])


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


def transcribe(wav_path, vid, tcfg, db, on_progress=None, regions=None):
    """Segments + horaires par mot. regions=[(début, fin)] : ne transcrit que ces zones (mode rapide).
    on_progress(pourcentage) tous les 5 %."""
    beam = mode_of(tcfg)[1]
    key = f"trw:{vid}:{tcfg['model']}" + (f":b{beam}" if beam != 5 else "")
    if regions:
        key += ":" + hashlib.md5(json.dumps(regions).encode()).hexdigest()[:10]
    cached = db.cache_get(key)
    if cached is not None:
        return cached
    audio = load_wav(wav_path)
    regions = regions or [(0.0, len(audio) / 16000)]
    total = max(1.0, sum(e - s for s, e in regions))
    model, out, done, last = get_model(tcfg), [], 0.0, 0
    for rs, re_ in regions:
        chunk = audio[int(rs * 16000):int(re_ * 16000)]
        segs, _ = model.transcribe(chunk, language=tcfg["language"], vad_filter=True, word_timestamps=True,
                                   beam_size=beam)
        for s in segs:
            text = s.text.strip()
            if text:
                words = [[round(w.start + rs, 2), round(w.end + rs, 2), w.word.strip()]
                         for w in (s.words or []) if w.word.strip()]
                out.append({"start": round(s.start + rs, 2), "end": round(s.end + rs, 2), "text": text, "words": words})
            pct = int(min(99, (done + s.end) / total * 100))
            if on_progress and pct >= last + 5:
                last = pct
                on_progress(pct)
        done += re_ - rs
    db.cache_set(key, out)
    return out
