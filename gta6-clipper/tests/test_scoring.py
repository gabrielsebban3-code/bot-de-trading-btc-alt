from datetime import datetime, timedelta, timezone

import numpy as np

from src import scoring, search, vertical
from src.config import DEFAULTS

M = DEFAULTS["moments"]


def fake_segments(duration, every=6.0):
    t, segs, i = 0.0, [], 0
    while t + every <= duration:
        segs.append({"start": t, "end": t + every - 0.4, "text": f"phrase numéro {i} sur le jeu"})
        t += every
        i += 1
    return segs


def test_heatmap_signal_normalized_and_absent():
    hm = [{"start_time": 0, "end_time": 10, "value": 0.2}, {"start_time": 10, "end_time": 20, "value": 1.0}]
    sig = scoring.heatmap_signal(hm, 20)
    assert sig[5] == 0 and sig[15] == 1
    assert scoring.heatmap_signal(None, 20) is None


def test_combine_ignores_missing_signals():
    a = np.ones(10)
    out = scoring.combine({"heatmap": None, "audio": a}, {"heatmap": 0.5, "audio": 0.25}, 10)
    assert np.allclose(out, 1.0)


def test_pick_windows_respects_gap():
    ws = np.zeros(400)
    ws[100], ws[110], ws[300] = 1.0, 0.9, 0.8
    picks = scoring.pick_windows(ws, 3, 30, 60)
    starts = [p[0] for p in picks]
    assert starts[0] == 100 and 110 not in starts and 300 in starts
    for i, a in enumerate(picks):
        for b in picks[i + 1:]:
            assert a[0] >= b[1] + 60 or b[0] >= a[1] + 60


def test_snap_to_sentence_boundaries_and_length():
    segs = fake_segments(300)
    s, e, aligned = scoring.snap_to_sentences(101, 133, segs, 20, 45, 0.5, 300)
    assert aligned
    assert any(abs(seg["start"] - (s + 0.5)) < 1e-6 for seg in segs)
    assert any(abs(seg["end"] - (e - 0.5)) < 1e-6 for seg in segs)
    assert 20 <= e - s <= 45


def test_snap_fallback_without_segments():
    s, e, aligned = scoring.snap_to_sentences(50, 82, [], 20, 45, 0.5, 300)
    assert not aligned and 20 <= e - s <= 45


def test_select_moments_finds_heatmap_peak():
    dur = 600
    segs = fake_segments(dur)
    hm = [{"start_time": t, "end_time": t + 10, "value": 1.0 if 400 <= t < 440 else 0.1} for t in range(0, dur, 10)]
    rms = np.full(dur, -30.0)
    moments = scoring.select_moments(dur, segs, hm, rms, M)
    assert 1 <= len(moments) <= M["clips_per_video"]
    best = moments[0]
    assert best["start"] < 440 and best["end"] > 400
    for m in moments:
        assert M["min_clip_s"] <= m["end"] - m["start"] <= M["max_clip_s"]
    ordered = sorted(moments, key=lambda m: m["start"])
    for a, b in zip(ordered, ordered[1:]):
        assert b["start"] - a["end"] >= M["min_gap_s"]


def test_select_moments_audio_only_when_no_heatmap_no_transcript():
    dur = 300
    rms = np.full(dur, -40.0)
    rms[200:230] = -5.0
    moments = scoring.select_moments(dur, [], None, rms, M)
    assert moments and moments[0]["start"] <= 205 and moments[0]["end"] >= 220


def test_keyword_signal_peaks_on_keywords():
    segs = [{"start": 0, "end": 5, "text": "bonjour à tous"}, {"start": 50, "end": 55, "text": "c'est incroyable, regardez la map !"}]
    sig = scoring.keyword_signal(segs, 100, M["keywords"])
    assert sig[52] > sig[2]


def test_filter_and_rank():
    now = datetime(2026, 11, 19, tzinfo=timezone.utc)
    base = {"duration": 600, "likes": 100, "live": False, "language": "fr"}
    def c(i, **kw):
        return {**base, "id": i, "channel": f"ch{i}", "views": 10000,
                "published_at": (now - timedelta(hours=10)).isoformat(), **kw}
    cands = [c("a", views=50000), c("b"), c("old", published_at=(now - timedelta(days=9)).isoformat()),
             c("short", duration=50), c("live", live=True), c("en", language="en"), c("few", views=100),
             c("bl", channel="Spam"), c("known")]
    scfg = {**DEFAULTS["search"], "channel_blacklist": ["spam"], "top_n": 5}
    out = search.filter_and_rank(cands, scfg, now=now, known={"known"})
    assert [x["id"] for x in out] == ["a", "b"]


def test_iso_duration():
    assert search.iso_duration("PT1H2M3S") == 3723 and search.iso_duration("PT45S") == 45


def test_subtitle_events_relative_and_bounded():
    segs = [{"start": 10, "end": 16, "text": "un deux trois quatre cinq six sept huit neuf dix"}]
    ev = vertical.subtitle_events(segs, 12, 40)
    assert ev and all(0 <= s < e <= 28 for s, e, _ in ev)
    ass = vertical.build_ass(ev, "Source : {Chaîne}", 28)
    assert "Source : (Chaîne)" in ass and "PlayResY: 1920" in ass


def test_snap_respects_gap_with_existing_clip():
    segs = fake_segments(300)
    s, e, aligned = scoring.snap_to_sentences(152, 184, segs, 20, 45, 0.5, 300, avoid=[(59.5, 90.1)], gap=60)
    assert aligned and s >= 90.1 + 60


def test_transcribe_passes_array_not_path(tmp_path, monkeypatch):
    import wave
    from types import SimpleNamespace
    from src import transcribe
    from src.db import DB
    wav = tmp_path / "a.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\x00\x10" * 16000)
    seen = {}
    class FakeModel:
        def transcribe(self, audio, **kw):
            seen["type"] = type(audio)
            return iter([SimpleNamespace(start=0.0, end=1.0, text=" salut ")]), None
        def detect_language(self, audio=None, **kw):
            seen["lang_type"] = type(audio)
            return "fr", 0.99, []
    monkeypatch.setattr(transcribe, "get_model", lambda tcfg: FakeModel())
    tcfg = DEFAULTS["transcription"]
    assert transcribe.detect_language(wav, tcfg, 1.0)[0] == "fr"
    segs = transcribe.transcribe(wav, "vid", tcfg, DB(tmp_path / "db.sqlite"))
    assert segs == [{"start": 0.0, "end": 1.0, "text": "salut"}]
    assert seen["type"] is np.ndarray and seen["lang_type"] is np.ndarray


def test_search_url_uses_upload_filter():
    from yt_dlp.extractor import gen_extractor_classes
    url = search.search_url("GTA 6 map", 7)
    assert "search_query=GTA+6+map" in url and "sp=EgIIAw%3D%3D" in url
    assert any(ie.suitable(url) for ie in gen_extractor_classes() if ie.ie_key() == "YoutubeSearchURL")
