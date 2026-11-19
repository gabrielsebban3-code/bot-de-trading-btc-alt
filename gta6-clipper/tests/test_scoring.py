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
            return iter([SimpleNamespace(start=0.0, end=1.0, text=" salut ", words=[SimpleNamespace(start=0.1, end=0.6, word=" salut")])]), None
        def detect_language(self, audio=None, **kw):
            seen["lang_type"] = type(audio)
            return "fr", 0.99, []
    monkeypatch.setattr(transcribe, "get_model", lambda tcfg: FakeModel())
    tcfg = DEFAULTS["transcription"]
    assert transcribe.detect_language(wav, tcfg, 1.0)[0] == "fr"
    pcts = []
    segs = transcribe.transcribe(wav, "vid", tcfg, DB(tmp_path / "db.sqlite"), on_progress=pcts.append)
    assert segs == [{"start": 0.0, "end": 1.0, "text": "salut", "words": [[0.1, 0.6, "salut"]]}]
    assert pcts and pcts[-1] <= 99
    assert seen["type"] is np.ndarray and seen["lang_type"] is np.ndarray


def test_search_url_uses_upload_filter():
    from yt_dlp.extractor import gen_extractor_classes
    url = search.search_url("GTA 6 map", 7)
    assert "search_query=GTA+6+map" in url and "sp=EgIIAw%3D%3D" in url
    assert any(ie.suitable(url) for ie in gen_extractor_classes() if ie.ie_key() == "YoutubeSearchURL")


def test_subtitles_use_word_timings():
    segs = [{"start": 10, "end": 20, "text": "a b c d e f g h",
             "words": [[10 + i, 10.8 + i, w] for i, w in enumerate("abcdefgh")]}]
    ev = vertical.subtitle_events(segs, 12, 40, max_words=3, highlight=False)
    assert ev[0] == (0.0, 2.8, "c d e") and ev[1] == (3.0, 5.8, "f g h")


def test_failed_videos_are_retried_then_dropped(tmp_path):
    from src.db import DB
    db = DB(tmp_path / "db.sqlite")
    v = {"id": "vid00000001"}
    db.upsert_video({"id": "okvideo0001"}, "ok")
    db.upsert_video(v, "error", "boom")
    assert db.known_ids(3) == {"okvideo0001"}
    db.upsert_video(v, "error", "boom")
    db.upsert_video(v, "error", "boom")
    assert "vid00000001" in db.known_ids(3)


def test_legacy_db_gets_attempts_column(tmp_path):
    import sqlite3
    from src.db import DB
    path = tmp_path / "old.sqlite"
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT, channel TEXT, url TEXT, published_at TEXT, "
              "duration REAL, views INTEGER, likes INTEGER, score REAL, status TEXT, error TEXT, processed_at REAL)")
    c.execute("INSERT INTO videos (id, status) VALUES ('legacy00001', 'error')")
    c.commit(); c.close()
    db = DB(path)
    assert "legacy00001" not in db.known_ids()
    db.upsert_video({"id": "legacy00001"}, "ok")
    assert "legacy00001" in db.known_ids()


def test_cli_run_refuses_when_job_running(tmp_path, monkeypatch):
    import json, time
    from src import jobs
    monkeypatch.setattr(jobs, "data_dir", lambda: tmp_path)
    (tmp_path / "job.json").write_text(json.dumps({"running": True, "updated_at": time.time()}))
    res = jobs.run_pipeline(DEFAULTS, db=object())
    assert "tourne déjà" in res["fatal"]


def test_subtitles_break_on_punctuation_and_highlight_contiguous():
    ws = [[0.0, 0.4, "Regardez"], [0.5, 0.8, "ça,"], [0.9, 1.2, "c'est"], [1.3, 1.8, "énorme"], [1.9, 2.0, "!"]]
    segs = [{"start": 0, "end": 2.0, "text": " ".join(w[2] for w in ws), "words": ws}]
    plain = vertical.subtitle_events(segs, 0, 10, highlight=False)
    assert [e[2] for e in plain] == ["Regardez ça,", "c'est énorme !"]
    hl = vertical.subtitle_events(segs, 0, 10, highlight=True, upper=True)
    assert len(hl) == 5 and vertical.HIGHLIGHT + "REGARDEZ" in hl[0][2]
    assert hl[0][1] == hl[1][0]  # contigus dans un même bloc : jamais deux lignes à l'écran
    assert "{" not in vertical.subtitle_events([{"start": 0, "end": 1, "text": "a {b}", "words": [[0, 0.9, "{b}"]]}], 0, 1, highlight=False)[0][2]


def test_fast_mode_regions_cover_selected_moments():
    dur = 900
    segs = fake_segments(dur)
    hm = [{"start_time": t, "end_time": t + 10, "value": 1.0 if t in (300, 310, 600) else 0.1} for t in range(0, dur, 10)]
    rms = np.full(dur, -30.0)
    m0 = {**M, "weights": {**M["weights"], "keywords": 0}}
    wins = scoring.candidate_windows(dur, hm, rms, m0, M["clips_per_video"] * 2)
    regions = scoring.merge_regions(wins, dur)
    assert sum(e - s for s, e in regions) < dur / 2
    partial = [s for s in segs if any(rs <= s["start"] and s["end"] <= re for rs, re in regions)]
    moments = scoring.select_moments(dur, partial, hm, rms, m0)
    assert moments and all(m["aligned"] for m in moments)
    assert all(any(rs <= m["start"] and m["end"] <= re for rs, re in regions) for m in moments)


def test_merge_regions():
    assert scoring.merge_regions([(100, 132), (140, 172), (500, 532)], 520, pad=20) == [(80.0, 192.0), (480.0, 520.0)]


def test_transcribe_regions_offsets_timestamps(tmp_path, monkeypatch):
    import wave
    from types import SimpleNamespace
    from src import transcribe
    from src.db import DB
    wav = tmp_path / "a.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\x00\x00" * 16000 * 100)
    calls = []
    class FakeModel:
        def transcribe(self, audio, **kw):
            calls.append((len(audio), kw["beam_size"]))
            return iter([SimpleNamespace(start=1.0, end=2.0, text=" mot", words=[SimpleNamespace(start=1.0, end=1.5, word=" mot")])]), None
    monkeypatch.setattr(transcribe, "get_model", lambda tcfg: FakeModel())
    tcfg = {**DEFAULTS["transcription"], "mode": "tres_rapide"}
    segs = transcribe.transcribe(wav, "v", tcfg, DB(tmp_path / "db.sqlite"), regions=[(10.0, 30.0), (60.0, 70.0)])
    assert calls == [(320000, 1), (160000, 1)]
    assert [s["start"] for s in segs] == [11.0, 61.0] and segs[1]["words"][0][:2] == [61.0, 61.5]
