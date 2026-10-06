// Onglets Setups et Historique : 3 indicateurs dans le sens de la tendance (BTC, ETH, SOL, Brent), fiche détaillée avec graphique, bilan sur 12 mois.
import { ago, esc, fmt } from './format.js';
import { linkedNews, linkedText } from './news.js';
import { watchlist } from './watchlist.js';
import { delayed, historyDays, hoursText, isPremium, onTier, visibleIn } from './premium.js';

const BAR = 4 * 3600_000;
export const OUTCOME = {
  sl: ['Stop touché', 'down'],
  be: ['Moitié prise, reste à l\'entrée', 'up'],
  exit: ['Sortie de tendance', ''],
  open: ['En jeu', 'acc'],
};
export const TREND = { haussière: 'up', baissière: 'down', neutre: '' };

let data = null;
let projectsBySymbol = new Map();
const state = { detectors: null, kind: 'all', dir: 'all', watch: false, cat: 'setups' };
const store = {
  get() { try { return JSON.parse(localStorage.getItem('dinexo-setups')) || {}; } catch { return {}; } },
  set(v) { try { localStorage.setItem('dinexo-setups', JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};

// Prix avec assez de chiffres significatifs, même pour les tokens à 0,00001 $.
export function px(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : Math.min(8, 3 - Math.floor(Math.log10(a)));
  return fmt(n, d);
}

export const dirTag = d => `<span class="tag ${d === 'long' ? 'up' : 'down'}">${d === 'long' ? '▲ Long' : '▼ Short'}</span>`;
export const statusTag = s => `<span class="tag ${s.status === 'confirmé' ? 'acc' : 'mid'}">${s.status === 'confirmé' ? 'Confirmé' : 'En cours'}</span>`;
export const outcomeTag = s => (s.status === 'confirmé' && s.outcome !== 'open' ? `<span class="tag ${outcomeCls(s)}">${OUTCOME[s.outcome][0]}</span>` : '');
const asset = sym => data.assets.find(a => a.symbol === sym) || { symbol: sym, name: sym };
export const okxUrl = sym => `https://www.okx.com/trade-swap/${sym.toLowerCase()}-usdt-swap`;
export const parisDay = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// Résultat en % du capital : chaque trade risque data.rules.riskPct % du compte (1 % par défaut), donc 1R = 1 %.
export const cap = r => `${r > 0 ? '+' : ''}${fmt(r * (data.rules.riskPct ?? 1), r * (data.rules.riskPct ?? 1) >= 10 || r * (data.rules.riskPct ?? 1) <= -10 ? 0 : 1)} %`;
export const outcomeCls = s => (s.outcome === 'exit' ? (s.r > 0 ? 'up' : s.r < 0 ? 'down' : '') : OUTCOME[s.outcome][1]);

function winLine(key) {
  const s = data.stats[key];
  if (!s || s.winRate === null) return `${esc(data.detectors[key])} : pas encore assez de trades pour un bilan`;
  return `${esc(data.detectors[key])} : ${fmt(s.winRate * 100, 0)} % de trades gagnants sur ${s.resolved}, ${cap(s.totalR)} du capital sur 12 mois (${fmt(data.rules.riskPct ?? 1, 0)} % risqué par trade)`;
}

export function projectLink(sym) {
  const p = projectsBySymbol.get(sym);
  return p ? `<a class="link" href="#projet/${esc(p.id)}"><b>Projet du top</b> · n°${p.rank} dans Projets</a>` : '';
}

// News importante des dernières 24 h sur l'actif (ou sur tout le marché crypto) : dans le sens du setup ou contre lui.
const newsOf = s => linkedNews(s.symbol, asset(s.symbol).kind || 'crypto');
export function newsLink(s, tag = 'a') {
  const n = newsOf(s);
  if (!n) return '';
  const href = tag === 'a' ? ` href="#actu/${encodeURIComponent(n.item.id)}"` : '';
  return `<${tag} class="link"${href}><b>News liée</b> · ${esc(linkedText(n, s.dir))}</${tag}>`;
}

// Signal pas encore visible sans Premium (SOL et pétrole : 24 h de retard) : carte fermée, sans entrée ni stop.
function lockedCard(s) {
  const a = asset(s.symbol);
  return `<a class="card setup locked" href="#premium">
    <span class="hd"><b class="mono">${esc(s.symbol)}</b><span class="muted">${esc(a.name)}</span><span class="ptag">Premium</span></span>
    <span class="why">Nouveau signal sur ${esc(a.name)}. Il sera visible pour tout le monde dans ${hoursText(visibleIn(s))}.</span>
    <span class="wr">Avec Premium, tu le vois tout de suite, avec le prix d'entrée et le stop.</span>
    <span class="go">Voir Premium →</span>
  </a>`;
}

function card(s) {
  if (delayed(s)) return lockedCard(s);
  const a = asset(s.symbol);
  return `<a class="card setup" href="#setup/${encodeURIComponent(s.id)}">
    <span class="hd"><b class="mono">${esc(s.symbol)}</b><span class="muted">${esc(a.name)}</span>${dirTag(s.dir)}${statusTag(s)}${outcomeTag(s)}</span>
    <span class="tags"><span class="tag">${esc(data.detectors[s.detector])}</span><span class="tag ${TREND[s.trend]}">Tendance 1D ${esc(s.trend)}</span>
      <span class="when">${s.status === 'en cours' ? 'bougie en cours' : ago(new Date(s.time + BAR).toISOString())}</span></span>
    <span class="why">${esc(s.why)}</span>
    <span class="lv"><span><i>Entrée</i>${px(s.entry)}</span><span><i>Stop</i>${px(s.sl)}</span><span><i>Moitié à ${fmt(data.rules.partialR ?? s.rr, 0)}R</i>${px(s.tp[0])}</span>${s.exitAt ? `<span><i>Sortie</i>${px(s.exitAt)}</span>` : `<span><i>R:R</i>1:${fmt(s.rr, 1)}</span>`}</span>
    <span class="wr">${winLine(s.detector)}</span>
    ${newsLink(s, 'span')}
  </a>`;
}

// Radar : une carte par paire, même sans signal. Trade en jeu, sinon le prix qui déclencherait le prochain signal.
// Chaque carte ouvre la fiche de la paire (#paire/<symbole>).
export const plainPct = x => `${x > 0 ? '+' : x < 0 ? '−' : ''}${fmt(Math.abs(x) * 100, 1)} %`;
export const liveOf = sym => data?.live.find(s => s.symbol === sym && s.outcome === 'open') || null;
export const lastTradeOf = sym => data?.history.find(s => s.symbol === sym && s.outcome !== 'open' && !delayed(s)) || null;
export const setupsData = () => data;

// Où en est la paire : trade en jeu, prix de déclenchement, ou attente d'une tendance.
export function radarBody(a) {
  const r = a.radar;
  const live = liveOf(a.symbol);
  if (live && delayed(live)) {
    return `<span class="state"><span class="ptag">Premium</span> <b>Nouveau signal</b> sur ${esc(a.name)}</span>
      <span class="sm">Il sera visible pour tout le monde dans ${hoursText(visibleIn(live))}. Avec Premium, tu le vois tout de suite.</span>`;
  }
  if (live) {
    const move = (a.price - live.entry) / Math.abs(live.entry - live.sl) * (live.dir === 'long' ? 1 : -1);
    const r0 = live.tpHit ? ((data.rules.partialR ?? 5) + move) / 2 : move; // moitié déjà prise à 5R
    return `<span class="state">${dirTag(live.dir)} <b>Trade en cours</b> depuis le ${parisDay(live.time)}</span>
      <span class="sm">Entrée ${px(live.entry)}, stop ${px(live.stop ?? live.sl)}. En ce moment <b class="${r0 >= 0 ? 'up' : 'down'}">${cap(r0)}</b> du capital</span>`;
  }
  if (!r) return '<span class="state">Pas assez de données pour le moment.</span>';
  if (r.trend === 'neutre') return `<span class="state">Pas de trade : le marché n'a pas de direction claire.</span>
    <span class="sm">On attend qu'il reparte nettement à la hausse (achats) ou à la baisse (ventes).</span>`;
  const up = r.dir === 'long';
  const word = up ? 'au-dessus de' : 'sous';
  const macd = `le prix repart ${up ? 'à la hausse après une petite baisse' : 'à la baisse après une petite hausse'}`;
  const NAMES = { range20: `${up ? 'plus haut' : 'plus bas'} du dernier mois`, range10: `${up ? 'plus haut' : 'plus bas'} des 10 derniers jours` };
  if (r.trigger) {
    const near = Math.max(0, 1 - Math.abs(r.trigger.distance) / 0.1); // plein à 0 %, vide à 10 % ou plus
    return `<span class="state"><b class="${up ? 'up' : 'down'}">${up ? 'Achat' : 'Vente'}</b> si le prix clôture une bougie de 4 h ${word} <b>${px(r.trigger.price)}</b> (${plainPct(r.trigger.distance)})</span>
      <span class="meter" title="Distance au déclenchement"><i style="width:${Math.round(near * 100)}%"></i></span>
      <span class="sm">C'est son ${NAMES[r.trigger.key] || esc(data.detectors[r.trigger.key])}. Stop prévu vers ${px(r.trigger.stop)} (${plainPct((r.trigger.stop - r.trigger.price) / r.trigger.price)}).${r.macdReady ? ` Le signal peut aussi venir plus tôt si ${macd}.` : ''}</span>`;
  }
  return `<span class="state">Le prix est déjà ${up ? 'au-dessus de ses plus hauts' : 'sous ses plus bas'} du mois.</span>
    <span class="sm">Prochain signal quand ${r.macdReady ? macd : `il fera une petite ${up ? 'baisse' : 'hausse'} puis repartira`}, s'il n'y a pas d'obstacle juste devant.</span>`;
}

function radarCard(a) {
  const r = a.radar;
  const last = lastTradeOf(a.symbol);
  const head = `<span class="hd"><b class="mono">${esc(a.symbol)}</b><span class="muted">${esc(a.name)}</span>
    ${r ? `<span class="tag ${TREND[r.trend]}">Tendance ${esc(r.trend)}</span>` : ''}<span class="px">${px(a.price)}</span></span>`;
  const lastLine = last ? `<span class="sm">Dernier trade : ${esc(OUTCOME[last.outcome][0].toLowerCase())} le ${parisDay(last.at)} (${cap(last.r)})</span>` : '';
  return `<a class="card" href="#paire/${encodeURIComponent(a.symbol)}">${head}${radarBody(a)}${lastLine}<span class="go">Voir la fiche ${esc(a.symbol)} →</span></a>`;
}

// Catégorie Indicateurs : une carte par paire avec l'état de ses indicateurs, sans signal de trade.
const VERDICT = { 'plutôt haussier': 'up', 'plutôt baissier': 'down', partagé: '' };
export function indicatorCard(a) {
  const ind = a.ind;
  const head = `<span class="hd"><b class="mono">${esc(a.symbol)}</b><span class="muted">${esc(a.name)}</span><span class="px">${px(a.price)}</span></span>`;
  if (!ind) return `<div class="card">${head}<span class="sm">Pas assez de données pour le moment.</span></div>`;
  const rows = ind.items.map(x => `<li><span class="ik">${esc(x.label)}</span><span class="iv ${x.tone}">${esc(x.value)}</span><span class="it">${esc(x.text)}</span></li>`).join('');
  return `<div class="card">${head}
    <span class="ind-sum">Dans l'ensemble : <b class="${VERDICT[ind.verdict] ?? ''}">${esc(ind.verdict)}</b> <span class="muted">(${ind.ups} vert${ind.ups > 1 ? 's' : ''}, ${ind.downs} rouge${ind.downs > 1 ? 's' : ''})</span></span>
    <ul class="ind-list">${rows}</ul>
    <a class="go" href="#paire/${encodeURIComponent(a.symbol)}">Voir la fiche ${esc(a.symbol)} →</a></div>`;
}

function renderIndicators() {
  document.getElementById('setups-ind').innerHTML = data.assets.map(indicatorCard).join('');
}

function renderCat() {
  for (const b of document.querySelectorAll('#setups-cats .chip')) b.setAttribute('aria-pressed', String(b.dataset.cat === state.cat));
  document.getElementById('setups-cat-setups').hidden = state.cat !== 'setups';
  document.getElementById('setups-cat-ind').hidden = state.cat !== 'ind';
}

function renderRadar() {
  document.getElementById('setups-radar').innerHTML = data.assets.map(radarCard).join('');
}

function filtered() {
  return data.live.filter(s => state.detectors.includes(s.detector)
    && (state.dir === 'all' || s.dir === state.dir)
    && (state.kind === 'all' || (asset(s.symbol).kind || 'crypto') === state.kind)
    && (!state.watch || watchlist.has(s.symbol)));
}

function renderList() {
  const list = filtered();
  const total = data.live.length;
  document.getElementById('setups-count').textContent = total
    ? `${list.length} setup${list.length > 1 ? 's' : ''} affiché${list.length > 1 ? 's' : ''} sur ${total} · ${data.assets.length} marchés surveillés`
    : `${data.assets.length} marchés surveillés`;
  document.getElementById('setups-grid').innerHTML = list.length ? list.map(card).join('')
    : `<div class="box"><div class="empty">${!total ? 'Aucun signal en jeu pour le moment : regarde au-dessus les prix qui déclencheraient le prochain. Le signal est rare exprès, environ deux par mois sur les 4 paires.'
      : state.watch ? 'Aucun setup en ce moment sur les actifs de ta watchlist.' : 'Aucun setup ne correspond à ces filtres.'} <a href="#historique">Voir l'historique →</a></div></div>`;
}

export function initSetups(setupsData, projects) {
  data = setupsData;
  projectsBySymbol = new Map((projects?.projects || []).filter(p => p.symbol).map(p => [p.symbol.toUpperCase(), p]));
  const keys = Object.keys(data.detectors);
  Object.assign(state, store.get());
  if (!Array.isArray(state.detectors) || !state.detectors.length) state.detectors = keys;

  const chips = () => {
    document.getElementById('setups-detectors').innerHTML = keys.map(k =>
      `<button type="button" class="chip" data-key="${k}" aria-pressed="${state.detectors.includes(k)}">${esc(data.detectors[k])}</button>`).join('');
    document.getElementById('setups-filters').innerHTML = [
      ['dir', 'all', 'Long et short'], ['dir', 'long', 'Long'], ['dir', 'short', 'Short'], null,
      ['kind', 'all', 'Tous les marchés'], ['kind', 'crypto', 'Crypto'], ['kind', 'commodity', 'Pétrole'], null,
      ['watch', true, 'Ma watchlist'],
    ].map(c => (c ? `<button type="button" class="chip" data-f="${c[0]}" data-v="${c[1]}" aria-pressed="${state[c[0]] === c[1]}">${c[2]}</button>` : '<span class="sep"></span>')).join('');
  };
  const update = () => { store.set(state); chips(); renderList(); };
  document.getElementById('setups-detectors').addEventListener('click', e => {
    const k = e.target.closest('.chip')?.dataset.key;
    if (!k) return;
    state.detectors = state.detectors.includes(k) ? state.detectors.filter(d => d !== k) : [...state.detectors, k];
    update();
  });
  document.getElementById('setups-filters').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    if (b.dataset.f === 'watch') state.watch = !state.watch;
    else state[b.dataset.f] = b.dataset.v;
    update();
  });
  document.getElementById('setups-cats').addEventListener('click', e => {
    const c = e.target.closest('.chip')?.dataset.cat;
    if (!c) return;
    state.cat = c;
    store.set(state);
    renderCat();
  });
  watchlist.subscribe(() => { if (state.watch) renderList(); });
  document.getElementById('setups-warnings').innerHTML = (data.warnings || []).map(w => `<p class="warn">⚠ ${esc(w)}</p>`).join('');
  if (!['setups', 'ind'].includes(state.cat)) state.cat = 'setups';
  chips();
  renderCat();
  renderIndicators();
  renderRadar();
  renderList();
  renderHistory();
  renderResume();
  // Statut Premium connu après la connexion : on redessine ce qui en dépend.
  onTier(() => { renderRadar(); renderList(); renderHistory(); renderResume(); });
}

function renderResume() {
  const open = data.live.filter(s => s.outcome === 'open');
  const live = open.filter(s => !delayed(s));
  const locked = open.filter(s => delayed(s)).map(s => `
    <a class="row" href="#premium"><span class="t">${esc(s.symbol)}</span><span class="d">Nouveau signal · visible dans ${hoursText(visibleIn(s))}</span><span class="r"><span class="ptag">Premium</span></span></a>`);
  document.getElementById('resume-setups').innerHTML = [...live.slice(0, 5).map(s => `
    <a class="row" href="#setup/${encodeURIComponent(s.id)}"><span class="t">${esc(s.symbol)}</span><span class="d">${esc(data.detectors[s.detector])} · ${s.status}</span><span class="r ${s.dir === 'long' ? 'up' : 'down'}">${s.dir === 'long' ? '▲' : '▼'} 1:${fmt(s.rr, 1)}</span></a>`), ...locked].join('')
    || '<div class="soon">Aucun setup en jeu pour le moment.</div>';
  // Bloc « À regarder maintenant » : le setup confirmé du détecteur le plus fiable.
  const rate = s => data.stats[s.detector]?.winRate ?? 0;
  const best = live.filter(s => s.status === 'confirmé').sort((a, b) => rate(b) - rate(a) || b.rr - a.rr)[0];
  const focus = document.getElementById('focus');
  focus?.querySelector('[data-sfocus]')?.remove();
  if (best && focus) {
    const html = `<a class="card" data-sfocus href=""#setup/${encodeURIComponent(best.id)}"><span class="k">SETUP DANS LE SENS DE LA TENDANCE</span>
      <span class="hd"><b class="mono">${esc(best.symbol)}</b><span class="tag">${esc(data.detectors[best.detector])}</span>${dirTag(best.dir)}</span>
      <span class="why">${esc(best.why)} R:R 1:${fmt(best.rr, 1)}.</span></a>`;
    if (focus.querySelector('.card .why')?.textContent.startsWith('Rien de particulier')) focus.innerHTML = html;
    else focus.insertAdjacentHTML('afterbegin', html);
    while (focus.children.length > 4) focus.lastElementChild.remove();
  }
}

// Bilan par détecteur sur une période plus courte que celle du serveur (formule gratuite : 3 mois).
// Mêmes règles que detectorStats dans scripts/lib/setups.mjs.
export function statsOf(history, detectors, from) {
  const stats = {};
  for (const key of Object.keys(detectors)) {
    const list = history.filter(s => s.detector === key && s.status === 'confirmé' && s.time >= from);
    const done = list.filter(s => s.outcome !== 'open');
    const wins = done.filter(s => s.r > 0).length;
    const bySymbol = {};
    for (const s of done) (bySymbol[s.symbol] ??= []).push(s);
    const best = Object.entries(bySymbol)
      .filter(([, l]) => l.length >= 3)
      .map(([sym, l]) => ({ symbol: sym, n: l.length, winRate: l.filter(s => s.r > 0).length / l.length }))
      .sort((x, y) => y.winRate - x.winRate || y.n - x.n)[0] || null;
    stats[key] = {
      signals: list.length, resolved: done.length, wins,
      losses: done.filter(s => s.outcome === 'sl').length,
      tp1: done.filter(s => s.tpHit > 0).length,
      winRate: done.length ? wins / done.length : null,
      avgR: done.length ? done.reduce((t, s) => t + s.r, 0) / done.length : null,
      totalR: Math.round(done.reduce((t, s) => t + s.r, 0) * 10) / 10,
      best,
    };
  }
  return stats;
}

function renderHistory() {
  const keys = Object.keys(data.detectors);
  const since = Math.min(...Object.values(data.freshStart || {}).filter(Boolean));
  const days = historyDays();
  const from = Date.now() - days * 86_400_000;
  // Les signaux encore cachés sans Premium (moins de 24 h sur SOL et le pétrole) ne comptent pas encore.
  const shown = data.history.filter(s => s.time >= from && !delayed(s));
  const stats = isPremium() ? data.stats : statsOf(shown, data.detectors, from);
  document.getElementById('history-period').textContent = days > 100 ? '12 derniers mois' : '3 derniers mois';
  document.getElementById('history-more').hidden = isPremium();
  document.getElementById('history-sub').textContent = `Un trade est gagnant s'il finit en gain. La moitié est prise à ${data.rules.partialR ?? 5}R, le reste sort quand une journée clôture au-delà du plus bas (ou du plus haut pour un short) des ${data.rules.exitDays ?? 7} derniers jours. `
    + (Number.isFinite(since) ? `Calculé sur les bougies OKX depuis le ${new Date(since).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' })}.` : '');
  document.getElementById('history-body').innerHTML = keys.map(k => {
    const s = stats[k];
    const w = s.winRate === null ? null : Math.round(s.winRate * 100);
    return `<tr>
      <td class="l"><b>${esc(data.detectors[k])}</b><br><span class="muted" style="font-size:12px">dans le sens de la tendance 1D</span></td>
      <td class="n">${s.signals}</td>
      <td class="n">${w === null ? '—' : `<span class="score"><i style="--w:${w}%"></i>${w} %</span>`}</td>
      <td class="n"><span class="up">${s.tp1}</span> / <span class="down">${s.losses}</span></td>
      <td class="n ${s.totalR > 0 ? 'up' : s.totalR < 0 ? 'down' : ''}">${s.avgR === null ? '—' : cap(s.totalR)}</td>
      <td class="l">${s.best ? `${esc(s.best.symbol)} <span class="muted">${fmt(s.best.winRate * 100, 0)} % sur ${s.best.n}</span>` : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
  const done = shown.filter(s => s.outcome !== 'open').slice(0, 60);
  document.getElementById('history-list').innerHTML = done.length ? done.map(s => `<tr data-trade="${esc(s.id)}" title="Voir l'explication du trade">
      <td class="l"><a href="#setup/${encodeURIComponent(s.id)}">${parisDay(s.time)}</a></td>
      <td class="l"><b class="mono">${esc(s.symbol)}</b></td>
      <td class="l">${esc(data.detectors[s.detector])}</td>
      <td class="l">${dirTag(s.dir)}</td>
      <td class="n">${px(s.entry)}</td>
      <td class="n">1:${fmt(s.rr, 1)}</td>
      <td class="l"><span class="tag ${outcomeCls(s)}">${OUTCOME[s.outcome][0]}</span></td>
      <td class="n ${s.r > 0 ? 'up' : s.r < 0 ? 'down' : ''}">${cap(s.r)}</td>
    </tr>`).join('') : '<tr><td colspan="8"><div class="empty">Aucun signal terminé pour le moment.</div></td></tr>';
}

export function setupsUnavailable() {
  const msg = '<div class="empty">Les setups ne sont pas encore disponibles. Ils sont calculés automatiquement toutes les heures : reviens dans quelques minutes.</div>';
  document.getElementById('setups-grid').innerHTML = `<div class="box">${msg}</div>`;
  document.getElementById('setup-detail').innerHTML = `<div class="box">${msg}</div>`;
  document.getElementById('history-body').innerHTML = `<tr><td colspan="6">${msg}</td></tr>`;
  document.getElementById('history-list').innerHTML = '';
  document.getElementById('resume-setups').innerHTML = '<div class="soon">Setups pas encore disponibles.</div>';
}
