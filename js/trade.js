// Fiche d'un trade (#setup/<id>), en jeu ou terminé : pourquoi il a été pris, le plan chiffré,
// ce qui s'est passé jour par jour et le calcul du résultat, avec le graphique du trade.
import { esc, fmt } from './format.js';
import { drawCandles } from './candles.js';
import { star } from './watchlist.js';
import { loadPaire } from './paire.js';
import { deSym } from './crypto-lib.js';
import { delayed, hoursText, premiumBox, tooOld, visibleIn } from './premium.js';
import { OUTCOME, cap, dirTag, liveOf, newsLink, okxUrl, outcomeTag, plainPct, projectLink, px, setupsData, statusTag } from './setups.js';

const $ = id => document.getElementById(id);
const DAY = 86_400_000, BAR = 4 * 3600_000;
const row = (k, v, cls = '') => `<dt>${k}</dt><dd class="${cls}">${v}</dd>`;
const when = t => new Date(t).toLocaleString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
const dayOf = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
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
  // Sans Premium : signaux récents sur SOL et le pétrole cachés 24 h, trades de plus de 3 mois fermés.
  if (delayed(s) || tooOld(s)) {
    current = null;
    el.innerHTML = `<div class="ph"><h1>${esc(s.symbol)} · trade ${delayed(s) ? 'tout récent' : `du ${dayOf(s.time)}`}</h1></div>
      ${premiumBox(delayed(s) ? `Ce signal sera visible pour tout le monde dans ${hoursText(visibleIn(s))}. Avec Premium, tu le vois tout de suite, avec le prix d'entrée et le stop.`
        : 'Ce trade a plus de 3 mois. Avec Premium, tu retrouves toutes les fiches trade des 12 derniers mois.')}
      <div class="links"><a class="chip" href="#paire/${encodeURIComponent(s.symbol)}">Fiche ${esc(s.symbol)} →</a><a class="chip" href="#historique">Trades des 3 derniers mois →</a></div>`;
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
      <p class="fine pa-legend">La flèche montre l'entrée, les ronds la vente de la moitié et la sortie. Les pointillés montrent l'entrée, le stop et l'objectif.</p></div>
    <div class="detail tr-detail">
      <div class="stack">
        ${whyBox(s)}
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

// 1. Pourquoi : les 4 conditions du signal, dites simplement, avec les chiffres de ce jour-là.
function whyBox(s) {
  const up = s.dir === 'long';
  const d = s.day;
  const li = (title, text, small = '') => `<li><span class="pa-ck yes" aria-hidden="true">✓</span><div><b>${title}</b><span>${text}</span>${small ? `<small class="muted">${small}</small>` : ''}</div></li>`;
  const trend = d
    ? `Le ${dayOf(d.t)}, le prix clôturait à ${px(d.c)}, ${up ? 'au-dessus' : 'en dessous'} de sa moyenne des 50 derniers jours (${px(d.e50)}). Le marché ${up ? 'montait' : 'baissait'} : on ne prend que des ${up ? 'achats' : 'ventes'} dans ce cas.`
    : `Le prix était ${up ? 'au-dessus' : 'en dessous'} de sa moyenne des 50 derniers jours : le marché ${up ? 'montait' : 'baissait'}.`;
  const trendSmall = d ? `Règle exacte : clôture et moyenne 20 jours (${px(d.e20)}) ${up ? 'au-dessus' : 'en dessous'} de la moyenne 50 jours.` : '';
  const lvl = s.ref ? ` (${px(s.ref)})` : '';
  const trigger = {
    range20: `Le prix est passé ${up ? 'au-dessus de son plus haut' : 'sous son plus bas'} du dernier mois${lvl} : il sort de sa zone ${up ? 'par le haut' : 'par le bas'}.`,
    range10: `Le prix est passé ${up ? 'au-dessus de son plus haut' : 'sous son plus bas'} des 10 derniers jours${lvl} : ${up ? 'les acheteurs' : 'les vendeurs'} reprennent la main.`,
    macd: `Après une petite ${up ? 'baisse' : 'hausse'}, le prix repart ${up ? 'à la hausse' : 'à la baisse'}, dans le sens du marché.`,
  }[s.detector] || esc(s.why || '');
  const triggerSmall = s.detector === 'macd' ? 'Repéré avec l\'indicateur MACD sur les bougies de 4 heures, qui repasse de l\'autre côté de zéro.' : 'Une bougie de 4 heures a clôturé au-delà de ce niveau.';
  return `<div class="box"><h2>1. Pourquoi ce trade</h2><ol class="pa-rules">
    ${li(`Le marché ${up ? 'montait' : 'baissait'}`, trend, trendSmall)}
    ${li('Le signal', trigger, triggerSmall)}
    ${li('Pas d\'obstacle proche', `Aucun ancien ${up ? 'sommet' : 'creux'} ni chiffre rond juste ${up ? 'au-dessus' : 'en dessous'} : le prix avait de la place pour ${up ? 'monter' : 'baisser'}.`)}
    ${li('Un seul trade à la fois', `Aucun autre trade n'était ouvert sur ${esc(s.symbol)}.`)}
  </ol></div>`;
}

// Gain ou perte en % du capital (1R = le risque, 1 % du capital par défaut).
const capOf = r => cap(r);

// 2. Le plan : chaque prix et à quoi il sert.
function planBox(s) {
  const data = setupsData();
  const risk = data.rules.riskPct ?? 1, P = data.rules.partialR ?? 5;
  const stopPct = Math.abs(s.sl - s.entry) / s.entry;
  const size = risk / 100 / stopPct; // part du capital mise en position pour perdre 1 % au stop
  const tp = tpOf(s);
  const up = s.dir === 'long';
  return `<div class="box"><h2>2. Le plan</h2><dl>
    ${row('Entrée', `${px(s.entry)} <small class="muted">le prix au moment du signal</small>`)}
    ${row('Stop', `${px(s.sl)} <small class="muted">${plainPct((s.sl - s.entry) / s.entry)} : si le prix ${up ? 'descend' : 'monte'} jusque-là, on coupe</small>`, 'down')}
    ${row('Perte maximale', `${fmt(risk, 0)} % du capital`, 'txt')}
    ${row(up ? 'Combien acheter' : 'Combien vendre', `${fmt(size * 100, 0)} % du capital <small class="muted">avec 1 000 $ : ${fmt(size * 1000, 0)} $</small>`)}
    ${row('Objectif', `${px(tp)} <small class="muted">${plainPct((tp - s.entry) / s.entry)} : on vend la moitié, ${capOf(P / 2)} de gain déjà assuré</small>`, 'up')}
    ${row('Le reste', `gardé tant que le marché ${up ? 'monte' : 'baisse'}`, 'txt')}
  </dl><p class="txt muted">Le stop est placé à une distance qui suit l'agitation habituelle du prix (0,75 fois sa variation moyenne sur une journée). L'objectif est à ${fmt(P, 0)} fois cette distance.</p></div>`;
}

// 3. Ce qui s'est passé, étape par étape.
function storyBox(s, a) {
  const data = setupsData();
  const P = data.rules.partialR ?? 5;
  const up = s.dir === 'long';
  const days = data.rules.exitDays ?? 7;
  const steps = [[s.time + BAR, `${up ? 'Achat' : 'Vente'} à <b>${px(s.entry)}</b>, stop à ${px(s.sl)}.`]];
  if (s.tpHit) steps.push([s.halfAt, `Le prix atteint l'objectif (${px(tpOf(s))}) : on vend la moitié et on gagne déjà <b class="up">${capOf(P / 2)}</b>. Le stop remonte au prix d'entrée : le reste ne peut plus faire perdre d'argent.`]);
  if (s.outcome === 'sl') steps.push([s.at, `Le prix ${up ? 'redescend' : 'remonte'} jusqu'au stop (${px(s.sl)}) : on coupe. Perte de <b class="down">${capOf(-1)}</b>, comme prévu.`]);
  if (s.outcome === 'be') steps.push([s.at, `Le prix revient au prix d'entrée (${px(s.entry)}) : le reste est vendu sans gain ni perte.`]);
  if (s.outcome === 'exit') {
    // Gain du reste en % du capital : sur une moitié de la position si l'objectif a été atteint.
    const rest = s.tpHit ? s.r - P / 2 : s.r;
    steps.push([s.at + BAR, `Le prix clôture la journée ${up ? 'sous son plus bas' : 'au-dessus de son plus haut'} des ${days} derniers jours${s.exitLvl ? ` (${px(s.exitLvl)})` : ''} : ${up ? 'la hausse' : 'la baisse'} s'arrête. On vend ${s.tpHit ? 'le reste' : 'tout'} à ${px(s.exitPx ?? s.entry)} : <b class="${rest >= 0 ? 'up' : 'down'}">${capOf(rest)}</b>${s.tpHit ? ' de plus' : ''}.`]);
  }
  if (s.outcome === 'open' && s.status === 'confirmé') {
    const live = liveOf(s.symbol);
    steps.push([Date.now(), `Toujours en cours : prix ${px(a.price)}, stop à ${px(live?.stop ?? s.stop ?? s.sl)}${live?.exitAt ? `. On vendra si une journée clôture ${up ? 'sous' : 'au-dessus de'} ${px(live.exitAt)}` : ''}.`]);
  }
  return `<div class="box"><h2>3. Ce qui s'est passé</h2><ol class="tr-steps">${steps.map(([t, text]) => `<li><span class="muted">${t ? when(t) : ''}</span><span>${text}</span></li>`).join('')}</ol></div>`;
}

// 4. Le résultat et son calcul, en % du capital.
function resultBox(s, a) {
  const data = setupsData();
  const P = data.rules.partialR ?? 5;
  if (s.status === 'en cours') return '';
  const open = s.outcome === 'open';
  const r = open ? liveR(s, a) : s.r;
  // Avec l'objectif atteint : la 1re moitié rapporte P/2 % du capital, la 2e moitié le reste.
  const firstHalf = P / 2, second = r - firstHalf;
  let how;
  if (s.tpHit) how = `1re moitié vendue à l'objectif : ${capOf(firstHalf)}. 2e moitié ${open ? 'en ce moment' : 'vendue à la sortie'} : ${capOf(second)}. Total : <b>${capOf(r)}</b> du capital.`;
  else if (open) how = `Le prix a bougé de ${capOf(r)} du capital depuis l'entrée.`;
  else if (s.outcome === 'sl') how = `Le stop a été touché avant l'objectif : on perd ce qui était prévu, ${capOf(-1).replace('-', '')} du capital, pas plus.`;
  else how = `Tout est vendu avant l'objectif : ${capOf(r)} du capital.`;
  return `<div class="box"><h2>4. ${open ? 'Résultat en ce moment' : 'Résultat'}</h2>
    <p class="tr-big ${r > 0 ? 'up' : r < 0 ? 'down' : ''}">${capOf(r)} <small class="muted">du capital</small></p>
    <p class="txt">${how}</p>
    <p class="txt muted">À retenir : quand ça rate, on perd 1 %. Quand ça marche, on gagne souvent 5 % ou plus. Environ 2 trades sur 3 perdent, mais les gagnants rapportent plus que toutes ces petites pertes.</p></div>`;
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
  const levels = [{ v: s.entry, label: 'Entrée', cls: 'fg' }, { v: s.sl, label: 'Stop', cls: 'down' }, { v: tpOf(s), label: 'Objectif', cls: 'up' }];
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
