// Catégorie Indicateurs : graphique des jambes. Bougies de la paire choisie, dans l'unité de temps choisie
// (4 h, jour ou semaine), avec les moyennes 9 et 21, le fond vert ou rouge selon la jambe, une flèche au début
// de chaque jambe et un rond sur chaque creux et chaque sommet.
import { drawCandles } from './candles.js';
import { fmt } from './format.js';
import { LEG, LEG_TESTS, legsOf, toWeeks } from './legs-lib.js';

const DAY = 86_400_000;
export const TF = [
  { key: 'h4', label: '4 h', show: 360, title: 'bougies de 4 h' },
  { key: 'd1', label: 'Jour', show: 365, title: 'bougies journalières' },
  { key: 'w1', label: 'Semaine', show: 120, title: 'bougies hebdomadaires' },
];
const cache = new Map();
const px = n => {
  const a = Math.abs(n);
  return fmt(n, a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 4);
};
const pct = x => `${x > 0 ? '+' : x < 0 ? '−' : ''}${fmt(Math.abs(x) * 100, 0)} %`;

const h4Big = key => (key === 'h4' ? 0.08 : 0.15);

async function load(sym) {
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < 600_000) return hit.d;
  const res = await fetch(`data/paire/${encodeURIComponent(sym)}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(String(res.status));
  const raw = await res.json();
  const obj = r => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], closed: r[6] !== 0 });
  const d1 = raw.d1.map(obj).filter(b => b.closed);
  const d = { h4: raw.h4.map(obj).filter(b => b.closed), d1, w1: toWeeks(d1) };
  // La semaine en cours n'est pas finie : on ne garde que les semaines complètes.
  if (d.w1.length && d.w1.at(-1).t + 7 * DAY > d1.at(-1).t + DAY) d.w1.pop();
  cache.set(sym, { at: Date.now(), d });
  return d;
}

// Texte sous le graphique : ce que la méthode a donné dans les tests, pour cette unité de temps.
export function tfNote(key) {
  const s = LEG_TESTS[key];
  return `Testé sur BTC, ETH et SOL depuis 2023, en ${TF.find(t => t.key === key).title} : entrée en moyenne ${pct(s.entry)} au-dessus du creux, sortie ${pct(-s.exit).replace('+', '')} sous le sommet, ${s.switches < 2 ? '1 à 2 changements' : `environ ${fmt(s.switches, 0)} changements`} de sens par an. `
    + `Gain en restant dans les jambes haussières : ${pct(s.gain[0])} en 2023-2024, ${pct(s.gain[1])} en 2025-2026 (garder la crypto : ${pct(s.hold[0])} puis ${pct(s.hold[1])}).`
    + (key === 'd1' ? ' C\'est l\'unité la plus régulière des trois.' : key === 'h4' ? ' Beaucoup de faux départs : à réserver aux mouvements courts.' : ' Très peu de signaux, mais on entre et on sort tard.');
}

export async function drawLegChart(box, sym, key) {
  let d;
  try { d = await load(sym); } catch {
    box.innerHTML = '<div class="empty">Graphique indisponible pour le moment.</div>';
    return;
  }
  const tf = TF.find(t => t.key === key) || TF[1];
  const all = d[tf.key];
  const r = legsOf(all);
  if (!r) { box.innerHTML = '<div class="empty">Pas assez d\'historique pour cette unité de temps.</div>'; return; }
  const from = Math.max(LEG.slow, all.length - tf.show);
  const bars = all.slice(from).map(b => [b.t, b.o, b.h, b.l, b.c, b.v]);
  const W = box.clientWidth;
  if (!W) return;
  const legs = r.legs.filter(l => l.to >= from);
  const zones = legs.map(l => ({ from: Math.max(0, l.from - from), to: l.to - from, cls: l.dir }));
  const marks = [];
  for (const l of legs) {
    if (l.from >= from) marks.push({ i: l.from - from, dir: l.dir === 'up' ? 'long' : 'short', cls: l.dir });
  }
  // Creux et sommets : un rond sur l'extrême de chaque jambe. Le prix n'est écrit que pour les vrais retournements
  // (au moins 8 % en 4 h, 15 % sinon, depuis l'extrême d'avant), et jamais trop près d'une autre étiquette.
  const ext = legs.filter(l => l.ext.i >= from);
  const big = h4Big(tf.key);
  const placed = { up: [], down: [] }; // sommets au-dessus, creux en dessous : chacun sa rangée
  const slot = (W - 82) / bars.length;
  // Du plus récent au plus ancien : les derniers creux et sommets ont la priorité sur la place.
  ext.map((l, k) => [l, k]).reverse().forEach(([l, k]) => {
    const prev = k ? ext[k - 1].ext.price : null;
    const swing = prev ? Math.abs(l.ext.price / prev - 1) : 0;
    const xi = (l.ext.i - from) * slot;
    const show = (swing >= big || k === ext.length - 1) && !placed[l.dir].some(q => Math.abs(q - xi) < 70);
    if (show) placed[l.dir].push(xi);
    marks.push({ i: l.ext.i - from, v: l.ext.price, cls: l.dir === 'up' ? 'top' : 'bottom', below: l.dir !== 'up',
      label: show ? `${l.dir === 'up' ? 'Sommet' : 'Creux'} ${px(l.ext.price)}` : null });
  });
  const h4 = tf.key === 'h4';
  const label = i => new Date(bars[i][0]).toLocaleString('fr-FR', h4
    ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }
    : { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
  const key2 = t => (h4 ? Math.floor(t / DAY / 7) : new Date(t).toISOString().slice(0, tf.key === 'w1' ? 4 : 7));
  const idx = [];
  bars.forEach((b, i) => { if (i && key2(b[0]) !== key2(bars[i - 1][0])) idx.push(i); });
  const every = Math.ceil(idx.length / Math.max(2, Math.floor((W - 82) / 64)));
  const ticks = idx.filter((_, j) => j % every === 0).map(i => [i, new Date(bars[i][0]).toLocaleDateString('fr-FR',
    tf.key === 'w1' ? { year: 'numeric', timeZone: 'UTC' } : h4 ? { day: 'numeric', month: 'short', timeZone: 'UTC' } : { month: 'short', timeZone: 'UTC' })]);
  drawCandles(box, {
    bars, label, ticks,
    price: {
      title: `${sym} en dollars · ${tf.title}`, h: W < 600 ? 300 : 400, fmt: px, zones, marks,
      overlays: [
        { key: 'f', label: `Moy. ${LEG.fast}`, cls: 'l-ma20', vals: r.fast.slice(from) },
        { key: 's', label: `Moy. ${LEG.slow}`, cls: 'l-ma50', vals: r.slow.slice(from) },
      ],
    },
    panes: [],
  });
}
