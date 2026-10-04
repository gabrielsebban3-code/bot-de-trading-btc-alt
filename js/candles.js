// Graphique de la fiche crypto : le prix en bougies (ou en courbe) avec ses moyennes, puis des panneaux empilés
// qui partagent l'axe du temps (volume, RSI, MACD, force face à BTC, funding…), chacun avec sa propre échelle
// à droite, sans double axe. Au survol (souris, doigt ou flèches du clavier), les valeurs de la bougie s'affichent
// dans la ligne au-dessus du graphique ; une croix suit le curseur, avec la valeur sur l'axe de droite et la date
// sur l'axe du bas. Au repos, la ligne du haut montre la dernière bougie.

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let clipId = 0; // identifiants uniques des cadres de découpe, d'un dessin à l'autre
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Graduations rondes (1, 2, 2,5 ou 5 × 10ⁿ) entre lo et hi.
export function niceTicks(lo, hi, count = 4) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw * 0.999);
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Number(t.toPrecision(12)));
  return out;
}

// spec : {
//   bars : [[temps, o, h, l, c, volume]], line : true pour une courbe des clôtures,
//   label(i) : date longue de la bougie i (survol), ticks : [[i, texte]] pour l'axe du temps,
//   price : { title, h, fmt, overlays : [{ key, label, cls, vals }],
//             levels : [{ v, label, cls }] (lignes horizontales du plan), marks : [{ i, dir : 'long' | 'short', cls }] (flèches sous ou sur les bougies) },
//   panes : [{ title, h, fmt, kind : 'volume' | 'line' | 'bars' | 'macd', series : [{ key, label, cls, vals }],
//              lo, hi, ticks, refs, bands }],
// }
// Chaque `vals` a une valeur (ou null) par bougie affichée.
export function drawCandles(box, spec) {
  const W = box.clientWidth;
  const { bars } = spec;
  if (!W || !bars.length) return;
  const n = bars.length;
  const L = 8, R = 74, GAP = 24, TOP = 4, AX = 22;
  const panes = [{ ...spec.price, kind: spec.line ? 'close' : 'candles', series: spec.price.overlays || [] }, ...spec.panes];
  const H = TOP + panes.reduce((s, p) => s + p.h + GAP, 0) - GAP + AX;
  const PW = W - L - R;
  const slot = PW / n;
  const x = i => L + (i + 0.5) * slot;
  const up = b => b[4] >= b[1];
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Graphique : ${panes.map(p => p.title).join(', ')}` });

  const defs = el('defs');
  svg.append(defs);
  let y0 = TOP;
  for (const [k, p] of panes.entries()) {
    const own = p.series.flatMap(s => s.vals).filter(v => v != null && Number.isFinite(v));
    let vals = own;
    if (p.kind === 'candles' || p.kind === 'close') {
      // Les moyennes élargissent l'échelle d'un tiers au plus : au-delà, elles sortent du cadre et les bougies
      // restent lisibles (une moyenne 200 jours très loin du prix écraserait tout).
      const pv = p.kind === 'candles' ? bars.flatMap(b => [b[2], b[3]]) : bars.map(b => b[4]);
      const cLo = Math.min(...pv), cHi = Math.max(...pv), room = (cHi - cLo) * 0.35;
      vals = [cLo, cHi, ...own.concat((p.levels || []).map(l => l.v)).map(v => clamp(v, cLo - room, cHi + room))];
    }
    if (p.kind === 'volume') vals = [0, ...bars.map(b => b[5])];
    if (p.kind === 'bars' || p.kind === 'macd') vals = vals.concat(0);
    let lo = p.lo ?? Math.min(...vals), hi = p.hi ?? Math.max(...vals);
    if (p.lo == null && p.kind !== 'volume') {
      const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.05 || 1;
      lo = p.kind === 'bars' || p.kind === 'macd' ? lo - (lo < 0 ? pad : 0) : Math.max(lo >= 0 ? 0 : -Infinity, lo - pad);
      hi += pad;
    }
    if (p.kind === 'volume') hi *= 1.08;
    const top = y0 + 18, bottom = y0 + p.h;
    const y = v => bottom - ((v - lo) / (hi - lo || 1)) * (bottom - top);
    Object.assign(p, { y, top, bottom, inv: py => lo + ((bottom - py) / (bottom - top)) * (hi - lo) });
    const clip = `cd-clip-${++clipId}-${k}`;
    const cp = el('clipPath', { id: clip });
    cp.append(el('rect', { x: L, y: top - 2, width: PW, height: bottom - top + 4 }));
    defs.append(cp);
    svg.append(el('text', { x: L, y: y0 + 11, class: 'pt' }, p.title));
    for (const [a, b, cls] of p.bands || []) svg.append(el('rect', { x: L, width: PW, y: y(b), height: y(a) - y(b), class: cls }));
    const priced = p.kind === 'candles' || p.kind === 'close';
    const ticks = (p.ticks || niceTicks(lo, hi, priced ? Math.max(3, Math.round(p.h / 60)) : 2)).filter(t => t >= lo && t <= hi);
    // Graduations du prix avec juste les décimales du pas (1,5 et 2 plutôt que 1,500 et 2,000).
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : 0;
    const dec = step > 0 ? (step.toFixed(10).replace(/0+$/, '').split('.')[1] || '').length : 0;
    const tickText = priced && step > 0 ? t => t.toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : p.fmt;
    for (const t of ticks) {
      svg.append(el('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: 'grid' }));
      svg.append(el('text', { x: W - R + 6, y: y(t) + 4, class: 'tick' }, tickText(t)));
    }
    for (const r of p.refs || []) svg.append(el('line', { x1: L, x2: W - R, y1: y(r), y2: y(r), class: 'ref' }));

    if (p.kind === 'candles') {
      // Quatre tracés en tout (mèches et corps, hausse et baisse) : léger même avec des centaines de bougies.
      const bw = Math.max(1, Math.min(slot * 0.7, 14));
      const paths = { wu: '', wd: '', bu: '', bd: '' };
      bars.forEach((b, i) => {
        const cx = Math.round(x(i)) + 0.5, u = up(b);
        paths[u ? 'wu' : 'wd'] += `M${cx},${y(b[2]).toFixed(1)}V${y(b[3]).toFixed(1)}`;
        const t = y(Math.max(b[1], b[4])), h = Math.max(1, y(Math.min(b[1], b[4])) - t);
        paths[u ? 'bu' : 'bd'] += `M${(x(i) - bw / 2).toFixed(1)},${t.toFixed(1)}h${bw.toFixed(1)}v${h.toFixed(1)}h${(-bw).toFixed(1)}Z`;
      });
      svg.append(el('path', { d: paths.wu, class: 'wick up' }), el('path', { d: paths.wd, class: 'wick down' }),
        el('path', { d: paths.bu, class: 'body up' }), el('path', { d: paths.bd, class: 'body down' }));
    }
    if (p.kind === 'close') {
      const d = bars.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(b[4]).toFixed(1)}`).join('');
      svg.append(el('path', { d: `${d}L${x(n - 1).toFixed(1)},${bottom}L${x(0).toFixed(1)},${bottom}Z`, class: 'area' }), el('path', { d, class: 'ln l-price' }));
    }
    if (p.kind === 'volume') {
      // Couleur de la bougie ; en courbe (pas d'ouverture connue), une seule couleur.
      const bw = Math.max(1, slot * 0.7);
      const paths = { up: '', down: '', flat: '' };
      bars.forEach((b, i) => { paths[spec.line ? 'flat' : up(b) ? 'up' : 'down'] += `M${(x(i) - bw / 2).toFixed(1)},${y(b[5]).toFixed(1)}h${bw.toFixed(1)}V${bottom}h${(-bw).toFixed(1)}Z`; });
      svg.append(...Object.entries(paths).filter(([, d]) => d).map(([cls, d]) => el('path', { d, class: `vol ${cls}` })));
    }
    p.series.forEach((s, k) => {
      if ((p.kind === 'bars' && k === 0) || (p.kind === 'macd' && k === 0)) {
        const bw = Math.max(1, slot * 0.7);
        const paths = { u: '', d: '' };
        s.vals.forEach((v, i) => { if (v != null) paths[v >= 0 ? 'u' : 'd'] += `M${(x(i) - bw / 2).toFixed(1)},${Math.min(y(v), y(0)).toFixed(1)}h${bw.toFixed(1)}v${Math.max(1, Math.abs(y(v) - y(0))).toFixed(1)}h${(-bw).toFixed(1)}Z`; });
        svg.append(el('path', { d: paths.u, class: `hist up${p.kind === 'macd' ? ' soft' : ''}` }), el('path', { d: paths.d, class: `hist down${p.kind === 'macd' ? ' soft' : ''}` }),
          el('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'zero' }));
        return;
      }
      // Une courbe s'interrompt là où la valeur manque (début d'une moyenne, jours sans donnée).
      let d = '', pen = false;
      s.vals.forEach((v, i) => {
        if (v == null || !Number.isFinite(v)) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      if (!d) return;
      if (p.kind === 'line' && p.series.length === 1) {
        const first = s.vals.findIndex(v => v != null), last = s.vals.findLastIndex(v => v != null);
        svg.append(el('path', { d: `${d}L${x(last).toFixed(1)},${bottom}L${x(first).toFixed(1)},${bottom}Z`, class: 'area' }));
      }
      svg.append(el('path', { d, class: `ln ${s.cls}`, 'clip-path': `url(#${clip})` }));
    });

    // Niveaux du plan (déclenchement, stop, objectif) : ligne pointillée, nom et prix au-dessus, à gauche.
    for (const lv of p.levels || []) {
      const yy = y(lv.v);
      if (yy < top - 2 || yy > bottom + 2) continue;
      svg.append(el('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: `lvl ${lv.cls || ''}` }),
        el('text', { x: L + 4, y: yy - 4, class: `lvl-t ${lv.cls || ''}` }, `${lv.label} ${p.fmt(lv.v)}`));
    }
    // Signaux passés : flèche sous la bougie (long) ou au-dessus (short).
    for (const m of p.marks || []) {
      const b = bars[m.i];
      if (!b) continue;
      const cx = x(m.i), long = m.dir === 'long';
      const yy = long ? y(b[3]) + 5 : y(b[2]) - 5, s = long ? 1 : -1;
      svg.append(el('path', { d: `M${cx.toFixed(1)},${yy.toFixed(1)}l4.5,${8 * s}h-9Z`, class: `mark ${m.cls || ''}` }));
    }
    // Dernier prix : ligne pointillée et étiquette sur l'axe de droite.
    if (p.kind === 'candles' || p.kind === 'close') {
      const b = bars.at(-1), yy = y(b[4]);
      svg.append(el('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: `last ${up(b) ? 'up' : 'down'}` }),
        el('rect', { x: W - R + 2, y: yy - 8.5, width: R - 4, height: 17, rx: 4, class: `last-pill ${up(b) ? 'up' : 'down'}` }),
        el('text', { x: W - R + 7, y: yy + 3.5, class: 'pill-t last-t' }, p.fmt(b[4])));
    }
    y0 = bottom + GAP;
  }
  // Axe du temps sous le dernier panneau ; les graduations du bord restent dans le cadre.
  for (const [i, label] of spec.ticks || []) {
    const tx = x(i);
    svg.append(el('text', { x: tx, y: H - 6, class: `tick ${tx < L + 24 ? '' : tx > W - R - 24 ? 'end' : 'mid'}` }, label));
  }

  // Croix du survol : ligne verticale sur tous les panneaux, ligne horizontale dans le panneau survolé,
  // valeur sur l'axe de droite, date sur l'axe du bas.
  const cross = el('g', { visibility: 'hidden' });
  const vline = el('line', { y1: TOP, y2: H - AX, class: 'cross' });
  const across = el('g', { visibility: 'hidden' });
  const hline = el('line', { x1: L, x2: W - R, class: 'cross' });
  const yRect = el('rect', { x: W - R + 2, width: R - 4, height: 17, rx: 4, class: 'pill' });
  const yText = el('text', { x: W - R + 7, class: 'pill-t' });
  across.append(hline, yRect, yText);
  const xRect = el('rect', { y: H - AX + 2, height: 17, rx: 4, class: 'pill' });
  const xText = el('text', { y: H - AX + 14.5, class: 'pill-t mid' });
  cross.append(vline, across, xRect, xText);
  const hit = el('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent', tabindex: 0, 'aria-label': 'Survoler le graphique : flèches gauche et droite pour passer d\'une bougie à l\'autre' });
  svg.append(cross, hit);

  const read = document.createElement('div');
  read.className = 'cd-read';
  read.setAttribute('aria-live', 'polite');
  box.replaceChildren(read, svg);

  // Chaque valeur de la ligne garde la largeur de la plus longue de la période (chiffres à chasse fixe) : la ligne
  // ne bouge pas d'une bougie à l'autre, même quand elle tient sur plusieurs lignes (téléphone).
  const P = panes[0];
  const pctText = v => `${v >= 0 ? '+' : ''}${(v * 100).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
  const step = Math.max(1, Math.floor(n / 150));
  const widest = (vals, text) => {
    const ok = vals.filter(v => v != null && Number.isFinite(v));
    if (!ok.length) return 1;
    let w = Math.max(text(Math.min(...ok)).length, text(Math.max(...ok)).length, text(ok.at(-1)).length);
    for (let i = 0; i < ok.length; i += step) w = Math.max(w, text(ok[i]).length);
    return w;
  };
  let wx = spec.label(n - 1).length;
  for (let i = 0; i < n; i += step) wx = Math.max(wx, spec.label(i).length);
  const changes = bars.map((b, i) => (i ? b[4] / bars[i - 1][4] - 1 : null));
  const wPrice = widest(spec.line ? bars.map(b => b[4]) : bars.flatMap(b => [b[2], b[3]]), P.fmt);
  const wPct = widest(changes, pctText);
  for (const p of panes) {
    if (p.kind === 'volume') p.w = widest(bars.map(b => b[5]), p.fmt);
    for (const s of p.series) s.w = widest(s.vals, s.fmt || p.fmt);
  }
  const num = (text, w, cls = '') => `<span class="num${cls}" style="min-width:${w}ch">${esc(text)}</span>`;
  const fill = (i, live) => {
    const b = bars[i];
    read.classList.toggle('live', live);
    const parts = [`<b class="cd-x" style="min-width:${wx}ch">${esc(spec.label(i))}</b>`];
    const ch = changes[i];
    const chTxt = num(ch == null ? '' : pctText(ch), wPct, ch == null ? '' : ch >= 0 ? ' up' : ' down');
    if (spec.line) parts.push(`<span class="cd-v">Clôture ${num(P.fmt(b[4]), wPrice)}${chTxt}</span>`);
    else parts.push(`<span class="cd-v ohlc">${[['Ouv.', 1], ['Haut', 2], ['Bas', 3], ['Clôt.', 4]].map(([k, j]) => `<span class="cd-v">${k} ${num(P.fmt(b[j]), wPrice)}${j === 4 ? chTxt : ''}</span>`).join('')}</span>`);
    for (const p of panes) {
      if (p.kind === 'volume') parts.push(`<span class="cd-v">Vol. ${num(p.fmt(b[5]), p.w)}</span>`);
      for (const s of p.series) {
        const v = s.vals[i];
        parts.push(`<span class="cd-v"><i class="key ${esc(s.cls)}"></i>${esc(s.label)} ${num(v == null ? '—' : (s.fmt || p.fmt)(v), s.w)}</span>`);
      }
    }
    read.innerHTML = parts.join('');
  };
  let cursor = n - 1;
  const show = (i, py) => {
    cursor = i = clamp(i, 0, n - 1);
    const cx = x(i);
    cross.setAttribute('visibility', 'visible');
    vline.setAttribute('x1', cx); vline.setAttribute('x2', cx);
    xText.textContent = spec.label(i);
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
      // L'étiquette tient dans la marge de droite ; une valeur plus longue déborde un peu sur le graphique.
      const yw = Math.max(R - 4, yText.getComputedTextLength() + 10);
      yRect.setAttribute('x', W - 2 - yw); yRect.setAttribute('width', yw);
      yText.setAttribute('x', W - 2 - yw + 5);
      across.setAttribute('visibility', 'inherit');
    } else across.setAttribute('visibility', 'hidden');
    fill(i, true);
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); fill(n - 1, false); };
  const at = e => {
    const r = svg.getBoundingClientRect();
    const k = W / (r.width || W);
    return [Math.floor(((e.clientX - r.left) * k - L) / slot), (e.clientY - r.top) * k];
  };
  hit.addEventListener('pointermove', e => show(...at(e)));
  hit.addEventListener('pointerdown', e => show(...at(e)));
  // Au doigt, la croix reste après avoir levé le doigt pour qu'on puisse lire les valeurs ; elle part si on fait défiler la page.
  hit.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
  hit.addEventListener('pointercancel', hide);
  // Au clavier (touche Tab), la croix part de la dernière bougie ; un clic ou un appui l'a déjà placée.
  hit.addEventListener('focus', () => { if (cross.getAttribute('visibility') !== 'visible') show(cursor); });
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    show(cursor + (e.key === 'ArrowLeft' ? -1 : 1));
  });
  fill(n - 1, false);
}
