// Petits graphiques : sparkline SVG pour le tableau, histogramme canvas pour la fiche.
import { money } from './format.js';

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Courbe des revenus (moyenne glissante 7 jours pour lisser le bruit quotidien).
export function sparkline(series) {
  if (!series?.length) return '<span class="muted">—</span>';
  const smooth = movingAvg(series, 7).slice(6);
  const step = Math.max(1, Math.floor(smooth.length / 40));
  const pts = smooth.filter((_, i) => i % step === 0 || i === smooth.length - 1);
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
  const xy = pts.map((v, i) => [1 + (i / (pts.length - 1 || 1)) * 86, 21 - ((v - lo) / span) * 18]);
  const line = xy.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  const [lx, ly] = xy[xy.length - 1];
  const up = pts[pts.length - 1] >= pts[0];
  const color = up ? 'var(--up)' : 'var(--down)';
  return `<svg class="sp" viewBox="0 0 90 24" aria-hidden="true"><polygon points="1,23 ${line} ${lx.toFixed(1)},23" fill="${color}" opacity=".12"/><polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.3"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2" fill="${color}"/></svg>`;
}

export function movingAvg(a, n) {
  return a.map((_, i) => {
    const w = a.slice(Math.max(0, i - n + 1), i + 1);
    return w.reduce((s, v) => s + v, 0) / w.length;
  });
}

// Revenus quotidiens (barres) + moyenne 7 jours (ligne), avec axes.
export function revenueChart(canvas, series, startIso) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const W = rect.width, H = rect.height, L = 56, B = 22, T = 8, R = 8;
  const avg = movingAvg(series, 7);
  const hi = Math.max(...series, 1) * 1.08;
  const y = v => T + (1 - v / hi) * (H - T - B);
  const bw = (W - L - R) / series.length;
  const font = getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace';
  g.font = `11px ${font}`;
  g.fillStyle = css('--muted');
  g.strokeStyle = css('--line');
  g.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const v = (hi / 4) * k, yy = Math.round(y(v)) + 0.5;
    g.beginPath(); g.moveTo(L, yy); g.lineTo(W - R, yy); g.stroke();
    g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillText(money(v), L - 8, yy);
  }
  g.fillStyle = css('--accent-soft');
  series.forEach((v, i) => g.fillRect(L + i * bw + 0.5, y(v), Math.max(1, bw - 1), y(0) - y(v)));
  g.strokeStyle = css('--accent');
  g.lineWidth = 1.6;
  g.beginPath();
  avg.forEach((v, i) => { const x = L + (i + 0.5) * bw; i ? g.lineTo(x, y(v)) : g.moveTo(x, y(v)); });
  g.stroke();
  if (startIso) {
    g.fillStyle = css('--muted');
    g.textBaseline = 'top';
    const start = new Date(startIso);
    [0, Math.floor(series.length / 2), series.length - 1].forEach((i, k) => {
      const d = new Date(start.getTime() + i * 86_400_000);
      g.textAlign = ['left', 'center', 'right'][k];
      g.fillText(d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }), L + (i + 0.5) * bw, H - B + 6);
    });
  }
}

// Bougies avec les lignes du plan (entrée, stop, objectifs, niveau de sortie) et la bougie du signal surlignée.
export function candleChart(canvas, rows, plan) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const font = getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace';
  g.font = `11px ${font}`;
  const fmtV = v => { const a = Math.abs(v); const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : Math.min(8, 3 - Math.floor(Math.log10(a))); return v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }); };
  const labelW = Math.max(...[plan.entry, plan.sl, ...plan.tp, plan.exit ?? plan.entry].map(v => g.measureText(`Entrée ${fmtV(v)}`).width));
  const W = rect.width, H = rect.height, L = 8, R = Math.ceil(labelW) + 14, T = 10, B = 22;
  const bars = rows.slice(-Math.max(30, Math.min(rows.length, Math.floor((W - L - R) / 7))));
  const lines = [
    [plan.entry, css('--fg'), 'Entrée'],
    [plan.sl, css('--down'), 'Stop'],
    ...plan.tp.map((t, k) => [t, css('--up'), plan.tpNames?.[k] ?? `TP${k + 1}`]),
    ...(plan.exit ? [[plan.exit, css('--muted'), 'Sortie']] : []),
  ];
  const values = [...bars.flatMap(b => [b[2], b[3]]), ...lines.map(l => l[0])];
  let lo = Math.min(...values), hi = Math.max(...values);
  const pad = (hi - lo) * 0.04 || 1;
  lo -= pad; hi += pad;
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const bw = (W - L - R) / bars.length;
  const k = bars.findIndex(b => b[0] === plan.time);
  if (k >= 0) {
    g.fillStyle = css('--accent-soft');
    g.fillRect(L + k * bw, T, bw, H - T - B);
  }
  bars.forEach(([, o, h, l, c], i) => {
    const x = L + i * bw + bw / 2;
    g.strokeStyle = g.fillStyle = c >= o ? css('--up') : css('--down');
    g.beginPath(); g.moveTo(Math.round(x) + 0.5, y(h)); g.lineTo(Math.round(x) + 0.5, y(l)); g.stroke();
    const top = y(Math.max(o, c)), bot = y(Math.min(o, c));
    g.fillRect(x - Math.max(1, bw * 0.35), top, Math.max(2, bw * 0.7), Math.max(1, bot - top));
  });
  g.setLineDash([4, 3]);
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  // Étiquettes à droite, écartées d'au moins 13 px pour rester lisibles.
  const tags = lines.map(([v, color, label]) => ({ yy: Math.round(y(v)) + 0.5, color, text: `${label} ${fmtV(v)}` })).sort((a, b) => a.yy - b.yy);
  tags.forEach((t, i) => { t.ty = i ? Math.max(t.yy, tags[i - 1].ty + 13) : t.yy; });
  for (const t of tags) {
    g.strokeStyle = t.color;
    g.beginPath(); g.moveTo(L + Math.max(0, k) * bw, t.yy); g.lineTo(W - R + 4, t.yy); g.stroke();
    g.fillStyle = t.color;
    g.fillText(t.text, W - R + 8, t.ty);
  }
  g.setLineDash([]);
  g.fillStyle = css('--muted');
  g.textBaseline = 'top';
  [0, Math.floor(bars.length / 2), bars.length - 1].forEach((i, n) => {
    g.textAlign = ['left', 'center', 'right'][n];
    g.fillText(new Date(bars[i][0]).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' }), L + (i + 0.5) * bw, H - B + 6);
  });
}
