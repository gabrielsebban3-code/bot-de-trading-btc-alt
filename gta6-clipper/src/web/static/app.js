(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const post = (url, method = "POST", body = undefined) =>
    fetch(url, { method, body }).then((r) => (r.ok ? r.json() : Promise.reject(r)));

  // --- filtres : envoi automatique ---
  const filters = $("filters");
  if (filters) filters.querySelectorAll("select").forEach((s) => s.addEventListener("change", () => filters.submit()));

  // --- job en tâche de fond (site ou terminal) ---
  const jobBox = $("job");
  if (jobBox) {
    const btn = $("run-btn"), info = $("job-info"), logEl = $("job-log"), urlForm = $("url-form");
    const urlBtn = urlForm.querySelector("button"), cancelBtn = $("cancel-btn");
    let wasRunning = jobBox.dataset.running === "1", lastClips = null;
    const playerOpen = () => { const p = $("player"); return p && !p.hidden; };
    const render = (j) => {
      const idx = j.stages.indexOf(j.stage);
      document.querySelectorAll(".stage").forEach((el, i) => {
        el.classList.toggle("active", j.running && i === idx);
        el.classList.toggle("done", j.running && i < idx);
      });
      btn.disabled = urlBtn.disabled = j.running;
      cancelBtn.hidden = !j.running;
      if (!j.running) cancelBtn.disabled = false;
      if (j.cancelling) cancelBtn.disabled = true;
      const parts = [];
      if (j.running && (j.cancelling || cancelBtn.disabled)) parts.push("Annulation en cours : arrêt à la fin de l'étape en cours…");
      if (j.running) parts.push(j.video_total ? `Vidéo ${j.video_index}/${j.video_total} : ${j.video}` : "Recherche en cours…");
      if (j.running && j.detail) parts.push(j.detail);
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
      const clips = j.clips || 0;
      // nouveaux clips pendant le traitement, ou fin du traitement : on recharge (sauf lecteur ouvert)
      const grew = lastClips !== null && clips > lastClips;
      const ended = wasRunning && !j.running;
      if ((grew || (ended && clips)) && !playerOpen()) setTimeout(() => location.reload(), 800);
      if (j.running) wasRunning = true; else if (ended) wasRunning = false;
      lastClips = j.running ? clips : null;
    }).catch(() => {});
    const launch = (body) => {
      btn.disabled = urlBtn.disabled = true;
      fetch("/api/run", { method: "POST", body }).then((r) => r.json()).then((r) => {
        if (!r.started) info.textContent = r.error || "Impossible de lancer";
        else { wasRunning = true; lastClips = 0; }
      }).finally(poll);
    };
    btn.addEventListener("click", () => launch(new FormData()));
    cancelBtn.addEventListener("click", () => {
      if (!confirm("Annuler le traitement en cours ? Les clips déjà créés sont gardés.")) return;
      cancelBtn.disabled = true;
      fetch("/api/cancel", { method: "POST" }).then((r) => r.json()).then((r) => {
        if (!r.cancelling) { cancelBtn.disabled = false; info.textContent = r.error || "Impossible d'annuler"; }
      }).finally(poll);
    });
    urlForm.addEventListener("submit", (e) => { e.preventDefault(); launch(new FormData(urlForm)); urlForm.reset(); });
    poll();
    setInterval(poll, 2000);
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
    video.src = `/media/${encodeURIComponent(c.id)}.mp4?v=${c.file_size}`;
    $("p-hook").value = c.hook || "";
    const box = $("p-ideas");
    box.textContent = "";
    (c.ideas || []).forEach((t) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "idea"; b.textContent = t;
      b.addEventListener("click", () => { $("p-hook").value = t; $("p-hook").focus(); });
      box.appendChild(b);
    });
    $("p-hook-status").textContent = "";
    video.play().catch(() => {});
    $("p-title").textContent = c.video_title;
    $("p-sub").textContent = `Source : ${c.channel} · ${c.duration} s · score ${c.score.toFixed(2)} · ${cur + 1}/${clips.length}`;
    $("p-why").textContent = c.why ? `Pourquoi : ${c.why}` : "";
    $("p-fav").textContent = c.favorite ? "★ Favori" : "☆ Favori";
    showRating(c);
    $("p-dl").href = `/download/${encodeURIComponent(c.id)}`;
    $("p-dl2").href = $("p-dl").href;
    $("p-caption").value = c.caption || "";
    $("tt-panel").hidden = true;
    showPosted(c);
    $("p-yt").href = c.yt;
    player.hidden = false;
  };
  const close = () => { video.pause(); video.removeAttribute("src"); video.load(); player.hidden = true; cur = -1; };
  const showPosted = (c) => { $("p-posted").textContent = c.posted ? "✔ Publié (annuler)" : "4. Marquer comme publié"; };
  const copyCaption = () => {
    const ta = $("p-caption"), done = () => { $("p-copy").textContent = "✔ Copiée"; setTimeout(() => { $("p-copy").textContent = "1. Copier la légende"; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(ta.value).then(done);
    else { ta.select(); document.execCommand("copy"); done(); }  // accès depuis le téléphone (http) : pas d'API presse-papiers
  };
  const togglePosted = () => {
    const c = clips[cur];
    post(`/api/clips/${encodeURIComponent(c.id)}/posted`).then((r) => {
      c.posted = r.posted; showPosted(c);
      const el = card(c.id);
      if (el) {
        let m = el.querySelector(".postedmark");
        if (r.posted && !m) { m = document.createElement("span"); m.className = "postedmark"; m.textContent = "PUBLIÉ"; el.querySelector(".thumb").appendChild(m); }
        if (!r.posted && m) m.remove();
      }
    });
  };
  const showRating = (c) => {
    $("p-good").classList.toggle("on", c.rating === 1);
    $("p-bad").classList.toggle("on", c.rating === -1);
  };
  const rate = (value) => {
    const c = clips[cur], body = new FormData();
    body.append("value", value);
    post(`/api/clips/${encodeURIComponent(c.id)}/rate`, "POST", body).then((r) => { c.rating = r.rating; showRating(c); });
  };
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
  $("p-good").addEventListener("click", () => rate(1));
  $("p-tt").addEventListener("click", () => { $("tt-panel").hidden = !$("tt-panel").hidden; });
  $("p-copy").addEventListener("click", copyCaption);
  $("p-posted").addEventListener("click", togglePosted);
  $("p-bad").addEventListener("click", () => rate(-1));
  $("p-close").addEventListener("click", close);
  $("hook-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const c = clips[cur], btn = $("p-hook-btn"), st = $("p-hook-status");
    btn.disabled = true;
    st.textContent = "Clip en cours de refabrication (environ 30 s)…";
    fetch(`/api/clips/${encodeURIComponent(c.id)}/hook`, { method: "POST", body: new FormData($("hook-form")) })
      .then((r) => r.json()).then((r) => {
        if (r.ok) { st.textContent = "Fait, rechargement…"; setTimeout(() => location.reload(), 600); }
        else { st.textContent = `Échec : ${r.error}`; btn.disabled = false; }
      }).catch(() => { st.textContent = "Échec (le site tourne-t-il ?)"; btn.disabled = false; });
  });

  document.addEventListener("keydown", (e) => {
    if (player.hidden || e.target.matches("input, textarea, select")) return;  // taper le titre ≠ raccourcis
    const k = e.key;
    if (k === "ArrowUp") { e.preventDefault(); show(cur + 1); }
    else if (k === "ArrowDown") { e.preventDefault(); show(cur - 1); }
    else if (k === "f" || k === "F") toggleFav();
    else if (k === "Delete") del();
    else if (k === "b" || k === "B") rate(1);
    else if (k === "n" || k === "N") rate(-1);
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
