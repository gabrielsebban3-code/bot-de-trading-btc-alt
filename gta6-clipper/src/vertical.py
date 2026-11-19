"""Rendu vertical 1080x1920 : fond flou + vidéo centrée + sous-titres ASS + crédit de la chaîne."""
import subprocess

from .download import ffmpeg

W, H = 1080, 1920


def ass_time(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def ass_escape(text: str) -> str:
    return text.replace("\\", "/").replace("{", "(").replace("}", ")").replace("\n", " ").strip()


HIGHLIGHT = r"{\c&H0000D7FF&}"  # jaune (ASS = BGR)
NORMAL = r"{\c&H00FFFFFF&}"
PUNCT = ",.!?;:…"


def _chunks(words, max_words, max_chars):
    """Blocs courts sur une ligne : coupe sur la ponctuation, les pauses (> 0,6 s) et la longueur."""
    out, cur = [], []
    for w in words:
        if cur and (len(cur) >= max_words or w[0] - cur[-1][1] > 0.6
                    or len(" ".join(x[2] for x in cur + [w])) > max_chars):
            out.append(cur)
            cur = []
        cur.append(w)
        if w[2][-1] in PUNCT:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def subtitle_events(segments, start, end, max_words=3, highlight=True, upper=False, max_chars=20):
    """Événements (début, fin, texte ASS) relatifs au clip. Avec horaires par mot : blocs courts et
    mot prononcé surligné ; sinon timings proportionnels au nombre de caractères."""
    tx = lambda t: ass_escape(t.upper() if upper else t)  # noqa: E731
    events = []
    for seg in segments:
        if seg["end"] <= start or seg["start"] >= end:
            continue
        timed = [w for w in seg.get("words") or [] if w[1] > start and w[0] < end]
        if timed:
            for chunk in _chunks(timed, max_words, max_chars):
                cs, ce = max(chunk[0][0], start), min(chunk[-1][1], end)
                if ce - cs <= 0.15:
                    continue
                texts = [tx(w[2]) for w in chunk]
                if not highlight:
                    events.append((round(cs - start, 2), round(ce - start, 2), " ".join(texts)))
                    continue
                for i, w in enumerate(chunk):  # un événement par mot, contigus : pas de chevauchement
                    ws = cs if i == 0 else max(w[0], start)
                    we = ce if i == len(chunk) - 1 else min(chunk[i + 1][0], end)
                    if we - ws > 0.02:
                        line = " ".join(HIGHLIGHT + t + NORMAL if j == i else t for j, t in enumerate(texts))
                        events.append((round(ws - start, 2), round(we - start, 2), line))
            continue
        if seg.get("words"):
            continue
        words = seg["text"].split()
        if not words:
            continue
        chunks = [" ".join(words[i:i + max_words]) for i in range(0, len(words), max_words)]
        total = sum(len(c) for c in chunks)
        t = seg["start"]
        for c in chunks:
            d = (seg["end"] - seg["start"]) * len(c) / total
            s0, e0 = max(t, start), min(t + d, end)
            if e0 - s0 > 0.15:
                events.append((round(s0 - start, 2), round(e0 - start, 2), tx(c)))
            t += d
    return events


def build_ass(events, credit: str, duration: float, font="DejaVu Sans") -> str:
    head = (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Sub,{font},80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,2,70,70,430,1\n"
        f"Style: Credit,{font},36,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,210,1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    lines = [f"Dialogue: 1,{ass_time(0)},{ass_time(duration + 1)},Credit,,0,0,0,,{ass_escape(credit)}"]
    lines += [f"Dialogue: 0,{ass_time(s)},{ass_time(e)},Sub,,0,0,0,,{t}" for s, e, t in events]  # déjà échappé
    return head + "\n".join(lines) + "\n"


FILTER = (
    "[0:v]fps=30,split=2[a][b];"
    "[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,scale=1080:1920,setsar=1[bg];"
    "[b]scale=1080:-2,setsar=1[fg];"
    "[bg][fg]overlay=(W-w)/2:(H-h)/2,subtitles={ass}[v]"
)


def render_vertical(src, out, ass_name, workdir, rcfg):
    """ass_name : nom de fichier relatif à workdir (évite l'échappement des chemins dans le filtre)."""
    ffmpeg("-i", src, "-filter_complex", FILTER.format(ass=ass_name), "-map", "[v]", "-map", "0:a?",
           "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", 48000,
           "-c:v", "libx264", "-preset", rcfg["preset"], "-crf", rcfg["crf"], "-pix_fmt", "yuv420p", "-r", 30,
           "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out, cwd=workdir)


def thumbnail(video, thumb, at: float):
    ffmpeg("-ss", f"{at:.2f}", "-i", video, "-frames:v", 1, "-q:v", 3, thumb)


def probe_duration(path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0
