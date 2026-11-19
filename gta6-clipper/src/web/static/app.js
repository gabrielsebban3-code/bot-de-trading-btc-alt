(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const post = (url, method = "POST") => fetch(url, { method }).then((r) => (r.ok ? r.json() : Promise.reject(r)));

  // --- filtres : envoi automatique ---
  const filters = $("filters");
  if (filters) filters.querySelectorAll("select").forEach((s) => s.addEventListener("change", () => filters.submit()));

  // --- job en tâche de fond ---
  const jobBox = $("job");
  if (jobBox) {
    const btn = $("run-btn"), info = $("job-info"), logEl = $("job-log");
    let timer = null, wasRunning = jobBox.dataset.running === "1";
    const render = (j) => {
      const idx = j.stages.indexOf(j.stage);
      document.querySelectorAll(".stage").forEach((el, i) => {
        el.classList.toggle("active", j.running && i === idx);
        el.classList.toggle("done", j.running && i < idx);
      });
      btn.disabled = j.running;
      const parts = [];
      if (j.running) parts.push(j.video_total ? `Vidéo ${j.video_index}/${j.video_total} : ${j.video}` : "Recherche en cours…");
      if (j.clips) parts.push(`${j.clips} clip(s) créé(s)`);
      if (j.errors) parts.push(`${j.errors} erreur(s)`);
      if (j.error) parts.push(`Échec : ${j.error}`);
      info.textContent = parts.join(" · ");
      logEl.hidden = !j.log.length;
      logEl.textContent = j.log.join("\n");
      logEl.scrollTop = logEl.scrollHeight;
    };
    const poll = () => fetch("/api/job").then((r) => r.json()).then((j) => {
      render(j);
      if (!j.running) {
        clearInterval(timer); timer = null;
        if (wasRunning && j.clips) info.textContent += " · Terminé, rechargement…", setTimeout(() => location.reload(), 1500);
        wasRunning = false;
      }
    });
    const startPolling = () => { if (!timer) timer = setInterval(poll, 1500); poll(); };
    btn.addEventListener("click", () => {
      btn.disabled = true;
      post("/api/run").catch(() => {}).finally(() => { wasRunning = true; startPolling(); });
    });
    if (wasRunning) startPolling(); else poll();
  }

  // --- lecteur vertical ---
  const dataEl = $("clips-data");
  if (!dataEl) return;
  const clips = JSON.parse(dataEl.textContent);
  const player = $("player"), video = $("video");
  let cur = -1;

  const card = (id) => document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  const show = (i) => {
    if (!clips.length) return close();
    cur = (i + clips.length) % clips.length;
    const c = clips[cur];
    video.src = `/media/${encodeURIComponent(c.id)}.mp4`;
    video.play().catch(() => {});
    $("p-title").textContent = c.video_title;
    $("p-sub").textContent = `Source : ${c.channel} · ${c.duration} s · score ${c.score.toFixed(2)} · ${cur + 1}/${clips.length}`;
    $("p-fav").textContent = c.favorite ? "★ Favori" : "☆ Favori";
    $("p-dl").href = `/download/${encodeURIComponent(c.id)}`;
    $("p-yt").href = c.yt;
    player.hidden = false;
  };
  const close = () => { video.pause(); video.removeAttribute("src"); video.load(); player.hidden = true; cur = -1; };
  const toggleFav = () => {
    const c = clips[cur];
    post(`/api/clips/${encodeURIComponent(c.id)}/favorite`).then((r) => {
      c.favorite = r.favorite;
      $("p-fav").textContent = c.favorite ? "★ Favori" : "☆ Favori";
      const el = card(c.id); if (el) el.classList.toggle("fav", !!c.favorite);
    });
  };
  const del = () => {
    const c = clips[cur];
    if (!confirm("Supprimer ce clip (fichier compris) ?")) return;
    post(`/api/clips/${encodeURIComponent(c.id)}`, "DELETE").then(() => {
      const el = card(c.id); if (el) el.remove();
      clips.splice(cur, 1);
      clips.length ? show(cur) : close();
    });
  };

  video.addEventListener("play", () => {
    const c = clips[cur];
    if (!c || c.seen) return;
    c.seen = 1;
    post(`/api/clips/${encodeURIComponent(c.id)}/seen`).then(() => {
      const el = card(c.id);
      if (el) { el.classList.remove("unseen"); const b = el.querySelector(".badge"); if (b) b.remove(); }
    });
  });

  document.querySelectorAll(".card").forEach((el) => {
    const open = () => show(clips.findIndex((c) => c.id === el.dataset.id));
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  });
  $("p-next").addEventListener("click", () => show(cur + 1));
  $("p-prev").addEventListener("click", () => show(cur - 1));
  $("p-fav").addEventListener("click", toggleFav);
  $("p-del").addEventListener("click", del);
  $("p-close").addEventListener("click", close);

  document.addEventListener("keydown", (e) => {
    if (player.hidden || e.target.matches("input, textarea, select")) return;
    const k = e.key;
    if (k === "ArrowUp") { e.preventDefault(); show(cur + 1); }
    else if (k === "ArrowDown") { e.preventDefault(); show(cur - 1); }
    else if (k === "f" || k === "F") toggleFav();
    else if (k === "Delete") del();
    else if (k === "Escape") close();
  });

  // balayage vertical sur téléphone : vers le haut = suivant
  let y0 = null;
  player.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  player.addEventListener("touchend", (e) => {
    if (y0 === null) return;
    const dy = e.changedTouches[0].clientY - y0; y0 = null;
    if (Math.abs(dy) > 70) show(cur + (dy < 0 ? 1 : -1));
  }, { passive: true });
})();
