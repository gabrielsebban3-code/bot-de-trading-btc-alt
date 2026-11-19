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


def subtitle_events(segments, start, end, max_words=6):
    """Découpe les segments en blocs courts, timings proportionnels au nombre de caractères, relatifs au clip."""
    events = []
    for seg in segments:
        if seg["end"] <= start or seg["start"] >= end:
            continue
        words = seg["text"].split()
        if not words:
            continue
        chunks = [" ".join(words[i:i + max_words]) for i in range(0, len(words), max_words)]
        total = sum(len(c) for c in chunks)
        t = seg["start"]
        for c in chunks:
            d = (seg["end"] - seg["start"]) * len(c) / total
            s, e = max(t, start), min(t + d, end)
            if e - s > 0.15:
                events.append((round(s - start, 2), round(e - start, 2), c))
            t += d
    return events


def build_ass(events, credit: str, duration: float, font="DejaVu Sans") -> str:
    head = (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Sub,{font},74,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,2,70,70,430,1\n"
        f"Style: Credit,{font},36,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,210,1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    lines = [f"Dialogue: 1,{ass_time(0)},{ass_time(duration + 1)},Credit,,0,0,0,,{ass_escape(credit)}"]
    lines += [f"Dialogue: 0,{ass_time(s)},{ass_time(e)},Sub,,0,0,0,,{ass_escape(t)}" for s, e, t in events]
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
