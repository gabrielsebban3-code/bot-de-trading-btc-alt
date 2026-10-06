// Catégorie Indicateurs : graphique interactif des jambes (moteur Lightweight Charts de TradingView, gratuit, Apache 2.0).
// Bougies de la paire choisie en 4 h, jour ou semaine ; fond vert ou rouge selon la jambe, flèche au signal de début
// de chaque jambe, rond sur chaque creux et chaque sommet, moyennes 9 et 21, volume. On zoome (pincer, molette),
// on fait glisser, on touche une bougie pour ouvrir la fiche de sa jambe, et la liste des jambes recentre le graphique.
import { fmt } from './format.js';
import { LEG, LEG_TESTS, legDetails, legsOf, toWeeks } from './legs-lib.js';

const LWC_URL = 'https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.mjs';
const DAY = 86_400_000;
export const TF = [
  { key: 'h4', label: '4 h', title: 'bougies de 4 h', ms: 4 * 3600_000 },
  { key: 'd1', label: 'Jour', title: 'bougies journalières', ms: DAY },
  { key: 'w1', label: 'Semaine', title: 'bougies hebdomadaires', ms: 7 * DAY },
];
const RANGES = [['1m', '1 mois', 30], ['3m', '3 mois', 91], ['6m', '6 mois', 182], ['1a', '1 an', 365], ['all', 'Tout', null]];
const LAYERS = [['ma', 'Moyennes 9 et 21'], ['bg', 'Fond des jambes'], ['ext', 'Creux et sommets'], ['sig', 'Signaux ▲▼'], ['vol', 'Volume'], ['log', 'Échelle log']];

const store = {
  get() { try { return JSON.parse(localStorage.getItem('dinexo-jambes')) || {}; } catch { return {}; } },
  set(v) { try { localStorage.setItem('dinexo-jambes', JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};
const st = { sym: null, tf: 'd1', range: '6m', layers: { ma: true, bg: true, ext: true, sig: true, vol: false, log: false }, ...store.get() };
st.layers = { ma: true, bg: true, ext: true, sig: true, vol: false, log: false, ...st.layers };

const cache = new Map();
let lib = null, root = null, symbols = [], chart = null, view = null, sel = null;

const px = n => {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  return fmt(n, a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 4);
};
const pct = (x, d = 1) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${fmt(Math.abs(x) * 100, d)} %`;
const dayTxt = (t, tf) => new Date(t).toLocaleString('fr-FR', tf === 'h4'
  ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }
  : { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const lagTxt = ms => {
  const d = ms / DAY;
  return d < 2 ? `${fmt(ms / 3600_000, 0)} h` : d < 21 ? `${fmt(d, 0)} jours` : `${fmt(d / 7, 0)} semaines`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cssVar = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
const sec = t => Math.floor(t / 1000);
const save = () => store.set({ sym: st.sym, tf: st.tf, range: st.range, layers: st.layers });

async function loadLib() {
  lib ??= globalThis.LightweightCharts ? Promise.resolve(globalThis.LightweightCharts) : import(/* @vite-ignore */ LWC_URL);
  return lib;
}

async function load(sym) {
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < 600_000) return hit.d;
  const res = await fetch(`data/paire/${encodeURIComponent(sym)}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(String(res.status));
  const raw = await res.json();
  const obj = r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], closed: r[6] !== 0 });
  const d1 = raw.d1.map(obj).filter(b => b.closed);
  const w1 = toWeeks(d1);
  // La semaine en cours n'est pas finie : on ne garde que les semaines complètes.
  if (w1.length && w1.at(-1).t + 7 * DAY > d1.at(-1).t + DAY) w1.pop();
  const d = { h4: raw.h4.map(obj).filter(b => b.closed), d1, w1 };
  cache.set(sym, { at: Date.now(), d });
  return d;
}

// Texte des tests pour l'unité de temps choisie.
export function tfNote(key) {
  const s = LEG_TESTS[key];
  const name = TF.find(t => t.key === key).title;
  return `Testé sur BTC, ETH et SOL depuis 2023, en ${name} : signal en moyenne ${pct(s.entry, 0)} au-dessus du creux, sortie ${pct(-s.exit, 0).replace('+', '')} sous le sommet, `
    + `${s.switches < 2 ? '1 à 2 changements' : `environ ${fmt(s.switches, 0)} changements`} de sens par an. `
    + `En restant dans les jambes haussières : ${pct(s.gain[0], 0)} en 2023-2024, ${pct(s.gain[1], 0)} en 2025-2026 (garder la crypto : ${pct(s.hold[0], 0)} puis ${pct(s.hold[1], 0)}).`
    + (key === 'd1' ? ' C\'est l\'unité la plus fiable.' : key === 'h4' ? ' Beaucoup de faux départs.' : ' On entre et on sort très tard.');
}

// ---------- Squelette ----------

function shell() {
  const chips = (group, list, cur, extra = () => '') => list.map(([k, l]) => `<button type="button" class="chip" data-${group}="${k}" aria-pressed="${k === cur}">${l}${extra(k)}</button>`).join('');
  return `<div class="jb-head">
      <h2>Les jambes sur le graphique</h2>
      <div class="jb-btns">
        <button type="button" class="jb-ico" data-act="fit" title="Tout recentrer" aria-label="Tout recentrer">⟲</button>
        <button type="button" class="jb-ico" data-act="full" title="Plein écran" aria-label="Plein écran">⤢</button>
      </div>
    </div>
    <div class="tools" role="group" aria-label="Paire">${chips('sym', symbols.map(s => [s, s]), st.sym)}</div>
    <div class="tools" role="group" aria-label="Unité de temps">${chips('tf', TF.map(t => [t.key, t.label]), st.tf, k => (k === 'd1' ? ' (conseillé)' : ''))}</div>
    <div class="tools sm" role="group" aria-label="Période affichée">${chips('range', RANGES, st.range)}</div>
    <details class="jb-layers"><summary>Afficher sur le graphique</summary>
      <div class="jb-checks">${LAYERS.map(([k, l]) => `<label><input type="checkbox" data-layer="${k}" ${st.layers[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
    </details>
    <div class="jb-read" aria-live="polite"></div>
    <div class="jb-chart" role="img" aria-label="Graphique des jambes"><div class="empty">Chargement du graphique…</div></div>
    <p class="jb-hint">Pince ou fais défiler pour zoomer, fais glisser pour te déplacer. Touche une bougie pour voir sa jambe.</p>
    <div class="jb-leg"></div>
    <p class="jb-sum"></p>
    <details class="jb-list"><summary>Toutes les jambes</summary><div class="wrap" tabindex="0" role="region" aria-label="Liste des jambes"><table class="static jb-table"></table></div></details>
    <p class="jb-note">${esc(tfNote(st.tf))}</p>`;
}

export function mountLegs(el, syms) {
  root = el;
  root.classList.add('box', 'jb');
  symbols = syms;
  if (!symbols.includes(st.sym)) st.sym = symbols[0];
  if (!TF.some(t => t.key === st.tf)) st.tf = 'd1';
  root.innerHTML = shell();
  root.addEventListener('click', onClick);
  root.addEventListener('change', e => {
    const k = e.target.dataset?.layer;
    if (!k) return;
    st.layers[k] = e.target.checked;
    save();
    applyLayers();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && root.classList.contains('full')) toggleFull(); });
  // Thème clair ou sombre changé : on redessine avec les nouvelles couleurs.
  new MutationObserver(() => { if (chart) draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  draw();
}

// Recentre sur une paire depuis une carte de la liste (bouton « Voir sur le graphique »).
export function showLegs(sym) {
  if (!root) return;
  st.sym = sym;
  save();
  syncChips();
  draw();
  root.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function syncChips() {
  for (const b of root.querySelectorAll('[data-sym]')) b.setAttribute('aria-pressed', String(b.dataset.sym === st.sym));
  for (const b of root.querySelectorAll('[data-tf]')) b.setAttribute('aria-pressed', String(b.dataset.tf === st.tf));
  for (const b of root.querySelectorAll('[data-range]')) b.setAttribute('aria-pressed', String(b.dataset.range === st.range));
  root.querySelector('.jb-note').textContent = tfNote(st.tf);
}

function onClick(e) {
  const b = e.target.closest('button, tr[data-leg]');
  if (!b) return;
  if (b.dataset.sym) { st.sym = b.dataset.sym; sel = null; save(); syncChips(); draw(); }
  else if (b.dataset.tf) { st.tf = b.dataset.tf; sel = null; save(); syncChips(); draw(); }
  else if (b.dataset.range) { st.range = b.dataset.range; save(); syncChips(); applyRange(); }
  else if (b.dataset.act === 'fit') { st.range = 'all'; save(); syncChips(); applyRange(); }
  else if (b.dataset.act === 'full') toggleFull();
  else if (b.dataset.leg) { selectLeg(Number(b.dataset.leg), true); root.querySelector('.jb-chart').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

function toggleFull() {
  const on = root.classList.toggle('full');
  document.body.classList.toggle('jb-locked', on);
  root.querySelector('[data-act="full"]').textContent = on ? '✕' : '⤢';
  root.querySelector('[data-act="full"]').setAttribute('aria-label', on ? 'Fermer le plein écran' : 'Plein écran');
}

// ---------- Dessin ----------

async function draw() {
  const box = root.querySelector('.jb-chart');
  let d, L;
  try { [d, L] = await Promise.all([load(st.sym), loadLib()]); } catch {
    chart?.remove(); chart = null;
    box.innerHTML = '<div class="empty">Graphique indisponible pour le moment.</div>';
    return;
  }
  const bars = d[st.tf];
  const r = legsOf(bars);
  if (!r) { chart?.remove(); chart = null; box.innerHTML = '<div class="empty">Pas assez d\'historique pour cette unité de temps.</div>'; return; }
  const legs = legDetails(bars, r);
  const col = {
    up: cssVar('--up', '#16a34a'), down: cssVar('--down', '#dc2626'), acc: cssVar('--accent', '#f97316'),
    fg: cssVar('--fg', '#111'), muted: cssVar('--muted', '#777'), line: cssVar('--line', '#ddd'), panel: cssVar('--panel', '#fff'),
    ma9: cssVar('--s-ma20', '#a78bfa'), ma21: cssVar('--s-ma50', '#3b82f6'),
  };
  chart?.remove();
  box.innerHTML = '';
  chart = L.createChart(box, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: col.muted, fontFamily: getComputedStyle(document.body).fontFamily, attributionLogo: true },
    grid: { vertLines: { visible: false }, horzLines: { color: col.line } },
    rightPriceScale: { borderVisible: false, mode: st.layers.log ? 1 : 0 },
    timeScale: { borderVisible: false, timeVisible: st.tf === 'h4', secondsVisible: false, rightOffset: 4 },
    crosshair: { mode: 0 },
    localization: { locale: 'fr-FR', priceFormatter: px },
    handleScale: { axisPressedMouseMove: true, pinch: true, mouseWheel: true },
    handleScroll: { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
  });
  const T = b => sec(b.t);
  // Fond des jambes : un histogramme pleine hauteur sur une échelle cachée.
  const alpha = (c, a) => (c.startsWith('#') && c.length === 7 ? `${c}${Math.round(a * 255).toString(16).padStart(2, '0')}` : c);
  const legOf = new Array(bars.length).fill(null);
  for (const l of legs) for (let k = l.from; k <= l.to; k++) legOf[k] = l;
  // Surface pleine hauteur (sans trou entre les bougies), colorée point par point.
  const bg = chart.addSeries(L.AreaSeries, { priceScaleId: 'bg', lastValueVisible: false, priceLineVisible: false, lineVisible: false, lineWidth: 1, crosshairMarkerVisible: false, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 1 } }) });
  chart.priceScale('bg').applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
  bg.setData(bars.map((b, k) => {
    const c = legOf[k] ? alpha(legOf[k].dir === 'up' ? col.up : col.down, 0.12) : 'rgba(0,0,0,0)';
    return { time: T(b), value: 1, topColor: c, bottomColor: c, lineColor: 'rgba(0,0,0,0)' };
  }));
  const vol = chart.addSeries(L.HistogramSeries, { priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false, priceFormat: { type: 'volume' } });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
  vol.setData(bars.map(b => ({ time: T(b), value: b.v || 0, color: alpha(b.c >= b.o ? col.up : col.down, 0.35) })));
  const candles = chart.addSeries(L.CandlestickSeries, {
    upColor: col.up, downColor: col.down, borderVisible: false, wickUpColor: col.up, wickDownColor: col.down, priceFormat: { type: 'custom', formatter: px, minMove: 1e-8 },
  });
  candles.setData(bars.map(b => ({ time: T(b), open: b.o, high: b.h, low: b.l, close: b.c })));
  const line = (vals, color) => {
    const s = chart.addSeries(L.LineSeries, { color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    s.setData(bars.map((b, k) => ({ time: T(b), value: vals[k] })).slice(LEG.slow));
    return s;
  };
  const ma9 = line(r.fast, col.ma9), ma21 = line(r.slow, col.ma21);
  const markers = L.createSeriesMarkers(candles, []);
  view = { L, bars, legs, legOf, col, candles, bg, vol, ma9, ma21, markers, T };
  applyLayers();
  applyRange();
  chart.subscribeCrosshairMove(p => readout(p?.time != null ? indexOf(p.time) : null));
  chart.subscribeClick(p => { const k = p?.time != null ? indexOf(p.time) : null; if (k != null && legOf[k]) selectLeg(legOf[k].n - 1); });
  renderList();
  selectLeg(sel ?? legs.length - 1, false);
  readout(null);
}

const indexOf = time => {
  const { bars } = view;
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (sec(bars[m].t) <= time) lo = m; else hi = m - 1; }
  return lo;
};

function markersFor() {
  const { legs, col, T, bars } = view;
  const out = [];
  const big = st.tf === 'h4' ? 0.08 : 0.15;
  legs.forEach((l, k) => {
    if (st.layers.sig && k > 0) out.push({ time: T(bars[l.from]), position: l.dir === 'up' ? 'belowBar' : 'aboveBar', shape: l.dir === 'up' ? 'arrowUp' : 'arrowDown', color: l.dir === 'up' ? col.up : col.down, size: 1.2, id: `s${k}` });
    if (st.layers.ext && (k > 0 || !l.open)) {
      const prev = legs[k - 1]?.ext.price;
      const swing = prev ? Math.abs(l.ext.price / prev - 1) : 0;
      const i = bars.findIndex(b => b.t === l.ext.t);
      out.push({ time: T(bars[i]), position: l.dir === 'up' ? 'aboveBar' : 'belowBar', shape: 'circle', color: l.dir === 'up' ? col.acc : col.up, size: 0.8,
        text: swing >= big || l.open || k === legs.length - 2 ? `${l.dir === 'up' ? 'Sommet' : 'Creux'} ${px(l.ext.price)}` : '', id: `e${k}` });
    }
  });
  return out.sort((a, b) => a.time - b.time);
}

function applyLayers() {
  if (!view) return;
  const { bg, vol, ma9, ma21, markers } = view;
  bg.applyOptions({ visible: st.layers.bg });
  vol.applyOptions({ visible: st.layers.vol });
  ma9.applyOptions({ visible: st.layers.ma });
  ma21.applyOptions({ visible: st.layers.ma });
  chart.priceScale('right').applyOptions({ mode: st.layers.log ? 1 : 0 });
  markers.setMarkers(markersFor());
}

function applyRange() {
  if (!view) return;
  const { bars, T } = view;
  const days = RANGES.find(x => x[0] === st.range)?.[2];
  if (!days) { chart.timeScale().fitContent(); return; }
  const to = bars.at(-1).t, from = to - days * DAY;
  // Période plus longue que l'historique (3 mois en 4 h) : on montre tout.
  if (from <= bars[0].t) { chart.timeScale().fitContent(); return; }
  chart.timeScale().setVisibleRange({ from: sec(from), to: T(bars.at(-1)) });
}

// Ligne au-dessus du graphique : la bougie survolée (ou la dernière) et la jambe où elle se trouve.
function readout(k) {
  const el = root.querySelector('.jb-read');
  if (!view || !el) return;
  const { bars, legOf } = view;
  const i = k ?? bars.length - 1;
  const b = bars[i], l = legOf[i];
  const ch = i ? b.c / bars[i - 1].c - 1 : 0;
  el.classList.toggle('live', k != null);
  el.innerHTML = `<b>${esc(dayTxt(b.t, st.tf))}</b>
    <span>Ouv. <i>${px(b.o)}</i></span><span>Haut <i>${px(b.h)}</i></span><span>Bas <i>${px(b.l)}</i></span><span>Clôt. <i>${px(b.c)}</i> <i class="${ch >= 0 ? 'up' : 'down'}">${pct(ch)}</i></span>
    ${st.layers.ma ? `<span class="m9">Moy. 9 <i>${px(view.ma9.data().find(x => x.time === view.T(b))?.value)}</i></span><span class="m21">Moy. 21 <i>${px(view.ma21.data().find(x => x.time === view.T(b))?.value)}</i></span>` : ''}
    ${l ? `<span class="${l.dir}">${l.dir === 'up' ? '▲ Jambe haussière' : '▼ Jambe baissière'} </span>` : ''}`;
}

// Fiche de la jambe choisie, sous le graphique.
function selectLeg(k, zoom) {
  if (!view) return;
  const { legs, bars } = view;
  const l = legs[clampIdx(k, legs.length)];
  if (!l) return;
  sel = l.n - 1;
  const up = l.dir === 'up';
  const word = up ? 'creux' : 'sommet';
  const dur = l.bars * TF.find(t => t.key === st.tf).ms;
  const res = l.result;
  root.querySelector('.jb-leg').innerHTML = `<div class="leg ${up ? 'up' : 'down'}">
    <span class="leg-hd"><b>${up ? '▲ Jambe haussière' : '▼ Jambe baissière'}</b> ${l.open ? '<span class="tag acc">en cours</span>' : ''} <span class="muted">${esc(lagTxt(dur))}</span></span>
    <dl class="leg-dl">
      ${l.origin ? `<dt>Vrai ${word}</dt><dd>${px(l.origin.price)} <span class="muted">le ${esc(dayTxt(l.origin.t, st.tf))}</span></dd>` : ''}
      <dt>Signal ${up ? '▲' : '▼'}</dt><dd>${px(l.signal.price)} <span class="muted">le ${esc(dayTxt(l.signal.t, st.tf))}</span></dd>
      ${l.origin ? `<dt>Retard sur le ${word}</dt><dd>${esc(lagTxt(l.lagMs))}, ${pct(Math.abs(l.fromOrigin))} ${up ? 'plus haut' : 'plus bas'}</dd>` : ''}
      <dt>${up ? 'Plus haut atteint' : 'Plus bas atteint'}</dt><dd>${px(l.ext.price)} <span class="muted">le ${esc(dayTxt(l.ext.t, st.tf))} (${pct(l.move)} depuis le signal)</span></dd>
      <dt>${l.open ? 'En ce moment' : 'Fin de la jambe'}</dt><dd>${l.open ? px(bars.at(-1).c) : `${px(l.exit.price)} <span class="muted">le ${esc(dayTxt(l.exit.t, st.tf))}</span>`}</dd>
      <dt>${up ? 'En achetant au signal' : 'En vendant (short) au signal'}</dt><dd class="${res >= 0 ? 'up' : 'down'}"><b>${pct(res)}</b> ${l.open ? '<span class="muted">pour l\'instant</span>' : ''}</dd>
    </dl>
    <div class="leg-nav"><button type="button" class="chip" data-nav="-1" ${sel ? '' : 'disabled'}>← Jambe précédente</button><button type="button" class="chip" data-nav="1" ${sel < legs.length - 1 ? '' : 'disabled'}>Jambe suivante →</button></div>
  </div>`;
  root.querySelector('.jb-leg').onclick = e => { const n = e.target.closest('[data-nav]'); if (n) selectLeg(sel + Number(n.dataset.nav), true); };
  for (const tr of root.querySelectorAll('tr[data-leg]')) tr.classList.toggle('on', Number(tr.dataset.leg) === sel);
  if (zoom) {
    const pad = Math.max(5, Math.round(l.bars * 0.4));
    const a = Math.max(0, l.from - pad - (l.origin ? Math.round((l.lagMs / TF.find(t => t.key === st.tf).ms)) : 0)), z = Math.min(bars.length - 1, l.from + l.bars + pad);
    chart.timeScale().setVisibleRange({ from: sec(bars[a].t), to: sec(bars[z].t) });
  }
}
const clampIdx = (k, n) => Math.max(0, Math.min(n - 1, k));

function renderList() {
  const { legs } = view;
  const rows = [...legs].reverse().filter(l => l.n > 1).map(l => `<tr data-leg="${l.n - 1}" tabindex="0">
      <td class="l"><span class="${l.dir}">${l.dir === 'up' ? '▲' : '▼'}</span> ${esc(dayTxt(l.signal.t, st.tf))}</td>
      <td class="n">${esc(lagTxt(l.bars * TF.find(t => t.key === st.tf).ms))}</td>
      <td class="n">${l.origin ? esc(lagTxt(l.lagMs)) : '—'}</td>
      <td class="n ${l.result >= 0 ? 'up' : 'down'}">${pct(l.result)}${l.open ? ' *' : ''}</td>
    </tr>`).join('');
  // Bilan en suivant seulement les jambes haussières (achat au signal ▲, vente au signal ▼ suivant), gains composés.
  const ups = legs.filter(l => l.n > 1 && l.dir === 'up');
  const won = ups.filter(l => l.result > 0).length;
  const total = ups.reduce((m, l) => m * (1 + l.result), 1) - 1;
  const first = legs[1]?.signal.t;
  root.querySelector('.jb-sum').innerHTML = ups.length ? `Depuis le ${esc(dayTxt(first, 'd1'))}, en achetant à chaque ▲ et en revendant au ▼ suivant : <b>${ups.length} jambes haussières</b>, ${won} en gain, `
    + `<b class="${total >= 0 ? 'up' : 'down'}">${pct(total, 0)}</b> au total (frais non compris). Garder ${esc(st.sym)} sur la même période : ${pct(view.bars.at(-1).c / view.bars[legs[1].from].c - 1, 0)}.` : '';
  root.querySelector('.jb-list summary').textContent = `Toutes les jambes (${legs.length - 1})`;
  root.querySelector('.jb-table').innerHTML = `<thead><tr><th class="l">Signal</th><th>Durée</th><th>Retard</th><th>Résultat</th></tr></thead><tbody>${rows}</tbody>`;
  root.querySelector('.jb-table').onkeydown = e => { if (e.key === 'Enter') e.target.closest('tr[data-leg]')?.click(); };
}
