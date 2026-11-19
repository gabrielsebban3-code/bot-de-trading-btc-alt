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


# Mises en page. *_v = marge verticale ASS (depuis le bas) des sous-titres, du crédit et du bas du titre.
LAYOUTS = {
    # cadrage zoomé carré sur fond noir, titre au-dessus (style des pages de clips TikTok)
    "zoom": {"filter": "[0:v]fps=30,crop='min(iw,ih)':'min(iw,ih)',scale=1080:1080,setsar=1,"
                       "pad=1080:1920:0:400:black,subtitles={ass}[v]",
             # vidéo de 21 % à 77 % de la hauteur ; sous-titres juste dessous, sur le noir (lisibles sur tout fond)
             "sub_v": 320, "credit_v": 150, "title_v": 1525},
    # vidéo 16:9 pleine largeur sur fond noir, titre au-dessus
    "noir": {"filter": "[0:v]fps=30,scale=1080:-2,setsar=1,pad=1080:1920:0:(oh-ih)/2:black,subtitles={ass}[v]",
             "sub_v": 430, "credit_v": 210, "title_v": 1300},
    # vidéo 16:9 pleine largeur sur fond flou
    "flou": {"filter": "[0:v]fps=30,split=2[a][b];[a]scale=270:480:force_original_aspect_ratio=increase,"
                       "crop=270:480,boxblur=10:2,scale=1080:1920,setsar=1[bg];[b]scale=1080:-2,setsar=1[fg];"
                       "[bg][fg]overlay=(W-w)/2:(H-h)/2,subtitles={ass}[v]",
             "sub_v": 430, "credit_v": 210, "title_v": 1300},
}


TITLE_STYLES = {
    # encadré blanc, texte noir (BorderStyle 3 : boîte opaque de la couleur du contour, une par ligne)
    "encadre": "&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,14,0",
    # texte blanc, contour noir et ombre, sans boîte
    "texte": "&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,5,3",
}


def build_ass(events, credit: str, duration: float, font="DejaVu Sans", title: str = "", layout: str = "zoom",
              title_style: str = "encadre") -> str:
    L = LAYOUTS.get(layout, LAYOUTS["zoom"])
    ts = TITLE_STYLES.get(title_style, TITLE_STYLES["encadre"])
    head = (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Sub,{font},80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,2,70,70,{L['sub_v']},1\n"
        f"Style: Credit,{font},36,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,{L['credit_v']},1\n"
        f"Style: Title,{font},52,{ts},2,90,90,{L['title_v']},1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    lines = [f"Dialogue: 1,{ass_time(0)},{ass_time(duration + 1)},Credit,,0,0,0,,{ass_escape(credit)}"]
    if title:
        lines.append(f"Dialogue: 2,{ass_time(0)},{ass_time(duration + 1)},Title,,0,0,0,,{ass_escape(title)}")
    lines += [f"Dialogue: 0,{ass_time(s)},{ass_time(e)},Sub,,0,0,0,,{t}" for s, e, t in events]  # déjà échappé
    return head + "\n".join(lines) + "\n"


def has_audio(path) -> bool:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
                        "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    return bool(r.stdout.strip())


def render_vertical(src, out, ass_name, workdir, rcfg, keep=None, music=None, duration=None):
    """ass_name : nom de fichier relatif à workdir (évite l'échappement des chemins dans le filtre).
    keep : [(début, fin)] en secondes du fichier source à garder (coupes des blancs) ; None = tout.
    music : {"path", "offset", "volume"} musique d'ambiance baissée automatiquement sous la voix.
    duration : durée finale (fondus de fin)."""
    graph = LAYOUTS.get(rcfg.get("layout", "zoom"), LAYOUTS["zoom"])["filter"].format(ass=ass_name)
    pre_a, loud = "", "loudnorm=I=-14:TP=-1.5:LRA=11"
    if keep:
        expr = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in keep)
        graph = graph.replace("[0:v]", f"[0:v]select='{expr}',setpts=N/FRAME_RATE/TB,", 1)
        pre_a = f"aselect='{expr}',asetpts=N/SR/TB,"
    fades = "fade=t=in:st=0:d=0.3"
    if duration and duration > 2:
        fades += f",fade=t=out:st={duration - 0.4:.2f}:d=0.4"
    graph = graph.replace("[v]", f",{fades}[v]")
    inputs = ["-i", src]
    if music:
        inputs += ["-stream_loop", "-1", "-ss", f"{music['offset']:.2f}", "-i", music["path"]]
        end = max(0.0, (duration or 60) - 1.5)
        mus = f"[1:a]volume={music['volume']:.3f},afade=t=in:d=1.5,afade=t=out:st={end:.2f}:d=1.5"
        if has_audio(src):
            # la musique baisse dès que la voix (ou le jeu) monte : sidechaincompress
            graph += (f";[0:a]{pre_a}asplit=2[va][vb];{mus}[mus];"
                      f"[mus][vb]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[duck];"
                      f"[va][duck]amix=inputs=2:duration=first:normalize=0,{loud}[a]")
        else:
            graph += f";{mus},atrim=0:{duration or 60:.2f}[a]"
        maps = ["-map", "[v]", "-map", "[a]"]
    else:
        maps = ["-map", "[v]", "-map", "0:a?", "-af", pre_a + loud]
    ffmpeg(*inputs, "-filter_complex", graph, *maps, "-ar", 48000,
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
