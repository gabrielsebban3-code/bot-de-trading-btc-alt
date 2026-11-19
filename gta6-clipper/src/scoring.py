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
    if hi - lo < 1e-9 and robust:  # pics plus rares que 1 % du temps (un cri de 5 s) : ne pas les effacer
        lo, hi = x.min(), x.max()
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


CONNECTORS = re.compile(r"^(mais|et|donc|du coup|parce que|parce qu'|car|alors|puis|ensuite|sauf que|en fait|"
                        r"bref|enfin|ou|genre|sinon|d'ailleurs|du coup)\b", re.I)


END_PUNCT = (".", "!", "?", "…")
# Phrases qui annoncent quelque chose : finir dessus coupe avant la révélation (« what the hell is that »)
TEASERS = re.compile(r"(\?\s*$|what the|c'est quoi|qu'est-ce que|regarde|regardez|attends|attendez|vous allez voir|"
                     r"tu vas voir|on va voir|voilà ce|mais alors|et là\W*$|écoute)", re.I)


def teaser_end(text):
    return bool(TEASERS.search((text or "").strip().rstrip("»\"' ")[-60:]))


def sentences(segments, pause=0.6, seg_pause=0.3, max_len=20.0):
    """Découpe la transcription en vraies phrases. Les blocs Whisper coupent souvent au milieu d'une phrase :
    on coupe sur la ponctuation finale ou une vraie pause (mots), à défaut sur une fin de bloc après ~20 s."""
    out, cur = [], None

    def close():
        nonlocal cur
        if cur:
            prev_end = out[-1]["end"] if out else None
            out.append({"start": cur["start"], "end": cur["end"], "text": " ".join(cur["t"]).strip(),
                        "pause": (cur["start"] - prev_end) if prev_end is not None else 99.0})
        cur = None

    segs = sorted(segments or [], key=lambda x: x["start"])
    for k, seg in enumerate(segs):
        nxt = segs[k + 1]["start"] if k + 1 < len(segs) else None
        words = seg.get("words") or []
        units = [(w[0], w[1], w[2]) for w in words] if words else [(seg["start"], seg["end"], seg["text"].strip())]
        for j, (a, b, t) in enumerate(units):
            if cur is None:
                cur = {"start": a, "end": b, "t": []}
            cur["t"].append(t)
            cur["end"] = b
            last = j == len(units) - 1
            follow = (units[j + 1][0] if not last else nxt)
            gap = (follow - b) if follow is not None else 99.0
            if t.rstrip("»\"' )").endswith(END_PUNCT) or gap >= (seg_pause if last and not words else pause):
                close()
            elif last and cur["end"] - cur["start"] >= max_len:
                close()
    close()
    return out


def standalone_start(segs, s, e, hi, avoid=(), gap=0.0, margin=0.0):
    """Un clip doit tenir debout seul : s'il commence par un mot de liaison (« mais », « du coup »…),
    on reprend la phrase d'avant (au plus 2), sans dépasser la durée maximale ni l'écart avec les autres clips."""
    for _ in range(2):
        idx = next((i for i, seg in enumerate(segs) if abs(seg["start"] - s) < 1e-6), None)
        if not idx:
            break
        if not CONNECTORS.match(segs[idx]["text"].strip().lstrip("-–—\"'« ")):
            break
        prev = segs[idx - 1]
        if e - prev["start"] > hi or any(not _far_enough((prev["start"] - margin, e + margin), a, gap) for a in avoid):
            break
        s = prev["start"]
    return s


def tail_penalty(sig, s, e, keep=6.0):
    """Secondes d'ennui en fin de clip : temps passé après le dernier point fort, au-delà de `keep` s
    (laisser la chute et la réaction, mais ne pas traîner)."""
    if sig is None or len(sig) == 0:
        return 0.0
    a, b = max(0, int(s)), min(len(sig), int(np.ceil(e)))
    if b - a < 3:
        return 0.0
    part = np.asarray(sig[a:b], float)
    top = float(part.max())
    if top <= 0:
        return 0.0
    last = a + int(np.nonzero(part >= 0.7 * top)[0][-1])
    return max(0.0, e - last - keep)


def build_around_peak(peak, sents, lo, hi, avoid=(), gap=0.0, margin=0.0):
    """Clip construit autour de son moment fort :
    - fin = fin de la phrase qui suit le pic (la chute + la réaction), pas plus de ~8 s après ;
    - début = une phrase qui ouvre le sujet : après un vrai silence (changement de scène/sujet), jamais « mais/donc… » ;
    - plutôt court : chaque seconde en plus doit se justifier."""
    best = None
    ends = [sj for sj in sents if peak + 3.0 <= sj["end"] <= peak + 12.0]
    for sj in ends:
        end_cost = 0.6 * max(0.0, sj["end"] - (peak + 4.0)) + 1.5 * max(0.0, (peak + 2.0) - sj["end"])
        if teaser_end(sj["text"]):
            end_cost += 15.0                      # ne jamais couper juste avant la révélation
        elif sj["text"].rstrip("»\"' )").endswith("!"):
            end_cost -= 1.0
        for si in sents:
            if si["start"] > peak - 3.0:
                break
            length = sj["end"] - si["start"]
            if length > hi or length < lo:
                continue
            if any(not _far_enough((si["start"] - margin, sj["end"] + margin), a, gap) for a in avoid):
                continue
            start_cost = -2.0 * min(si.get("pause", 0.0), 3.0)            # silence avant = début naturel
            if CONNECTORS.match(si["text"].lstrip("-–—\"'« ")):
                start_cost += 8.0
            cost = end_cost + start_cost + 0.08 * (length - lo)
            if best is None or cost < best[0]:
                best = (cost, si["start"], sj["end"])
    return best


def snap_to_sentences(t0, t1, segments, min_len, max_len, margin, duration, avoid=(), gap=0.0, sig=None, peak=None):
    """Aligne [t0,t1] sur des débuts/fins de phrases, en respectant l'écart avec `avoid`.
    `sig` (intérêt par seconde, facultatif) évite de finir sur un temps mort après le point fort.
    Retourne (start, end, aligned)."""
    lo, hi = min_len - 2 * margin, max_len - 2 * margin
    best = None
    sents = sentences(segments)
    if peak is not None and sents:
        best = build_around_peak(float(peak), sents, lo, hi, avoid, gap, margin)
        if best:
            return max(0.0, best[1] - margin), min(float(duration), best[2] + margin), True
    for i, si in enumerate(sents):
        if abs(si["start"] - t0) > 20:
            continue
        start_cost = abs(si["start"] - t0) + (6.0 if CONNECTORS.match(si["text"].lstrip("-–—\"'« ")) else 0.0)
        for sj in sents[i:]:
            length = sj["end"] - si["start"]
            if length > hi:
                break
            if length >= lo:
                if any(not _far_enough((si["start"] - margin, sj["end"] + margin), a, gap) for a in avoid):
                    continue
                cost = start_cost + 0.5 * abs(sj["end"] - t1) + 1.5 * tail_penalty(sig, si["start"], sj["end"])
                cost += 15.0 if teaser_end(sj["text"]) else 0.0
                if best is None or cost < best[0]:
                    best = (cost, si["start"], sj["end"])
    if best:
        s, e, aligned = best[1], best[2], True
        s = standalone_start(sents, s, e, hi, avoid, gap, margin)
    elif sents:  # aucune combinaison dans les limites : on cale quand même sur des phrases (durée un peu hors cible)
        si = min(sents, key=lambda x: abs(x["start"] - t0))
        ok = [x for x in sents if x["end"] > si["start"] + 10 and not teaser_end(x["text"])] or sents
        sj = min(ok, key=lambda x: abs(x["end"] - si["start"] - min(max(t1 - t0, lo), hi)))
        s, e, aligned = si["start"], max(sj["end"], si["start"] + 1.0), True
    else:
        s, aligned = t0, False
        e = s + min(max(t1 - t0, lo), hi)
    return max(0.0, s - margin), min(float(duration), e + margin), aligned


def extend_reaction(e, rms, segments, duration, max_extra=2.5):
    """Après la dernière phrase, garde le rire / l'explosion qui suit (son encore fort, personne ne reparle)."""
    if rms is None or len(rms) == 0:
        return e
    nxt = min((s["start"] for s in segments or [] if s["start"] >= e - 0.05), default=float(duration))
    loud = float(np.median(rms)) + 3.0
    out, t = e, int(e)
    while t < len(rms) and t + 1 - e <= max_extra and t + 1 <= nxt - 0.2 and rms[t] >= loud:
        out = float(t + 1)
        t += 1
    return min(out, float(duration), e + max_extra)


def speech_signal(spans, duration):
    """Part de chaque seconde où quelqu'un parle (0-1)."""
    n = int(np.ceil(duration))
    sig = np.zeros(n)
    for s, e in spans or []:
        a, b = int(s), min(n, int(np.ceil(e)))
        sig[a:b] = 1.0
    return sig


def speech_adjust(ws, speech, length, min_ratio):
    """Un clip sans parole ennuie : note multipliée par la part de parole, quasi éliminé sous min_ratio."""
    if speech is None or not np.any(speech):
        return ws
    ratio = resize(window_scores(speech, length), len(ws))
    adj = ws * (0.3 + 0.7 * ratio)
    ok = ratio >= min_ratio
    return np.where(ok, adj, adj * 0.01) if ok.any() else adj


def rolling_median(x, w):
    x = np.asarray(x, dtype=float)
    if len(x) == 0:
        return x
    w = max(1, min(int(w), len(x)))
    w -= 1 - w % 2  # impair
    xp = np.pad(x, w // 2, mode="edge")
    return np.median(np.lib.stride_tricks.sliding_window_view(xp, w), axis=1)


def voice_excitement(rms, speech=None, window=121):
    """Moments où le son monte d'un coup par rapport aux 2 minutes autour (cri, fou rire), pas le niveau absolu :
    un jeu constamment bruyant ne compte plus. Limité aux secondes où quelqu'un parle si on le sait."""
    if rms is None or not len(rms):
        return None
    local = np.clip(np.asarray(rms, float) - rolling_median(rms, window), 0, None)
    if speech is not None and np.any(speech):
        local = local * resize(speech, len(local))
    return normalize(local)


def heatmap_contrast(sig):
    """Ne garde que ce qui dépasse le niveau habituel de la courbe « les plus revus » : les vrais pics."""
    if sig is None:
        return None
    med, top = float(np.median(sig)), float(sig.max())
    return np.clip((sig - med) / (top - med), 0, 1) if top - med > 1e-9 else np.zeros_like(sig)


def comments_signal(stamps, n, spread=8.0):
    """stamps = [(seconde, poids)] : instants cités dans les commentaires (« 23:45 mdr »)."""
    if not stamps or n <= 0:
        return None
    x, sig = np.arange(n), np.zeros(n)
    for t, w in stamps:
        if 0 <= t < n:
            sig += w * np.exp(-0.5 * ((x - t) / spread) ** 2)
    return normalize(sig, robust=False)


def peak_window_scores(sig, length):
    """Note de chaque fenêtre, pondérée pour placer le pic dans la 2e partie du clip :
    la mise en place au début, la chute dedans."""
    n = len(sig)
    if n <= length:
        return np.array([float(np.mean(sig)) if n else 0.0])
    w = 0.4 + 0.6 * np.minimum(1.0, np.linspace(0, 1, length) / 0.6)
    return np.correlate(sig, w / w.sum(), mode="valid")


def edge_mask(count, length, duration, mcfg):
    """Exclut l'intro (« salut à tous ») et l'outro (« abonnez-vous ») des vidéos de plus de 5 min."""
    t = np.arange(count)
    if duration <= 300:
        return np.ones(count, bool)
    a = min(float(mcfg.get("skip_intro_s", 60)), 0.05 * duration)
    b = min(float(mcfg.get("skip_outro_s", 45)), 0.05 * duration)
    return (t >= a) & (t + length <= duration - b)


def chat_signal(chat, n, lag=6):
    """Chat d'un live : vitesse par rapport à son rythme habituel (médiane sur 5 min) + réactions (« mdr », 😂).
    Avancé de `lag` secondes : les spectateurs réagissent après le moment."""
    if not chat or not any(chat.get("messages", [])) or n <= 0:
        return None
    k = np.ones(5) / 5
    speed = np.convolve(resize(chat["messages"], n), k, "same")
    fun = np.convolve(resize(chat.get("reactions", []), n), k, "same")
    base = rolling_median(speed, 301) + 0.5
    sig = np.clip(speed / base - 1, 0, None) + 2.0 * fun / base  # 0 = rythme normal ; 7 = chat 8x plus rapide
    sig = np.concatenate([sig[lag:], np.zeros(min(lag, n))])[:n]
    return normalize(sig)


def score_windows(duration, segments, heatmap, rms, mcfg, speech=None, comments=None, regions=None, chat=None):
    """Note de chaque fenêtre de clip possible (-1 = interdite). Partagée par le mode rapide et la sélection."""
    n = int(np.ceil(duration))
    sp = resize(speech, n) if speech is not None else None
    words = list(mcfg.get("keywords", [])) + list(mcfg.get("reaction_words", []))
    signals = {
        "heatmap": heatmap_contrast(heatmap_signal(heatmap, n)),
        "audio": voice_excitement(rms, sp),
        "keywords": keyword_signal(segments, n, words),
        "comments": comments_signal(comments, n),
        "chat": chat_signal(chat, n),
    }
    sig = combine(signals, mcfg["weights"], n)
    length = int(mcfg["target_clip_s"])
    ws = speech_adjust(peak_window_scores(sig, length), sp, length, mcfg.get("min_speech_ratio", 0.5))
    mask = edge_mask(len(ws), length, duration, mcfg)
    if regions:  # mode rapide : seulement là où on a la transcription
        t, inside = np.arange(len(ws)), np.zeros(len(ws), bool)
        for rs, re_ in regions:
            inside |= (t >= rs) & (t + length <= re_)
        mask &= inside
    if mask.any():
        ws = np.where(mask, ws, -1.0)
    return ws, signals, length


def _peak(sig, a, b):
    """Seconde la plus forte de [a, b] (le pic d'une suite de secondes fortes : on prend sa fin)."""
    a, b = max(0, int(a)), min(len(sig), int(b))
    if b - a < 1:
        return None
    part = np.asarray(sig[a:b], float)
    top = float(part.max())
    strong = np.nonzero(part >= 0.9 * top)[0]
    return float(a + strong[-1]) if top > 0 else None


def select_moments(duration, segments, heatmap, rms, mcfg, speech=None, comments=None, regions=None, chat=None):
    n = int(np.ceil(duration))
    ws, signals, length = score_windows(duration, segments, heatmap, rms, mcfg, speech, comments, regions, chat)
    combined = combine(signals, mcfg["weights"], n)
    k, gap = int(mcfg["clips_per_video"]), float(mcfg["min_gap_s"])
    out = []
    for t0, t1 in pick_windows(ws, k * 3, length, gap):
        if ws[min(t0, len(ws) - 1)] < 0:
            continue
        s, e, aligned = snap_to_sentences(t0, min(t1, duration), segments, mcfg["min_clip_s"], mcfg["max_clip_s"],
                                          mcfg["margin_s"], duration, [(m["start"], m["end"]) for m in out], gap,
                                          sig=combined, peak=_peak(combined, t0, min(t1, duration)))
        if aligned:
            e = min(extend_reaction(e, rms, segments, duration), s + mcfg["max_clip_s"])
        if e - s < mcfg["min_clip_s"] - 1e-6 and duration >= mcfg["min_clip_s"]:
            continue
        if any(not _far_enough((s, e), (m["start"], m["end"]), gap) for m in out):
            continue
        detail = {name: round(float(np.mean(resize(v, n)[int(s):int(e) + 1])), 3)
                  for name, v in {**signals, "parole": speech}.items() if v is not None and len(v)}
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
def candidate_windows(duration, heatmap, rms, mcfg, n, speech=None, comments=None, chat=None):
    """Candidats avant transcription (mode rapide) : mêmes notes que select_moments, sans les mots-clés."""
    ws, _, length = score_windows(duration, [], heatmap, rms, mcfg, speech, comments, chat=chat)
    return [w for w in pick_windows(ws, n, length, float(mcfg["min_gap_s"])) if ws[min(w[0], len(ws) - 1)] >= 0]


def merge_regions(windows, duration, pad=20.0):
    """Zones à transcrire autour des fenêtres (marge pour l'alignement sur les phrases), fusionnées."""
    out = []
    for s, e in sorted((max(0.0, s - pad), min(float(duration), e + pad)) for s, e in windows):
        if out and s <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], e))
        else:
            out.append((s, e))
    return [(round(s, 2), round(e, 2)) for s, e in out]


def manual_window(at, duration, mcfg):
    """Fenêtre d'un clip demandé à un minutage : l'instant choisi tombe vers 60 % du clip."""
    length = float(mcfg["target_clip_s"])
    t0 = min(max(0.0, at - 0.6 * length), max(0.0, duration - length))
    return t0, min(float(duration), t0 + length)


# ---------- apprentissage à partir des notes Bon / Nul ----------
LEARNABLE = ("heatmap", "audio", "keywords", "comments", "chat")


def learn_weights(rated, base, min_each=3):
    """rated = [(note, signaux)] avec note +1 (bon) ou -1 (nul). Augmente le poids d'un signal plus fort dans les
    bons clips que dans les nuls, et inversement (facteur entre 0,3 et 2). Renvoie (poids, appris ?)."""
    good = [s for r, s in rated if r > 0]
    bad = [s for r, s in rated if r < 0]
    if len(good) < min_each or len(bad) < min_each:
        return dict(base), False
    out = dict(base)
    for k in LEARNABLE:
        g, b = [s[k] for s in good if k in s], [s[k] for s in bad if k in s]
        if len(g) >= 2 and len(b) >= 2 and float(base.get(k, 0)) > 0:
            diff = float(np.mean(g)) - float(np.mean(b))
            out[k] = round(float(base[k]) * min(2.0, max(0.3, 1 + 1.5 * diff)), 3)
    return out, True
