// Onglet Actu : fil des news classées, bandeau critique, news liées aux setups et aux projets, colonne du Résumé.
import { ago, esc, safeUrl } from './format.js';

const HOUR = 3600_000;
const LEVEL = { critical: 3, medium: 2, low: 1 };
const DOT = { critical: ['c', 'Critique'], medium: ['m', 'Importance moyenne'], low: ['l', 'Importance faible'] };
const LEVELS = [['all', 'Toutes'], ['medium', 'Moyennes et critiques'], ['critical', 'Critiques']];
const PAGE = 60;
// Actifs des setups touchés par une news : pétrole pour le WTI et le Brent, BTC pour tout le marché crypto.
const COMMODITY = { CL: 'Pétrole', BZ: 'Pétrole', NG: 'Gaz' };

let data = null;
let projectsById = new Map();
const state = { theme: 'all', level: 'all', shown: PAGE };
const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};
const $ = id => document.getElementById(id);
const paris = (t, opts) => new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', ...opts });
const hour = t => paris(t, { hour: '2-digit', minute: '2-digit' });
const title = i => esc(i.title || i.titleEn);
const dot = i => `<span class="dot ${DOT[i.importance][0]}" title="${DOT[i.importance][1]}"></span>`;
const arrow = d => (d > 0 ? '▲' : '▼');

function impacts(i) {
  return i.impacts.map(([a, d]) => `<span class="tag ${d > 0 ? 'up' : 'down'}">${esc(a)} ${arrow(d)}</span>`).join('');
}

function sources(i) {
  const names = (i.sources || []).map(s => s.name).filter(Boolean);
  const extra = Math.max(0, (i.count || names.length) - 1);
  return `<span title="${esc(names.join(', '))}">${esc(i.source || names[0] || '')}${extra ? ` + ${extra} source${extra > 1 ? 's' : ''}` : ''}</span>`;
}

function project(i) {
  const p = i.projectId && projectsById.get(i.projectId);
  return p ? `<a class="tag acc" href="#projet/${esc(p.id)}">Projet du top · n°${p.rank}</a>` : '';
}

function itemHtml(i) {
  const link = safeUrl(i.link);
  const head = link ? `<a href="${link}" target="_blank" rel="noopener">${title(i)}</a>` : title(i);
  return `<article class="item" id="n-${esc(i.id)}">${dot(i)}
    <h3>${head}${i.lang !== 'fr' ? ' <span class="tag" title="Pas encore traduit">EN</span>' : ''}</h3>
    ${i.why ? `<p>${esc(i.why)}</p>` : ''}
    <div class="meta"><time class="num" datetime="${new Date(i.time).toISOString()}">${hour(i.time)}</time><span class="tag">${esc(data.themes[i.theme] || i.theme)}</span>${impacts(i)}${project(i)}${sources(i)}</div>
  </article>`;
}

function dayLabel(t) {
  const key = x => paris(x, { year: 'numeric', month: '2-digit', day: '2-digit' });
  if (key(t) === key(Date.now())) return "Aujourd'hui";
  if (key(t) === key(Date.now() - 24 * HOUR)) return 'Hier';
  const s = paris(t, { weekday: 'long', day: 'numeric', month: 'long' });
  return s[0].toUpperCase() + s.slice(1);
}

function filtered() {
  return data.items.filter(i => (state.theme === 'all'
    // Dans « Tout », seuls les gros mouvements de baleines apparaissent : les autres sont dans le filtre Baleines.
    ? !(i.theme === 'whale' && i.importance === 'low')
    : i.theme === state.theme)
    && (state.level === 'all' || LEVEL[i.importance] >= LEVEL[state.level]));
}

function renderList() {
  const list = filtered();
  const shown = list.slice(0, state.shown);
  let day = null;
  $('news-list').innerHTML = shown.map(i => {
    const d = dayLabel(i.time);
    const sep = d !== day ? `<div class="day">${d}</div>` : '';
    day = d;
    return sep + itemHtml(i);
  }).join('') || `<div class="empty">${data.items.length ? 'Aucune news ne correspond à ces filtres.' : 'Aucune news pour le moment. Le fil est mis à jour toutes les 15 minutes.'}</div>`;
  $('news-more').hidden = list.length <= state.shown;
  $('news-count').textContent = `${list.length} news sur les ${data.rules.keepHours} dernières heures${list.length > shown.length ? ` · ${shown.length} affichées` : ''}`;
}

function renderChips() {
  const themes = [['all', 'Tout'], ...Object.entries(data.themes)];
  $('news-themes').innerHTML = themes.map(([k, v]) => `<button type="button" class="chip" data-theme="${k}" aria-pressed="${state.theme === k}">${esc(v)}</button>`).join('');
  $('news-levels').innerHTML = LEVELS.map(([k, v]) => `<button type="button" class="chip" data-level="${k}" aria-pressed="${state.level === k}">${k === 'all' ? '' : `<i class="dot ${DOT[k][0]}"></i> `}${v}</button>`).join('');
}

function renderSources() {
  const list = Object.values(data.sources || {});
  const names = [...new Set(list.map(s => s.name.replace(/^Google News · .*/, 'Google News')))];
  const down = [...new Set(list.filter(s => s.status !== 'ok').map(s => s.name))];
  $('news-sources').innerHTML = `Sources : ${esc(names.join(', '))}. Google News regroupe les agences (Reuters, AP, Bloomberg…) et les grands médias.`
    + (down.length ? ` <span class="warn-inline">Sans réponse à cette mise à jour : ${esc(down.join(', '))}.</span>` : '');
}

// Bandeau rouge : la dernière news critique des 6 dernières heures, jusqu'à ce qu'on le ferme.
function renderBanner() {
  const since = Date.now() - data.rules.bannerHours * HOUR;
  const crit = data.items.find(i => i.importance === 'critical' && i.time >= since);
  const el = $('alert');
  if (!crit || store.get('monexo-alert-closed') === crit.id) { el.hidden = true; return; }
  el.querySelector('a').href = `#actu/${encodeURIComponent(crit.id)}`;
  el.querySelector('.t').textContent = crit.title || crit.titleEn;
  el.querySelector('.when').textContent = ago(new Date(crit.time).toISOString());
  el.querySelector('button').onclick = () => { store.set('monexo-alert-closed', crit.id); el.hidden = true; };
  el.hidden = false;
}

function renderResume() {
  const recent = data.items.filter(i => i.importance !== 'low');
  const rows = (recent.length >= 3 ? recent : data.items.filter(i => !(i.theme === 'whale' && i.importance === 'low'))).slice(0, 5);
  $('resume-news').innerHTML = rows.map(i => `
    <a class="row" href="#actu/${encodeURIComponent(i.id)}">${dot(i)}<span class="d fg">${title(i)}</span><span class="r muted">${hour(i.time)}</span></a>`).join('')
    || '<div class="soon">Aucune news pour le moment.</div>';
}

export function initNews(newsData, projects) {
  data = newsData;
  projectsById = new Map((projects?.projects || []).filter(p => p.inTop).map(p => [p.id, p]));
  Object.assign(state, store.get('monexo-news') || {});
  if (state.theme !== 'all' && !data.themes[state.theme]) state.theme = 'all';
  state.shown = PAGE;
  const update = () => { store.set('monexo-news', { theme: state.theme, level: state.level }); state.shown = PAGE; renderChips(); renderList(); };
  $('news-themes').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (b) { state.theme = b.dataset.theme; update(); }
  });
  $('news-levels').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (b) { state.level = b.dataset.level; update(); }
  });
  $('news-more').addEventListener('click', () => { state.shown += PAGE; renderList(); });
  $('news-sub').textContent = `Titres traduits automatiquement en français. Mis à jour ${ago(data.generatedAt)}, toutes les 15 minutes.`;
  $('news-warnings').innerHTML = (data.warnings || []).map(w => `<p class="warn">⚠ ${esc(w)}</p>`).join('');
  renderChips();
  renderList();
  renderSources();
  renderBanner();
  renderResume();
}

// #actu/<id> : affiche la news demandée, même si un filtre la masquait, et la met en avant.
export function focusNews(id) {
  if (!data || !id) return;
  const i = data.items.findIndex(x => x.id === id);
  if (i < 0) return;
  if (!filtered().some(x => x.id === id)) { state.theme = 'all'; state.level = 'all'; renderChips(); }
  state.shown = Math.max(state.shown, filtered().findIndex(x => x.id === id) + 1);
  renderList();
  const el = document.getElementById(`n-${id}`);
  if (!el) return;
  requestAnimationFrame(() => {
    el.scrollIntoView({ block: 'center' });
    el.classList.add('hl');
    setTimeout(() => el.classList.remove('hl'), 2500);
  });
}

// News importante des dernières 24 h qui touche l'actif d'un setup. dir : +1 si elle pousse à la hausse.
export function linkedNews(symbol, kind = 'crypto') {
  if (!data) return null;
  const since = Date.now() - 24 * HOUR;
  const recent = data.items.filter(i => i.time >= since && i.importance !== 'low' && i.impacts.length);
  const targets = kind === 'commodity' ? [COMMODITY[symbol]].filter(Boolean) : [symbol, 'Crypto', 'BTC'];
  for (const asset of targets) {
    const hit = recent.filter(i => i.impacts.some(([a]) => a === asset)).sort((a, b) => LEVEL[b.importance] - LEVEL[a.importance] || b.time - a.time)[0];
    if (hit) return { item: hit, asset, dir: hit.impacts.find(([a]) => a === asset)[1] };
  }
  return null;
}

// « dans le sens de ce long » / « contre ce short »
export function linkedText(link, setupDir) {
  const along = (link.dir > 0) === (setupDir === 'long');
  return `${link.item.title || link.item.titleEn} (${along ? 'dans le sens de' : 'contre'} ce ${setupDir})`;
}

export function newsForProject(id) {
  return data ? data.items.filter(i => i.projectId === id).slice(0, 5) : [];
}

export function newsRows(items) {
  return items.map(i => `<a class="row" href="#actu/${encodeURIComponent(i.id)}">${dot(i)}<span class="d fg">${title(i)}</span><span class="r muted">${ago(new Date(i.time).toISOString())}</span></a>`).join('');
}

// Bloc « À regarder maintenant » : la dernière news critique, et le setup en jeu qu'elle touche s'il y en a un.
export function newsFocus(setups) {
  const focus = $('focus');
  if (!data || !focus) return;
  const since = Date.now() - data.rules.bannerHours * HOUR;
  const crit = data.items.find(i => i.importance === 'critical' && i.time >= since);
  if (!crit) return;
  let note = '';
  for (const s of (setups?.live || []).filter(x => x.outcome === 'open')) {
    const kind = setups.assets.find(a => a.symbol === s.symbol)?.kind || 'crypto';
    const link = linkedNews(s.symbol, kind);
    if (link?.item.id === crit.id) {
      const along = (link.dir > 0) === (s.dir === 'long');
      note = `Le setup ${s.dir} sur ${esc(s.symbol)} en jeu ${along ? 'va dans le sens de cette news' : 'va contre cette news'}.`;
      break;
    }
  }
  const html = `<a class="card" href="#actu/${encodeURIComponent(crit.id)}"><span class="k">NEWS CRITIQUE · ${esc(ago(new Date(crit.time).toISOString()))}</span>
    <span class="hd">${impacts(crit)}</span><span class="why">${title(crit)}</span>${note ? `<span class="why muted">${note}</span>` : ''}</a>`;
  if (focus.querySelector('.card .why')?.textContent.startsWith('Rien de particulier')) focus.innerHTML = html;
  else focus.insertAdjacentHTML('afterbegin', html);
  while (focus.children.length > 4) focus.lastElementChild.remove();
}

export function newsUnavailable() {
  const msg = 'Le fil d\'actu n\'est pas encore disponible. Il est mis à jour automatiquement toutes les 15 minutes : reviens dans quelques minutes.';
  $('news-list').innerHTML = `<div class="empty">${msg}</div>`;
  $('resume-news').innerHTML = '<div class="soon">Actu pas encore disponible.</div>';
}
