"""Détection des meilleurs moments : signaux par seconde normalisés 0-1, combinés, puis sélection des pics."""
import hashlib
import json
import logging
import os
import re
import urllib.request
import wave

import numpy as np

log = logging.getLogger(__name__)


def normalize(x, robust=True):
    x = np.asarray(x, dtype=float)
    if x.size == 0:
        return x
    lo, hi = (np.percentile(x, 5), np.percentile(x, 99)) if robust else (x.min(), x.max())
    if hi - lo < 1e-9:
        return np.zeros_like(x)
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


def resize(sig, n):
    sig = np.asarray(sig, dtype=float)
    if len(sig) == n:
        return sig
    if len(sig) > n:
        return sig[:n]
    return np.concatenate([sig, np.zeros(n - len(sig))])


# --- signaux ---
def heatmap_signal(heatmap, n):
    """heatmap yt-dlp : [{start_time, end_time, value}]. None si absente."""
    if not heatmap or n <= 0:
        return None
    sig = np.zeros(n)
    for h in heatmap:
        s = max(0, int(h["start_time"]))
        e = min(n, max(s + 1, int(np.ceil(h["end_time"]))))
        sig[s:e] = np.maximum(sig[s:e], float(h["value"]))
    return normalize(sig, robust=False)


def audio_rms(wav_path):
    """RMS par seconde (en dB) d'un WAV mono 16 bits."""
    with wave.open(str(wav_path), "rb") as w:
        sr, ch = w.getframerate(), w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    n = len(data) // sr
    if n == 0:
        return np.zeros(0)
    frames = data[: n * sr].reshape(n, sr) / 32768.0
    rms = np.sqrt((frames ** 2).mean(axis=1))
    return 20 * np.log10(rms + 1e-6)


def keyword_signal(segments, n, keywords):
    """Densité de mots-clés (75 %) + changements de sujet par nouveauté lexicale (25 %)."""
    if not segments or n <= 0:
        return None
    pats = [re.compile(r"(?<!\w)" + re.escape(k.lower()) + r"(?!\w)") for k in keywords]
    kw = np.zeros(n)
    for seg in segments:
        text = seg["text"].lower()
        hits = sum(len(p.findall(text)) for p in pats) + 0.5 * text.count("!")
        if hits:
            s, e = int(seg["start"]), min(n, max(int(seg["start"]) + 1, int(np.ceil(seg["end"]))))
            kw[s:e] += hits / max(1.0, seg["end"] - seg["start"])
    block = 20
    words = [set() for _ in range(n // block + 1)]
    for seg in segments:
        b = min(len(words) - 1, int(seg["start"]) // block)
        words[b].update(w for w in re.findall(r"\w+", seg["text"].lower()) if len(w) > 3)
    nov = np.zeros(n)
    for b in range(1, len(words)):
        a, c = words[b - 1], words[b]
        if a and c:
            nov[b * block:(b + 1) * block] = 1 - len(a & c) / len(a | c)
    return 0.75 * normalize(kw) + 0.25 * normalize(nov)


def combine(signals: dict, weights: dict, n: int):
    total, wsum = np.zeros(n), 0.0
    for name, sig in signals.items():
        w = float(weights.get(name, 0))
        if sig is None or w <= 0 or len(sig) == 0:
            continue
        total += w * resize(sig, n)
        wsum += w
    return total / wsum if wsum else total


# --- sélection ---
def window_scores(sig, length):
    n = len(sig)
    if n <= length:
        return np.array([float(np.mean(sig)) if n else 0.0])
    cs = np.concatenate([[0.0], np.cumsum(sig)])
    return (cs[length:] - cs[:-length]) / length


def _far_enough(a, b, gap):
    return a[0] >= b[1] + gap or a[1] + gap <= b[0]


def pick_windows(ws, k, length, gap):
    chosen = []
    for t in np.argsort(-ws, kind="stable"):
        cand = (int(t), int(t) + length)
        if all(_far_enough(cand, c, gap) for c in chosen):
            chosen.append(cand)
            if len(chosen) >= k:
                break
    return chosen


def snap_to_sentences(t0, t1, segments, min_len, max_len, margin, duration, avoid=(), gap=0.0):
    """Aligne [t0,t1] sur des débuts/fins de segments Whisper, en respectant l'écart avec `avoid`.
    Retourne (start, end, aligned)."""
    lo, hi = min_len - 2 * margin, max_len - 2 * margin
    best = None
    if segments:
        segs = sorted(segments, key=lambda s: s["start"])
        for i, si in enumerate(segs):
            if abs(si["start"] - t0) > 20:
                continue
            for sj in segs[i:]:
                length = sj["end"] - si["start"]
                if length > hi:
                    break
                if length >= lo:
                    if any(not _far_enough((si["start"] - margin, sj["end"] + margin), a, gap) for a in avoid):
                        continue
                    cost = abs(si["start"] - t0) + 0.5 * abs(sj["end"] - t1)
                    if best is None or cost < best[0]:
                        best = (cost, si["start"], sj["end"])
    if best:
        s, e, aligned = best[1], best[2], True
    else:
        s, aligned = t0, False
        e = s + min(max(t1 - t0, lo), hi)
    return max(0.0, s - margin), min(float(duration), e + margin), aligned


def select_moments(duration, segments, heatmap, rms, mcfg):
    n = int(np.ceil(duration))
    signals = {
        "heatmap": heatmap_signal(heatmap, n),
        "audio": normalize(rms) if rms is not None and len(rms) else None,
        "keywords": keyword_signal(segments, n, mcfg.get("keywords", [])),
    }
    sig = combine(signals, mcfg["weights"], n)
    length = int(mcfg["target_clip_s"])
    ws = window_scores(sig, length)
    k, gap = int(mcfg["clips_per_video"]), float(mcfg["min_gap_s"])
    out = []
    for t0, t1 in pick_windows(ws, k * 3, length, gap):
        s, e, aligned = snap_to_sentences(t0, min(t1, duration), segments, mcfg["min_clip_s"], mcfg["max_clip_s"],
                                          mcfg["margin_s"], duration, [(m["start"], m["end"]) for m in out], gap)
        if e - s < mcfg["min_clip_s"] - 1e-6 and duration >= mcfg["min_clip_s"]:
            continue
        if any(not _far_enough((s, e), (m["start"], m["end"]), gap) for m in out):
            continue
        detail = {name: round(float(np.mean(resize(v, n)[int(s):int(e) + 1])), 3)
                  for name, v in signals.items() if v is not None and len(v)}
        out.append({"start": round(s, 2), "end": round(e, 2), "score": round(float(ws[min(t0, len(ws) - 1)]), 4),
                    "aligned": aligned, "signals": detail})
        if len(out) >= k:
            break
    return out


# --- LLM optionnel (désactivé par défaut) ---
def passage_text(segments, start, end, limit=600):
    return " ".join(s["text"].strip() for s in segments if s["end"] > start and s["start"] < end)[:limit]


def llm_rescore(moments, segments, mcfg, db):
    """N'envoie que les passages présélectionnés, réponse = un chiffre, cache SQLite."""
    lcfg = mcfg.get("llm", {})
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not lcfg.get("enabled") or not key or not moments:
        return moments
    w = float(lcfg.get("weight", 0.3))
    for m in moments:
        text = passage_text(segments, m["start"], m["end"])
        if not text:
            continue
        ck = "llm:" + hashlib.sha256((lcfg["model"] + text).encode()).hexdigest()
        note = db.cache_get(ck)
        if note is None:
            body = {"model": lcfg["model"], "max_tokens": 4, "messages": [{"role": "user", "content":
                    "Note de 0 à 9 l'intérêt de ce passage d'une vidéo GTA 6 pour un clip court. "
                    "Réponds uniquement par le chiffre.\n\n" + text}]}
            req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
                                         headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                                  "content-type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    reply = json.load(r)["content"][0]["text"]
                note = int(re.search(r"\d", reply).group()) / 9
                db.cache_set(ck, note)
            except Exception as e:  # le LLM ne doit jamais bloquer le pipeline
                log.warning("LLM indisponible (%s), score inchangé", e)
                continue
        m["score"] = round((1 - w) * m["score"] + w * note, 4)
        m["signals"]["llm"] = round(note, 3)
    return sorted(moments, key=lambda m: -m["score"])


# --- mode rapide : repérer les candidats avant toute transcription ---
def candidate_windows(duration, heatmap, rms, mcfg, n):
    """Mêmes fenêtres que select_moments quand le poids des mots-clés est nul."""
    size = int(np.ceil(duration))
    sig = combine({"heatmap": heatmap_signal(heatmap, size),
                   "audio": normalize(rms) if rms is not None and len(rms) else None}, mcfg["weights"], size)
    length = int(mcfg["target_clip_s"])
    return pick_windows(window_scores(sig, length), n, length, float(mcfg["min_gap_s"]))


def merge_regions(windows, duration, pad=20.0):
    """Zones à transcrire autour des fenêtres (marge pour l'alignement sur les phrases), fusionnées."""
    out = []
    for s, e in sorted((max(0.0, s - pad), min(float(duration), e + pad)) for s, e in windows):
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return [(round(s, 2), round(e, 2)) for s, e in out]
