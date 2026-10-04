// Fiche d'un trade (#setup/<id>), en jeu ou terminé : pourquoi il a été pris, le plan chiffré,
// ce qui s'est passé jour par jour et le calcul du résultat, avec le graphique du trade.
import { esc, fmt } from './format.js';
import { drawCandles } from './candles.js';
import { star } from './watchlist.js';
import { loadPaire } from './paire.js';
import { deSym } from './crypto-lib.js';
import { OUTCOME, cap, dirTag, liveOf, newsLink, okxUrl, outcomeTag, plainPct, projectLink, px, setupsData, statusTag } from './setups.js';

const $ = id => document.getElementById(id);
const DAY = 86_400_000, BAR = 4 * 3600_000;
const num = n => n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
const row = (k, v, cls = '') => `<dt>${k}</dt><dd class="${cls}">${v}</dd>`;
const when = t => new Date(t).toLocaleString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
const dayOf = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const rText = r => `${r > 0 ? '+' : r < 0 ? '−' : ''}${num(Math.abs(Math.round(r * 100) / 100))}R`;
let current = null;

// Le trade : celui en jeu (détail complet) ou un trade terminé de l'historique.
function find(id) {
  const data = setupsData();
  return data?.live.find(x => x.id === id) || data?.history.find(x => x.id === id) || null;
}

export async function renderSetup(id) {
  const el = $('setup-detail');
  const s = find(id);
  if (!s) {
    el.innerHTML = '<div class="box"><div class="empty">Ce trade n\'est plus dans l\'historique (il a plus d\'un an). Les autres trades sont dans l\'<a href="#historique">historique</a>.</div></div>';
    return;
  }
  current = { s, d: null };
  el.innerHTML = page(s);
  try {
    const d = await loadPaire(s.symbol);
    if (current?.s !== s) return;
    current.d = d;
    chart();
  } catch {
    const box = $('tr-chart');
    if (box) box.innerHTML = '<div class="empty">Graphique indisponible pour le moment.</div>';
  }
}

function page(s) {
  const data = setupsData();
  const a = data.assets.find(x => x.symbol === s.symbol) || { symbol: s.symbol, name: s.symbol };
  const open = s.outcome === 'open';
  return `
    <div class="ph"><h1>${esc(s.symbol)} · ${esc(data.detectors[s.detector])}</h1>${dirTag(s.dir)}${s.status === 'en cours' ? statusTag(s) : ''}${outcomeTag(s)}${open && s.status === 'confirmé' ? '<span class="tag acc">En jeu</span>' : ''}${star(s.symbol, { text: true })}</div>
    <p class="sub">${esc(a.name)} · perpétuel OKX · bougie 4h du ${when(s.time)} (heure de Paris)</p>
    <div class="nfa">⚠ Ceci n'est pas un conseil financier. Fais tes propres recherches avant tout investissement.</div>
    <div class="box tr-brief"><h2>En bref</h2><p class="txt">${brief(s, a)}</p></div>
    <div class="box mk cx-box"><h2>Le trade sur le graphique</h2>
      <div class="cx-chart" id="tr-chart"><div class="empty">Chargement du graphique…</div></div>
      <p class="fine pa-legend">Flèche : l'entrée. Ronds : la moitié prise et la sortie du reste. Pointillés : entrée, stop de départ et objectif de la moitié.</p></div>
    <div class="detail tr-detail">
      <div class="stack">
        ${whyBox(s, a)}
        ${planBox(s)}
      </div>
      <div class="stack">
        ${storyBox(s, a)}
        ${resultBox(s, a)}
        <div class="box"><h2>Liens</h2><div class="links">
          <a class="chip" href="#paire/${encodeURIComponent(s.symbol)}">Fiche ${esc(s.symbol)} →</a>
          <a class="buy" href="${okxUrl(s.symbol)}" target="_blank" rel="noopener">Ouvrir sur OKX</a>
          <a class="chip" href="#historique">Tous les trades →</a></div>
          ${projectLink(s.symbol)}${open ? newsLink(s) : ''}</div>
      </div>
    </div>`;
}

const tpOf = s => s.tp?.[0] ?? s.tp1;
const side = s => (s.dir === 'long' ? 1 : -1);

// Le résultat du moment pour un trade en jeu, en R.
function liveR(s, a) {
  const move = side(s) * (a.price - s.entry) / Math.abs(s.entry - s.sl);
  return s.tpHit ? ((setupsData().rules.partialR ?? 5) + move) / 2 : move;
}

function brief(s, a) {
  const what = `${s.dir === 'long' ? 'Achat (long)' : 'Vente à découvert (short)'} ${deSym(esc(s.symbol))} à <b>${px(s.entry)}</b> le ${dayOf(s.time)}`;
  if (s.status === 'en cours') return `${what}, si la bougie 4h en cours ferme comme maintenant. Le signal peut encore disparaître à la clôture.`;
  if (s.outcome === 'open') return `${what}. Le trade est toujours en jeu : en ce moment <b class="${liveR(s, a) >= 0 ? 'up' : 'down'}">${cap(liveR(s, a))}</b> du capital.`;
  const days = Math.max(1, Math.round((s.at - s.time) / DAY));
  return `${what}, terminé le ${dayOf(s.at)} après ${days} jour${days > 1 ? 's' : ''} : ${esc(OUTCOME[s.outcome][0].toLowerCase())}, <b class="${s.r > 0 ? 'up' : s.r < 0 ? 'down' : ''}">${cap(s.r)}</b> du capital.`;
}

// 1. Pourquoi : les 4 conditions du signal, avec les chiffres de ce jour-là.
function whyBox(s, a) {
  const data = setupsData();
  const up = s.dir === 'long';
  const d = s.day;
  const trend = d ? `La journée du ${dayOf(d.t)} a clôturé à ${px(d.c)}, ${up ? 'au-dessus' : 'en dessous'} de la moyenne 50 jours (${px(d.e50)}), et la moyenne 20 jours (${px(d.e20)}) était ${up ? 'au-dessus' : 'en dessous'} de la 50. La tendance était donc <b>${up ? 'haussière' : 'baissière'}</b> : on ne cherchait que des ${up ? 'longs' : 'shorts'}.`
    : `La clôture et la moyenne 20 jours étaient ${up ? 'au-dessus' : 'en dessous'} de la moyenne 50 jours : tendance <b>${esc(s.trend || (up ? 'haussière' : 'baissière'))}</b>, on ne cherchait que des ${up ? 'longs' : 'shorts'}.`;
  const word = up ? 'au-dessus du plus haut' : 'sous le plus bas';
  const gap = s.ref ? ` La clôture (${px(s.entry)}) dépasse ce niveau de ${fmt(Math.abs(s.entry / s.ref - 1) * 100, 1)} %.` : '';
  const trigger = {
    range20: `La bougie 4h a clôturé ${word} des 20 derniers jours${s.ref ? ` (${px(s.ref)})` : ''} : le prix sort ${up ? 'par le haut' : 'par le bas'} de sa zone du mois.${gap}`,
    range10: `La bougie 4h a clôturé ${word} des 60 dernières bougies 4h, soit 10 jours${s.ref ? ` (${px(s.ref)})` : ''} : ${up ? 'les acheteurs' : 'les vendeurs'} reprennent la main.${gap}`,
    macd: `L'histogramme du MACD 4h (12, 26, 9) est repassé ${up ? 'au-dessus' : 'en dessous'} de zéro : après un repli, l'élan repart dans le sens de la tendance.`,
  }[s.detector] || esc(s.why || '');
  const room = s.atr4h ? `Aucun niveau important (plus ${up ? 'haut' : 'bas'} récent, chiffre rond, zone de gros volume) à moins de ${px(s.atr4h * 2 * (data.rules.roomAtr ?? 1.5))} de l'entrée (2 × ${num(data.rules.roomAtr ?? 1.5)} ATR 4h) : le prix avait de la place pour ${up ? 'monter' : 'baisser'}.`
    : `Aucun niveau important à moins de 2 × ${num(data.rules.roomAtr ?? 1.5)} ATR 4h de l'entrée : le prix avait de la place.`;
  const li = (title, text) => `<li><span class="pa-ck yes" aria-hidden="true">✓</span><div><b>${title}</b><span>${text}</span></div></li>`;
  return `<div class="box"><h2>1. Pourquoi ce trade</h2><ol class="pa-rules">
    ${li('La tendance de fond', trend)}
    ${li(`Le déclencheur : ${esc(data.detectors[s.detector])}`, trigger)}
    ${li('De la place devant', room)}
    ${li(`Pas d'autre trade sur ${esc(s.symbol)}`, 'Un seul trade à la fois par paire : la paire était libre.')}
  </ol></div>`;
}

// 2. Le plan : chaque prix et d'où il vient.
function planBox(s) {
  const data = setupsData();
  const risk = data.rules.riskPct ?? 1, P = data.rules.partialR ?? 5;
  const stopPct = Math.abs(s.sl - s.entry) / s.entry;
  const size = risk / 100 / stopPct; // part du capital mise en position pour perdre 1 % au stop
  const tp = tpOf(s);
  const atr = s.atr ?? Math.abs(s.entry - s.sl) / data.rules.stopAtr;
  const up = s.dir === 'long';
  return `<div class="box"><h2>2. Le plan</h2><dl>
    ${row('Entrée', `${px(s.entry)} <small class="muted">clôture de la bougie 4h du signal</small>`)}
    ${row('Stop de départ', `${px(s.sl)} <small class="muted">${plainPct((s.sl - s.entry) / s.entry)} · ${num(data.rules.stopAtr)} × ATR jour (${px(atr)})</small>`, 'down')}
    ${row('Risque', `${fmt(risk, 0)} % du capital si le stop est touché`, 'txt')}
    ${row('Taille de la position', `${fmt(size * 100, 0)} % du capital <small class="muted">${fmt(risk, 0)} % ÷ ${fmt(stopPct * 100, 1)} % d'écart au stop</small>`)}
    ${row(`Moitié à ${fmt(P, 0)}R`, `${px(tp)} <small class="muted">${plainPct((tp - s.entry) / s.entry)} · ${fmt(P, 0)} fois l'écart au stop</small>`, 'up')}
    ${row('Reste', `gardé jusqu'à une clôture journalière ${up ? 'sous le plus bas' : 'au-dessus du plus haut'} des ${data.rules.exitDays ?? 7} derniers jours`, 'txt')}
  </dl><p class="txt muted">Exemple avec 1 000 $ : position de ${fmt(size * 1000, 0)} $ ; au stop, la perte est de ${fmt(risk * 10, 0)} $.</p></div>`;
}

// 3. Ce qui s'est passé, étape par étape.
function storyBox(s, a) {
  const data = setupsData();
  const P = data.rules.partialR ?? 5, risk = data.rules.riskPct ?? 1;
  const up = s.dir === 'long';
  const steps = [[s.time + BAR, `Entrée à <b>${px(s.entry)}</b> à la clôture de la bougie 4h, stop à ${px(s.sl)}.`]];
  if (s.halfAt) steps.push([s.halfAt, `Le prix atteint ${px(tpOf(s))} (${fmt(P, 0)}R) : la moitié est vendue, soit <b class="up">+${fmt(P * risk / 2, 1)} %</b> du capital déjà gagné. Le stop remonte au prix d'entrée : le reste ne peut plus faire perdre.`]);
  else if (s.tpHit && !s.halfAt) steps.push([null, `Le prix atteint ${px(tpOf(s))} (${fmt(P, 0)}R) : la moitié est vendue et le stop remonte au prix d'entrée.`]);
  if (s.outcome === 'sl') steps.push([s.at, `Le prix ${up ? 'redescend' : 'remonte'} jusqu'au stop ${px(s.sl)} avant d'atteindre ${fmt(P, 0)}R : le trade est coupé, <b class="down">${cap(-1)}</b> du capital, la perte prévue.`]);
  if (s.outcome === 'be') steps.push([s.at, `Le prix revient au prix d'entrée (${px(s.entry)}) : le reste sort sans gain ni perte.`]);
  if (s.outcome === 'exit') {
    const restR = s.tpHit ? 2 * s.r - P : s.r;
    steps.push([s.at + BAR, `La journée clôture à ${px(s.exitPx ?? s.entry)}, ${up ? 'sous le plus bas' : 'au-dessus du plus haut'} des ${data.rules.exitDays ?? 7} derniers jours${s.exitLvl ? ` (${px(s.exitLvl)})` : ''} : la tendance s'essouffle, ${s.tpHit ? 'le reste est vendu' : 'tout est vendu'} à ${rText(restR)}.`]);
  }
  if (s.outcome === 'open' && s.status === 'confirmé') {
    const live = liveOf(s.symbol);
    steps.push([Date.now(), `Toujours en jeu : prix ${px(a.price)}, stop ${px(live?.stop ?? s.stop ?? s.sl)}${live?.exitAt ? `, sortie si une journée clôture ${up ? 'sous' : 'au-dessus de'} ${px(live.exitAt)}` : ''}.`]);
  }
  return `<div class="box"><h2>3. Ce qui s'est passé</h2><ol class="tr-steps">${steps.map(([t, text]) => `<li><span class="muted">${t ? when(t) : ''}</span><span>${text}</span></li>`).join('')}</ol></div>`;
}

// 4. Le résultat et son calcul.
function resultBox(s, a) {
  const data = setupsData();
  const P = data.rules.partialR ?? 5, risk = data.rules.riskPct ?? 1;
  if (s.status === 'en cours') return '';
  const open = s.outcome === 'open';
  const r = open ? liveR(s, a) : s.r;
  let how;
  if (open) how = s.tpHit ? `Moitié vendue à ${fmt(P, 0)}R, l'autre moitié vaut ${rText(2 * r - P)} en ce moment : (${fmt(P, 0)}R ${2 * r - P >= 0 ? '+' : '−'} ${num(Math.abs(Math.round((2 * r - P) * 100) / 100))}R) ÷ 2 = ${rText(r)}.` : `Le prix est à ${rText(r)} de l'entrée : ${rText(r)} × ${fmt(risk, 0)} % = ${cap(r)}.`;
  else if (s.outcome === 'sl') how = `Stop touché avant ${fmt(P, 0)}R : on perd exactement le risque prévu, ${fmt(risk, 0)} % du capital.`;
  else if (s.outcome === 'be') how = `Moitié vendue à ${fmt(P, 0)}R, l'autre moitié sortie à 0R : (${fmt(P, 0)}R + 0R) ÷ 2 = ${rText(s.r)}, soit ${cap(s.r)}.`;
  else {
    const rest = s.tpHit ? 2 * s.r - P : s.r;
    how = s.tpHit ? `Moitié vendue à ${fmt(P, 0)}R, l'autre moitié à ${rText(rest)} : (${fmt(P, 0)}R ${rest >= 0 ? '+' : '−'} ${num(Math.abs(Math.round(rest * 100) / 100))}R) ÷ 2 = ${rText(s.r)}, soit ${cap(s.r)}.`
      : `Tout est vendu à ${rText(s.r)} : ${rText(s.r)} × ${fmt(risk, 0)} % = ${cap(s.r)}.`;
  }
  return `<div class="box"><h2>4. ${open ? 'Résultat en ce moment' : 'Résultat'}</h2>
    <p class="tr-big ${r > 0 ? 'up' : r < 0 ? 'down' : ''}">${cap(r)} <small class="muted">du capital</small></p>
    <p class="txt">${how}</p>
    <p class="txt muted">1R = l'écart entre l'entrée et le stop = ${fmt(risk, 0)} % du capital. Environ 2 trades sur 3 finissent au stop : ce sont les gros gains des trades qui tiennent la tendance qui paient ces petites pertes.</p></div>`;
}

// Graphique du trade : bougies 4h autour du trade (journalières s'il est trop ancien), niveaux du plan.
function chart() {
  const box = $('tr-chart');
  if (!box || !current?.d) return;
  const { s, d } = current;
  const W = box.clientWidth;
  if (!W) return;
  const h4 = d.h4.length && d.h4[0][0] <= s.time - 20 * BAR;
  const base = h4 ? d.h4 : d.d1;
  const unit = h4 ? BAR : DAY;
  const at = t => base.findIndex(b => b[0] <= t && t < b[0] + unit);
  const i0 = at(s.time), i1 = s.at ? at(s.at) : base.length - 1;
  if (i0 < 0) { box.innerHTML = '<div class="empty">Graphique indisponible pour ce trade.</div>'; return; }
  const span = Math.max(1, i1 - i0);
  const pad = Math.max(h4 ? 30 : 15, Math.round(span * 0.6));
  const from = Math.max(0, i0 - pad), to = Math.min(base.length, Math.max(i1, i0) + Math.round(pad / 2) + 1);
  const bars = base.slice(from, to);
  const rel = i => i - from;
  const levels = [{ v: s.entry, label: 'Entrée', cls: 'fg' }, { v: s.sl, label: 'Stop', cls: 'down' }, { v: tpOf(s), label: 'Moitié', cls: 'up' }];
  const marks = [{ i: rel(i0), dir: s.dir, cls: 'acc' }];
  if (s.halfAt) { const k = at(s.halfAt); if (k >= 0) marks.push({ i: rel(k), v: tpOf(s), cls: 'up' }); }
  if (s.at) {
    const k = at(s.at);
    const v = s.exitPx ?? (s.outcome === 'sl' ? s.sl : s.entry);
    if (k >= 0) marks.push({ i: rel(k), v, cls: s.r > 0 ? 'up' : s.r < 0 ? 'down' : 'mute' });
  }
  const label = i => new Date(bars[i][0]).toLocaleString('fr-FR', h4
    ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }
    : { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
  const key = t => (h4 ? Math.floor(t / DAY) : new Date(t).toISOString().slice(0, 7));
  const ticksAt = [];
  bars.forEach((b, i) => { if (i && key(b[0]) !== key(bars[i - 1][0])) ticksAt.push(i); });
  const every = Math.ceil(ticksAt.length / Math.max(2, Math.floor((W - 82) / 64)));
  const ticks = ticksAt.filter((_, j) => j % every === 0).map(i => [i, new Date(bars[i][0]).toLocaleDateString('fr-FR', h4 ? { day: 'numeric', month: 'short', timeZone: 'UTC' } : { month: 'short', timeZone: 'UTC' })]);
  drawCandles(box, {
    bars, label, ticks,
    price: { title: `${s.symbol} en dollars · bougies ${h4 ? '4 h' : 'journalières'}${s.at ? '' : ' · jusqu\'à maintenant'}`, h: W < 600 ? 260 : 320, fmt: px, levels, marks },
    panes: [],
  });
}

let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if ($('page-setup')?.classList.contains('on')) chart(); }, 150); });
// Lignes des tableaux de trades (Historique, fiche paire) : un clic ouvre la fiche du trade.
document.addEventListener('click', e => {
  const tr = e.target.closest('tr[data-trade]');
  if (tr && !e.target.closest('a, button')) location.hash = `setup/${encodeURIComponent(tr.dataset.trade)}`;
});
