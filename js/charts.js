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
