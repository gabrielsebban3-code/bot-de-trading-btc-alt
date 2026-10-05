// Onglet Scanner (#scanner, Premium) : la méthode des Setups sur les cryptos les plus échangées d'OKX.
// Signaux des 3 derniers jours, cryptos proches de leur prix de déclenchement, tableau complet avec filtres.
// Sans Premium : les 3 premières lignes de chaque bloc. Données : data/scanner.json (scripts/build-scanner.mjs).
import { ago, esc, fmt, money, pct } from './format.js';
import { isPremium, onTier, premiumBox } from './premium.js';
import { TREND, dirTag, okxUrl, plainPct, px } from './setups.js';

const $ = id => document.getElementById(id);
const FREE_ROWS = 3;
const NEAR = 0.03; // « proche » : à moins de 3 % du prix de déclenchement
const STORE = 'dinexo-scanner';
const FILTERS = [['all', 'Toutes'], ['up', 'Haussières'], ['down', 'Baissières'], ['near', 'Proches (moins de 3 %)'], ['signal', 'Avec un signal']];
const OUTCOME = { sl: ['Stop touché', 'down'], be: ['Moitié prise, reste à l\'entrée', 'up'], exit: ['Sortie de tendance', ''], open: ['En jeu', 'acc'] };

let data = null;
let loading = null;
const state = { filter: 'all', sort: 'volume', ...read() };

function read() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ filter: state.filter, sort: state.sort })); } catch { /* stockage indisponible */ }
}

const nameOf = c => (c.name && c.name.toUpperCase() !== c.symbol ? c.name : '');
const capital = r => `${r > 0 ? '+' : ''}${fmt(r * (data.rules.riskPct ?? 1), 1)} %`; // 1R = 1 % du capital
const near = c => c.trigger && Math.abs(c.trigger.distance) < NEAR;
const link = c => (c.tested ? `#paire/${encodeURIComponent(c.symbol)}` : okxUrl(c.symbol));
const linkText = c => (c.tested ? `Voir la fiche ${esc(c.symbol)} →` : `Voir le graphique sur OKX ↗`);
const ext = c => (c.tested ? '' : ' target="_blank" rel="noopener"');
// En-tête des cartes : la tendance se lit dans le sens du signal (achat ou vente), pas besoin de la répéter.
const head = (c, price = true) => `<span class="hd"><b class="mono">${esc(c.symbol)}</b>${nameOf(c) ? `<span class="muted">${esc(nameOf(c))}</span>` : ''}
  ${price ? `<span class="px">${px(c.price)} $</span>` : ''}</span>`;
const untested = c => (c.tested ? '<span class="sm">Méthode testée sur 3 ans sur cette crypto.</span>'
  : '<span class="sm warn-inline">Méthode pas encore testée sur cette crypto : une piste à vérifier.</span>');

export async function renderScanner() {
  const el = $('scanner');
  if (!el) return;
  if (!data) {
    el.innerHTML = '<div class="box"><div class="empty">Chargement du scanner…</div></div>';
    loading ??= fetch('data/scanner.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    data = await loading;
    loading = null;
  }
  if (!data?.coins?.length) {
    el.innerHTML = '<div class="box"><div class="empty">Le scanner n\'est pas encore disponible. Il est mis à jour toutes les heures : reviens dans quelques minutes.</div></div>';
    return;
  }
  draw();
}

function draw() {
  const coins = data.coins;
  const count = t => coins.filter(c => c.trend === t).length;
  const signals = coins.filter(c => c.signal).sort((a, b) => b.signal.time - a.signal.time);
  const fresh = signals.filter(c => c.signal.confirmedAt >= Date.parse(data.generatedAt) - data.rules.recentDays * 86_400_000);
  const ready = coins.filter(c => near(c) && !(c.signal?.outcome === 'open')).sort((a, b) => Math.abs(a.trigger.distance) - Math.abs(b.trigger.distance));
  const tiles = [
    ['Tendance haussière', count('haussière')],
    ['Tendance baissière', count('baissière')],
    ['Sans direction claire', count('neutre')],
    [`Nouveaux signaux (${data.rules.recentDays} jours)`, fresh.length],
    ['Trades en jeu', signals.filter(c => c.signal.outcome === 'open').length],
    ['Proches du déclenchement', ready.length],
  ];
  $('scanner').innerHTML = `
    <p class="period">Mis à jour ${ago(data.generatedAt)} · les ${coins.length} cryptos les plus échangées sur OKX</p>
    <div class="macro">${tiles.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
    ${isPremium() ? '' : premiumBox(`Le scanner complet est inclus dans Premium : les ${coins.length} cryptos, tous les signaux et tous les prix de déclenchement. Ici, un aperçu avec les ${FREE_ROWS} premières lignes de chaque bloc.`)}
    <h2 class="section">Signaux récents <span class="muted">${data.rules.recentDays} derniers jours et trades encore en jeu</span></h2>
    ${block(signals, signalCard, 'Aucun signal ces derniers jours. C\'est normal : la méthode attend une vraie cassure dans le sens de la tendance.')}
    <h2 class="section">Prêtes à partir <span class="muted">à moins de 3 % de leur prix de déclenchement</span></h2>
    ${block(ready, readyCard, 'Aucune crypto à moins de 3 % de son prix de déclenchement pour le moment.')}
    <h2 class="section">Toutes les cryptos</h2>
    ${table()}
    <div class="nfa">⚠ Le scanner applique une méthode automatique : ce n'est pas un conseil financier. Sur les cryptos autres que BTC, ETH et SOL, la méthode n'a pas été testée sur le passé.</div>`;
}

// Bloc de cartes : tout avec Premium, les premières sinon.
function block(list, card, empty) {
  if (!list.length) return `<div class="box"><div class="empty">${empty}</div></div>`;
  const shown = isPremium() ? list : list.slice(0, FREE_ROWS);
  const more = list.length - shown.length;
  return `<div class="radar">${shown.map(card).join('')}${more > 0 ? `<a class="card locked" href="#premium"><span class="hd"><span class="ptag">Premium</span></span>
    <span class="state">Et ${more} autre${more > 1 ? 's' : ''}</span><span class="sm">Toutes les lignes du scanner sont incluses dans Premium.</span><span class="go">Voir Premium →</span></a>` : ''}</div>`;
}

function signalCard(c) {
  const s = c.signal;
  const [label, cls] = OUTCOME[s.outcome] || ['', ''];
  let now = '';
  if (s.outcome === 'open') {
    const move = (c.price - s.entry) / Math.abs(s.entry - s.sl) * (s.dir === 'long' ? 1 : -1);
    const r = s.tpHit ? ((data.rules.partialR ?? 5) + move) / 2 : move; // moitié déjà prise à 5R
    now = `<span class="sm">En ce moment <b class="${r >= 0 ? 'up' : 'down'}">${capital(r)}</b> du capital (1 % risqué par trade).${s.tpHit ? ' Moitié déjà prise, stop remonté au prix d\'entrée.' : ''}</span>`;
  } else if (s.r != null) now = `<span class="sm">Résultat : <b class="${s.r >= 0 ? 'up' : 'down'}">${capital(s.r)}</b> du capital.</span>`;
  return `<a class="card" href="${link(c)}"${ext(c)}>${head(c, false)}
    <span class="state">${dirTag(s.dir)} <b>${esc(data.detectors[s.detector] || s.detector)}</b> · ${ago(new Date(s.confirmedAt).toISOString())} <span class="tag ${cls}">${label}</span></span>
    <span class="lv"><span><i>Entrée</i>${px(s.entry)}</span><span><i>Stop</i>${px(s.stop ?? s.sl)}</span><span><i>Moitié à ${fmt(data.rules.partialR ?? 5, 0)}R</i>${px(s.tp1)}</span><span><i>Prix actuel</i>${px(c.price)}</span></span>
    ${now}${untested(c)}<span class="go">${linkText(c)}</span></a>`;
}

function readyCard(c) {
  const up = c.dir === 'long';
  const fill = Math.max(0, 1 - Math.abs(c.trigger.distance) / 0.1); // plein à 0 %, vide à 10 %
  return `<a class="card" href="${link(c)}"${ext(c)}>${head(c)}
    <span class="state"><b class="${up ? 'up' : 'down'}">${up ? 'Achat' : 'Vente'}</b> si le prix clôture une bougie de 4 h ${up ? 'au-dessus de' : 'sous'} <b>${px(c.trigger.price)} $</b> (${plainPct(c.trigger.distance)})</span>
    <span class="meter" title="Distance au déclenchement"><i style="width:${Math.round(fill * 100)}%"></i></span>
    <span class="sm">C'est son ${up ? 'plus haut' : 'plus bas'} ${c.trigger.key === 'range20' ? 'du dernier mois' : 'des 10 derniers jours'}. Stop prévu vers ${px(c.trigger.stop)} (${plainPct((c.trigger.stop - c.trigger.price) / c.trigger.price)}).</span>
    ${untested(c)}<span class="go">${linkText(c)}</span></a>`;
}

function nextText(c) {
  if (c.signal?.outcome === 'open') return `${dirTag(c.signal.dir)} <span class="muted">trade en jeu</span>`;
  if (!c.trend) return '<span class="muted">—</span>';
  if (c.trend === 'neutre') return '<span class="muted">pas de direction</span>';
  if (!c.trigger) return `<span class="muted">${c.dir === 'long' ? 'déjà au-dessus des plus hauts' : 'déjà sous les plus bas'}</span>`;
  return `<b class="${c.dir === 'long' ? 'up' : 'down'}">${c.dir === 'long' ? 'Achat' : 'Vente'}</b> ${c.dir === 'long' ? 'au-dessus de' : 'sous'} <span class="num">${px(c.trigger.price)}</span>`;
}

function table() {
  const keep = { all: () => true, up: c => c.trend === 'haussière', down: c => c.trend === 'baissière', near, signal: c => c.signal }[state.filter] || (() => true);
  const dist = c => (c.trigger ? Math.abs(c.trigger.distance) : Infinity);
  const list = data.coins.filter(keep).sort(state.sort === 'distance' ? (a, b) => dist(a) - dist(b) : (a, b) => b.volume - a.volume);
  const shown = isPremium() ? list : list.slice(0, FREE_ROWS);
  const rows = shown.map(c => `<tr data-href="${esc(link(c))}"${c.tested ? '' : ' data-ext="1"'}>
    <td class="l"><b class="mono">${esc(c.symbol)}</b>${nameOf(c) ? ` <span class="muted sc-name">${esc(nameOf(c))}</span>` : ''}</td>
    <td class="n">${px(c.price)}</td><td class="n">${pct(c.change24h)}</td>
    <td class="l">${c.trend ? `<span class="tag ${TREND[c.trend]}">${esc(c.trend)}</span>` : '—'}</td>
    <td class="l">${nextText(c)}</td><td class="n">${c.trigger && !(c.signal?.outcome === 'open') ? plainPct(c.trigger.distance) : '—'}</td>
    <td class="n">${money(c.volume)}</td></tr>`).join('');
  const more = list.length - shown.length;
  return `<div class="tools" role="group" aria-label="Filtrer">${FILTERS.map(([k, l]) => `<button type="button" class="chip" data-sf="${k}" aria-pressed="${state.filter === k}">${l}</button>`).join('')}
      <span class="sep"></span><button type="button" class="chip" data-ss="${state.sort === 'volume' ? 'distance' : 'volume'}">Trier par ${state.sort === 'volume' ? 'distance' : 'volume'}</button></div>
    <div class="wrap" tabindex="0" role="region" aria-label="Tableau du scanner"><table class="sc-table"><thead><tr><th class="l">Crypto</th><th>Prix ($)</th><th>24 h</th><th class="l">Tendance</th><th class="l">Prochain signal</th><th>Distance</th><th>Volume 24 h</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7"><div class="empty">Aucune crypto ne correspond à ce filtre.</div></td></tr>'}
      ${more > 0 ? `<tr class="sc-more"><td colspan="7"><a href="#premium"><span class="ptag">Premium</span> Et ${more} autre${more > 1 ? 's' : ''} : tout le tableau avec Premium →</a></td></tr>` : ''}</tbody></table></div>`;
}

const page = () => $('page-scanner');

document.addEventListener('click', e => {
  if (!page()?.contains(e.target)) return;
  const b = e.target.closest('button[data-sf], button[data-ss]');
  if (b) {
    if (b.dataset.sf) state.filter = b.dataset.sf;
    if (b.dataset.ss) state.sort = b.dataset.ss;
    save();
    draw();
    return;
  }
  // Une ligne du tableau ouvre la fiche de la paire (BTC, ETH, SOL) ou son graphique sur OKX.
  const tr = e.target.closest('tr[data-href]');
  if (tr && !e.target.closest('a')) {
    if (tr.dataset.ext) window.open(tr.dataset.href, '_blank', 'noopener');
    else location.hash = tr.dataset.href;
  }
});

onTier(() => { if (data && page()?.classList.contains('on')) draw(); });
