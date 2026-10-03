// Graphiques du site : panneaux empilés qui partagent l'axe horizontal (comme les indicateurs sous un graphique
// de trading), chacun avec sa propre échelle à droite, sans double axe.
// Au survol, les valeurs s'affichent dans une ligne au-dessus du graphique, jamais sur les courbes. Une croix suit
// le curseur : sa valeur s'affiche sur l'axe de droite et la date sur l'axe du bas. Au repos, la ligne du haut
// montre les dernières valeurs.

const DAY = 86_400_000;
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const dateFr = d => new Date(d * DAY).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });

// Graduations du temps : le 1er de chaque mois, ou une date par semaine sur une courte période.
function timeTicks(start, end, width) {
  const span = end - start;
  const room = Math.max(2, Math.floor(width / 70));
  const months = [];
  for (let d = Math.ceil(start); d <= end; d++) if (new Date(d * DAY).getUTCDate() === 1) months.push(d);
  if (months.length >= 2) {
    const every = Math.ceil(months.length / room);
    return months.filter((_, i) => i % every === 0)
      .map(d => [d, new Date(d * DAY).toLocaleDateString('fr-FR', { month: 'short', year: span > 365 ? '2-digit' : undefined, timeZone: 'UTC' })]);
  }
  const step = Math.max(1, Math.ceil(span / room));
  const out = [];
  for (let d = Math.ceil(start); d <= end; d += step) out.push([d, new Date(d * DAY).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' })]);
  return out;
}

// Dessine les panneaux dans `box`. Un panneau : { title, h, fmt, lines: [{ key, label, pts, cls, keyCls }], bars,
// ref, lo, hi, ticks, bands, reverse }. Options : xLabel (date ou valeur affichée au survol), xTicks (graduations).
export function drawPanes(box, panes, start, end, opts = {}) {
  const W = box.clientWidth;
  if (!W) return;
  const span = end - start || 1;
  const L = 8, R = 72, GAP = 26, TOP = 4, AX = 22;
  const H = TOP + panes.reduce((s, p) => s + p.h + GAP, 0) - GAP + AX;
  const x = d => L + ((d - start) / span) * (W - L - R);
  const xLabel = opts.xLabel || dateFr;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Graphique ${panes.map(p => p.title).join(', ')}` });
  let y0 = TOP;
  for (const p of panes) {
    const vals = p.lines.flatMap(l => l.pts.map(q => q[1])).concat(p.ref != null ? [p.ref] : []);
    let lo = p.lo ?? Math.min(...vals), hi = p.hi ?? Math.max(...vals);
    if (p.bars) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (p.lo == null) {
      const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.05 || 1;
      const floor = lo >= 0 ? 0 : -Infinity; // une courbe toujours positive ne descend pas sous zéro
      lo = p.bars ? lo : Math.max(floor, lo - pad);
      hi += pad;
    }
    const top = y0 + 18, bottom = y0 + p.h;
    const y = v => bottom - ((v - lo) / (hi - lo || 1)) * (bottom - top);
    const inv = py => lo + ((bottom - py) / (bottom - top)) * (hi - lo);
    Object.assign(p, { y, inv, top, bottom });
    if (p.title) svg.append(el('text', { x: L, y: y0 + 11, class: 'pt' }, p.title));
    for (const [a, b, cls] of p.bands || []) svg.append(el('rect', { x: L, width: W - L - R, y: y(b), height: y(a) - y(b), class: cls }));
    const ticks = p.ticks || [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
    for (const t of ticks) {
      svg.append(el('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: 'grid' }));
      svg.append(el('text', { x: W - R + 6, y: y(t) + 4, class: 'tick' }, p.fmt(t)));
    }
    if (p.ref != null && !p.bars) svg.append(el('line', { x1: L, x2: W - R, y1: y(p.ref), y2: y(p.ref), class: 'zero' }));
    for (const l of p.reverse ? [...p.lines].reverse() : p.lines) {
      if (!l.pts.length) continue;
      if (p.bars) {
        const bw = Math.max(1, (W - L - R) / span - 1);
        for (const [d, v] of l.pts) svg.append(el('rect', { x: x(d) - bw / 2, width: bw, y: Math.min(y(v), y(0)), height: Math.max(1, Math.abs(y(v) - y(0))), class: v >= 0 ? 'bar-up' : 'bar-down' }));
        svg.append(el('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'zero' }));
        continue;
      }
      const d = l.pts.map((q, i) => `${i ? 'L' : 'M'}${x(q[0]).toFixed(1)},${y(q[1]).toFixed(1)}`).join('');
      if (l.key === 'price' || p.lines.length === 1) {
        svg.append(el('path', { d: `${d}L${x(l.pts.at(-1)[0]).toFixed(1)},${bottom}L${x(l.pts[0][0]).toFixed(1)},${bottom}Z`, class: 'area' }));
      }
      svg.append(el('path', { d, class: `ln ${l.cls}` }));
      const [ld, lv] = l.pts.at(-1);
      svg.append(el('circle', { cx: x(ld), cy: y(lv), r: 3, class: `dot-end ${l.cls}` }));
    }
    y0 = bottom + GAP;
  }
  // Axe horizontal sous le dernier panneau ; les graduations du bord restent dans le cadre.
  for (const [d, label] of (opts.xTicks || timeTicks)(start, end, W - L - R)) {
    const tx = x(d);
    svg.append(el('text', { x: tx, y: H - 6, class: `tick ${tx < L + 24 ? '' : tx > W - R - 24 ? 'end' : 'mid'}` }, label));
  }

  // Croix du survol : ligne verticale sur tous les panneaux, ligne horizontale dans le panneau survolé,
  // valeur sur l'axe de droite, date sur l'axe du bas, un point sur chaque courbe.
  const cross = el('g', { visibility: 'hidden' });
  const vline = el('line', { y1: TOP, y2: H - AX, class: 'cross' });
  const across = el('g', { visibility: 'hidden' });
  const hline = el('line', { x1: L, x2: W - R, class: 'cross' });
  const yRect = el('rect', { x: W - R + 2, width: R - 4, height: 17, rx: 4, class: 'pill' });
  const yText = el('text', { x: W - R + 7, class: 'pill-t' });
  across.append(hline, yRect, yText);
  const xRect = el('rect', { y: H - AX + 2, height: 17, rx: 4, class: 'pill' });
  const xText = el('text', { y: H - AX + 14.5, class: 'pill-t mid' });
  const lines = panes.flatMap(p => (p.bars ? [] : p.lines.map(l => ({ p, l }))));
  const dots = lines.map(({ l }) => el('circle', { r: 3.5, class: `hov-dot ${l.cls}` }));
  cross.append(vline, across, ...dots, xRect, xText);
  const hit = el('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent', tabindex: 0 });
  svg.append(cross, hit);

  // Ligne des valeurs, au-dessus du graphique.
  const read = document.createElement('div');
  read.className = 'ch-read';
  read.setAttribute('aria-live', 'polite');
  box.replaceChildren(read, svg);

  // Le curseur se cale sur les points de la première courbe (les jours sans cotation sont sautés).
  const base = panes.flatMap(p => p.lines).find(l => l.pts.length)?.pts || [];
  const near = raw => {
    if (!base.length) return { i: -1, d: clamp(Math.round(raw), start, end) };
    let a = 0, b = base.length - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (base[m][0] < raw) a = m; else b = m; }
    const i = Math.abs(base[a][0] - raw) <= Math.abs(base[b][0] - raw) ? a : b;
    return { i, d: base[i][0] };
  };
  const tol = opts.tolerance ?? 3;
  const valueAt = (pts, d) => {
    for (let i = pts.length - 1; i >= 0; i--) if (pts[i][0] <= d) return pts[i][0] >= d - tol ? pts[i][1] : null;
    return null;
  };
  const fill = (d, live) => {
    read.classList.toggle('live', live);
    const parts = [`<b class="ch-x">${esc(xLabel(d))}</b>`];
    for (const p of panes) {
      for (const l of p.lines) {
        const v = valueAt(l.pts, d);
        const cls = p.bars && v != null ? (v >= 0 ? ' up' : ' down') : '';
        parts.push(`<span class="ch-v">${p.bars ? '' : `<i class="key ${esc(l.keyCls ?? `k-${l.key}`)}"></i>`}${esc(l.label)} <span class="num${cls}">${v == null ? '—' : esc(p.fmt(v))}</span></span>`);
      }
    }
    read.innerHTML = parts.join('');
  };
  const last = base.length ? base.at(-1)[0] : end;
  let cursor = base.length - 1;
  const show = (raw, py) => {
    const { i, d } = near(clamp(raw, start, end));
    cursor = i;
    const cx = x(d);
    cross.setAttribute('visibility', 'visible');
    vline.setAttribute('x1', cx); vline.setAttribute('x2', cx);
    lines.forEach(({ p, l }, k) => {
      const v = valueAt(l.pts, d);
      dots[k].setAttribute('visibility', v == null ? 'hidden' : 'inherit');
      if (v != null) { dots[k].setAttribute('cx', cx); dots[k].setAttribute('cy', p.y(v)); }
    });
    xText.textContent = xLabel(d);
    const tw = xText.getComputedTextLength() + 14;
    const left = clamp(cx - tw / 2, L, W - R - tw);
    xRect.setAttribute('x', left); xRect.setAttribute('width', tw);
    xText.setAttribute('x', left + tw / 2);
    const p = py == null ? null : panes.find(q => py >= q.top - 8 && py <= q.bottom + 8);
    if (p) {
      const yy = clamp(py, p.top, p.bottom);
      hline.setAttribute('y1', yy); hline.setAttribute('y2', yy);
      yRect.setAttribute('y', yy - 8.5);
      yText.setAttribute('y', yy + 3.5);
      yText.textContent = p.fmt(p.inv(yy));
      across.setAttribute('visibility', 'inherit');
    } else across.setAttribute('visibility', 'hidden');
    fill(d, true);
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); fill(last, false); };
  const at = e => {
    const r = svg.getBoundingClientRect();
    const k = W / (r.width || W);
    return [start + (((e.clientX - r.left) * k - L) / (W - L - R)) * span, (e.clientY - r.top) * k];
  };
  hit.addEventListener('pointermove', e => show(...at(e)));
  hit.addEventListener('pointerdown', e => show(...at(e)));
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('focus', () => { if (base.length) show(base[clamp(cursor, 0, base.length - 1)][0]); });
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' || !base.length) return;
    e.preventDefault();
    cursor = clamp(cursor + (e.key === 'ArrowLeft' ? -1 : 1), 0, base.length - 1);
    show(base[cursor][0]);
  });
  fill(last, false);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
