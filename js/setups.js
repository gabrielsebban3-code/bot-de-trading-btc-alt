// Onglets Setups et Historique : cartes de signaux, fiche détaillée avec graphique, bilan des détecteurs.
import { ago, esc, fmt, pct } from './format.js';
import { candleChart } from './charts.js';
import { linkedNews, linkedText } from './news.js';

const BAR = 4 * 3600_000;
const OUTCOME = {
  tp1: ['TP1 touché', 'up'],
  sl: ['Stop touché', 'down'],
  expired: ['Expiré', ''],
  open: ['En jeu', 'acc'],
};
const TREND = { haussière: 'up', baissière: 'down', neutre: '' };

let data = null;
let projectsBySymbol = new Map();
const state = { detectors: null, kind: 'all', dir: 'all' };
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

const dirTag = d => `<span class="tag ${d === 'long' ? 'up' : 'down'}">${d === 'long' ? '▲ Long' : '▼ Short'}</span>`;
const statusTag = s => `<span class="tag ${s.status === 'confirmé' ? 'acc' : 'mid'}">${s.status === 'confirmé' ? 'Confirmé' : 'En cours'}</span>`;
const outcomeTag = s => (s.status === 'confirmé' && s.outcome !== 'open' ? `<span class="tag ${OUTCOME[s.outcome][1]}">${OUTCOME[s.outcome][0]}</span>` : '');
const asset = sym => data.assets.find(a => a.symbol === sym) || { symbol: sym, name: sym };
const okxUrl = sym => `https://www.okx.com/trade-swap/${sym.toLowerCase()}-usdt-swap`;
const parisTime = t => new Date(t).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

function winLine(key) {
  const s = data.stats[key];
  if (!s || s.winRate === null) return `${esc(data.detectors[key])} : pas encore assez de signaux pour un taux de réussite`;
  return `${esc(data.detectors[key])} : ${fmt(s.winRate * 100, 0)} % de réussite sur ${s.resolved} signaux (90 j)`;
}

function projectLink(sym) {
  const p = projectsBySymbol.get(sym);
  return p ? `<a class="link" href="#projet/${esc(p.id)}"><b>Projet du top</b> · n°${p.rank} dans Projets</a>` : '';
}

// News importante des dernières 24 h sur l'actif (ou sur tout le marché crypto) : dans le sens du setup ou contre lui.
const newsOf = s => linkedNews(s.symbol, asset(s.symbol).kind || 'crypto');
function newsLink(s, tag = 'a') {
  const n = newsOf(s);
  if (!n) return '';
  const href = tag === 'a' ? ` href="#actu/${encodeURIComponent(n.item.id)}"` : '';
  return `<${tag} class="link"${href}><b>News liée</b> · ${esc(linkedText(n, s.dir))}</${tag}>`;
}

function card(s) {
  const a = asset(s.symbol);
  return `<a class="card setup" href="#setup/${encodeURIComponent(s.id)}">
    <span class="hd"><b class="mono">${esc(s.symbol)}</b><span class="muted">${esc(a.name)}</span>${dirTag(s.dir)}${statusTag(s)}${outcomeTag(s)}</span>
    <span class="tags"><span class="tag">${esc(data.detectors[s.detector])}</span><span class="tag ${TREND[s.trend]}">Tendance 1D ${esc(s.trend)}</span>
      <span class="when">${s.status === 'en cours' ? 'bougie en cours' : ago(new Date(s.time + BAR).toISOString())}</span></span>
    <span class="why">${esc(s.why)}</span>
    <span class="lv"><span><i>Entrée</i>${px(s.entry)}</span><span><i>Stop</i>${px(s.sl)}</span><span><i>TP1</i>${px(s.tp[0])}</span><span><i>R:R</i>1:${fmt(s.rr, 1)}</span></span>
    <span class="wr">${winLine(s.detector)}</span>
    ${newsLink(s, 'span')}
  </a>`;
}

function filtered() {
  return data.live.filter(s => state.detectors.includes(s.detector)
    && (state.dir === 'all' || s.dir === state.dir)
    && (state.kind === 'all' || (asset(s.symbol).kind || 'crypto') === state.kind));
}

function renderList() {
  const list = filtered();
  const total = data.live.length;
  document.getElementById('setups-count').textContent = total
    ? `${list.length} setup${list.length > 1 ? 's' : ''} affiché${list.length > 1 ? 's' : ''} sur ${total} · ${data.assets.length} marchés surveillés`
    : `${data.assets.length} marchés surveillés`;
  document.getElementById('setups-grid').innerHTML = list.length ? list.map(card).join('')
    : `<div class="box"><div class="empty">${total ? 'Aucun setup ne correspond à ces filtres.' : 'Aucun setup pour le moment. Les détecteurs repassent toutes les heures sur les bougies 4h.'} <a href="#historique">Voir l'historique →</a></div></div>`;
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
      ['kind', 'all', 'Tous les marchés'], ['kind', 'crypto', 'Crypto'], ['kind', 'commodity', 'Pétrole et gaz'],
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
    state[b.dataset.f] = b.dataset.v;
    update();
  });
  document.getElementById('setups-warnings').innerHTML = (data.warnings || []).map(w => `<p class="warn">⚠ ${esc(w)}</p>`).join('');
  chips();
  renderList();
  renderHistory();
  renderResume();
}

function renderResume() {
  const live = data.live.filter(s => s.outcome === 'open');
  document.getElementById('resume-setups').innerHTML = live.slice(0, 5).map(s => `
    <a class="row" href="#setup/${encodeURIComponent(s.id)}"><span class="t">${esc(s.symbol)}</span><span class="d">${esc(data.detectors[s.detector])} · ${s.status}</span><span class="r ${s.dir === 'long' ? 'up' : 'down'}">${s.dir === 'long' ? '▲' : '▼'} 1:${fmt(s.rr, 1)}</span></a>`).join('')
    || '<div class="soon">Aucun setup en jeu pour le moment.</div>';
  // Bloc « À regarder maintenant » : le setup confirmé du détecteur le plus fiable.
  const rate = s => data.stats[s.detector]?.winRate ?? 0;
  const best = live.filter(s => s.status === 'confirmé').sort((a, b) => rate(b) - rate(a) || b.rr - a.rr)[0];
  const focus = document.getElementById('focus');
  if (best && focus) {
    const html = `<a class="card" href="#setup/${encodeURIComponent(best.id)}"><span class="k">SETUP CONFIRMÉ · 4H</span>
      <span class="hd"><b class="mono">${esc(best.symbol)}</b><span class="tag">${esc(data.detectors[best.detector])}</span>${dirTag(best.dir)}</span>
      <span class="why">${esc(best.why)} R:R 1:${fmt(best.rr, 1)}.</span></a>`;
    if (focus.querySelector('.card .why')?.textContent.startsWith('Rien de particulier')) focus.innerHTML = html;
    else focus.insertAdjacentHTML('afterbegin', html);
    while (focus.children.length > 4) focus.lastElementChild.remove();
  }
}

export function renderSetup(id) {
  const el = document.getElementById('setup-detail');
  const s = data?.live.find(x => x.id === id);
  if (!s) {
    el.innerHTML = '<div class="box"><div class="empty">Ce setup n\'est plus affiché : les signaux restent 24 h. Son résultat apparaît dans l\'<a href="#historique">historique</a>.</div></div>';
    return;
  }
  const a = asset(s.symbol);
  const row = (k, v, cls = '') => `<dt>${k}</dt><dd class="${cls}">${v}</dd>`;
  const R = Math.abs(s.entry - s.sl);
  const st = data.stats[s.detector];
  const expires = s.time + BAR + data.rules.showHours * 3600_000;
  el.innerHTML = `
    <div class="ph"><h1>${esc(s.symbol)} · ${esc(data.detectors[s.detector])} 4h</h1>${dirTag(s.dir)}${statusTag(s)}${outcomeTag(s)}</div>
    <p class="sub">${esc(a.name)} · perpétuel OKX · bougie du ${parisTime(s.time)} (heure de Paris)</p>
    <div class="nfa">⚠ Ceci n'est pas un conseil financier. Fais tes propres recherches avant tout investissement.</div>
    <div class="detail">
      <div class="stack">
        <div class="box"><h2>Pourquoi ce signal</h2><p class="txt">${esc(s.why)}</p>
          ${s.status === 'en cours' ? '<p class="txt muted">La bougie 4h n\'est pas encore fermée : le signal peut disparaître à la clôture.</p>' : ''}</div>
        <div class="box"><h2>Graphique 4h <span class="muted" style="font-weight:400;font-size:12px">entrée, stop et objectifs</span></h2>
          <div class="chart">${data.charts[s.symbol] ? '<canvas id="setup-chart" class="tall" role="img" aria-label="Bougies 4h avec entrée, stop et objectifs"></canvas>' : '<div class="empty">Graphique indisponible.</div>'}</div></div>
      </div>
      <div class="stack">
        <div class="box"><h2>Plan</h2><dl>
          ${row('Entrée', px(s.entry))}
          ${row(`Stop (${fmt(data.rules.stopAtr, 1)} ATR)`, `${px(s.sl)} <small class="muted">${pct((s.sl - s.entry) / s.entry)}</small>`, 'down')}
          ${s.tp.map((t, k) => row(`TP${k + 1}`, `${px(t)} <small class="muted">${fmt(Math.abs(t - s.entry) / R, 1)}R</small>`, 'up')).join('')}
          ${row('R:R (TP1)', `1:${fmt(s.rr, 1)}`)}
          ${row('Tendance 1D', esc(s.trend), TREND[s.trend])}
          ${row('Résultat', s.status === 'confirmé' ? OUTCOME[s.outcome][0] + (s.outcome === 'tp1' && s.tpHit > 1 ? ` (jusqu'à TP${s.tpHit})` : '') : 'Bougie en cours', s.status === 'confirmé' ? OUTCOME[s.outcome][1] : '')}
          ${row('Affiché jusqu\'au', parisTime(expires))}
        </dl></div>
        <div class="box"><h2>Objectifs</h2><dl>
          ${s.tpLabels.map((l, k) => row(`TP${k + 1}`, esc(l), 'txt')).join('')}
        </dl></div>
        <div class="box"><h2>Fiabilité du détecteur</h2><dl>
          ${row('Réussite (90 j)', st?.winRate === null || !st ? '—' : `${fmt(st.winRate * 100, 0)} %`)}
          ${row('Signaux analysés', st ? String(st.resolved) : '—')}
          ${row('R moyen', st?.avgR === null || !st ? '—' : `${st.avgR > 0 ? '+' : ''}${fmt(st.avgR, 2)}R`, st?.avgR > 0 ? 'up' : st?.avgR < 0 ? 'down' : '')}
        </dl>${projectLink(s.symbol)}${newsLink(s)}</div>
        <div class="box"><h2>Liens</h2><div class="links"><a class="buy" href="${okxUrl(s.symbol)}" target="_blank" rel="noopener">Ouvrir sur OKX</a></div></div>
      </div>
    </div>`;
  const canvas = document.getElementById('setup-chart');
  if (canvas) candleChart(canvas, data.charts[s.symbol], { time: s.time, entry: s.entry, sl: s.sl, tp: s.tp, dir: s.dir });
}

function renderHistory() {
  const keys = Object.keys(data.detectors);
  const since = Math.min(...Object.values(data.freshStart || {}).filter(Boolean));
  document.getElementById('history-sub').textContent = `Un signal compte comme gagné s'il touche TP1 avant le stop. Sans résultat après ${data.rules.expiryBars / 6} jours, il est « expiré » et compte comme non gagné. `
    + (Number.isFinite(since) ? `Calculé sur les bougies 4h OKX depuis le ${new Date(since).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' })}.` : '');
  document.getElementById('history-body').innerHTML = keys.map(k => {
    const s = data.stats[k];
    const w = s.winRate === null ? null : Math.round(s.winRate * 100);
    return `<tr>
      <td class="l"><b>${esc(data.detectors[k])}</b>${k === 'funding' && data.freshStart?.funding ? '<br><span class="muted" style="font-size:12px">historique de l\'open interest limité à ~16 jours au départ</span>' : ''}</td>
      <td class="n">${s.signals}</td>
      <td class="n">${w === null ? '—' : `<span class="score"><i style="--w:${w}%"></i>${w} %</span>`}</td>
      <td class="n"><span class="up">${s.wins}</span> / <span class="down">${s.losses}</span> / <span class="muted">${s.expired}</span></td>
      <td class="n ${s.avgR > 0 ? 'up' : s.avgR < 0 ? 'down' : ''}">${s.avgR === null ? '—' : `${s.avgR > 0 ? '+' : ''}${fmt(s.avgR, 2)}R`}</td>
      <td class="l">${s.best ? `${esc(s.best.symbol)} <span class="muted">${fmt(s.best.winRate * 100, 0)} % sur ${s.best.n}</span>` : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
  const done = data.history.filter(s => s.outcome !== 'open').slice(0, 60);
  document.getElementById('history-list').innerHTML = done.length ? done.map(s => `<tr>
      <td class="l muted">${parisTime(s.time)}</td>
      <td class="l"><b class="mono">${esc(s.symbol)}</b></td>
      <td class="l">${esc(data.detectors[s.detector])}</td>
      <td class="l">${dirTag(s.dir)}</td>
      <td class="n">${px(s.entry)}</td>
      <td class="n">1:${fmt(s.rr, 1)}</td>
      <td class="l"><span class="tag ${OUTCOME[s.outcome][1]}">${OUTCOME[s.outcome][0]}</span></td>
      <td class="n ${s.r > 0 ? 'up' : s.r < 0 ? 'down' : ''}">${s.r > 0 ? '+' : ''}${fmt(s.r, 2)}R</td>
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
