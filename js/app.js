// Point d'entrée : navigation, chargement des données, ticker.
import { ago, esc, fmt, pct, price } from './format.js';
import { initProjects, renderProject } from './projects.js';
import { initSetups, renderSetup, setupsUnavailable } from './setups.js';
import { focusNews, initNews, newsFocus, newsUnavailable } from './news.js';

const $ = id => document.getElementById(id);
const PAGES = ['resume', 'projets', 'setups', 'actu', 'historique', 'compte'];
const WATCHLIST = ['BTC', 'ETH', 'SOL'];
let ready = false;
let setupsReady = false;
let newsReady = false;

// Navigation par ancre : #resume, #projets, #projet/<id>…
function route() {
  const [page, id] = location.hash.slice(1).split('/');
  const target = ['projet', 'setup'].includes(page) ? page : PAGES.includes(page) ? page : 'resume';
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === `page-${target}`));
  const tab = { projet: 'projets', setup: 'setups' }[target] || target;
  document.querySelectorAll('#nav [data-tab]').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  $('more').classList.toggle('on', ['historique', 'compte'].includes(tab));
  $('menu').hidden = true;
  $('more').setAttribute('aria-expanded', 'false');
  if (target === 'projet' && ready) renderProject(decodeURIComponent(id || ''));
  if (target === 'setup' && setupsReady) renderSetup(decodeURIComponent(id || ''));
  window.scrollTo(0, 0);
  if (target === 'actu' && id && newsReady) focusNews(decodeURIComponent(id));
}

$('more').addEventListener('click', () => {
  const open = $('menu').hidden;
  $('menu').hidden = !open;
  $('more').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', e => { if (!e.target.closest('.more')) $('menu').hidden = true; });

// Encadrés « À savoir » : masqués une fois lus, sur cet appareil.
document.querySelectorAll('.intro').forEach(el => {
  const key = `dinexo-intro-${el.dataset.intro}`;
  try { if (localStorage.getItem(key)) el.hidden = true; } catch { /* stockage indisponible */ }
  el.querySelector('button').addEventListener('click', () => {
    el.hidden = true;
    try { localStorage.setItem(key, '1'); } catch { /* stockage indisponible */ }
  });
});

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path} : ${res.status}`);
  return res.json();
}

async function load() {
  const [projects, setups, news, market] = await Promise.all(
    ['projects', 'setups', 'news', 'market'].map(name => getJson(`data/${name}.json`).catch(() => null)),
  );
  showProjects(projects);
  // L'actu d'abord : les setups affichent la news liée à leur actif.
  if (news) {
    initNews(news, projects);
    newsReady = true;
  } else newsUnavailable();
  if (setups) {
    initSetups(setups, projects);
    setupsReady = true;
  } else setupsUnavailable();
  if (news) newsFocus(setups);
  const latest = [projects, setups, news].map(d => d?.generatedAt).filter(Boolean).sort().at(-1);
  if (latest) $('updated').textContent = `Données mises à jour ${ago(latest)}`;
  route();

  const wti = setups?.assets.find(a => a.symbol === 'CL');
  const tiles = [
    ['Dominance BTC', market?.btcDominance != null ? `${fmt(market.btcDominance, 1)} %` : '—'],
    ['Fear & Greed', market?.fearGreed ? `${market.fearGreed.value} · ${esc(market.fearGreed.label)}` : '—'],
    ['Pétrole WTI', wti ? `${price(wti.price)} ${pct(wti.change24h)}` : '—'],
    ['Projets suivis', projects ? String(projects.projects.length) : '—'],
    ['Setups en jeu', setups ? String(setups.live.filter(s => s.outcome === 'open').length) : '—'],
    ['News critiques 24 h', news ? String(news.items.filter(i => i.importance === 'critical' && Date.now() - i.time < 86_400_000).length) : '—'],
  ];
  $('macro').innerHTML = tiles.map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');
}

function showProjects(projects) {
  if (!projects) {
    const msg = '<div class="empty">Les données ne sont pas encore disponibles. Elles sont générées automatiquement toutes les heures : reviens dans quelques minutes.</div>';
    $('projects-body').innerHTML = `<tr><td colspan="11">${msg}</td></tr>`;
    $('resume-projects').innerHTML = '<div class="soon">Données pas encore disponibles.</div>';
    $('focus').innerHTML = '';
    $('project-detail').innerHTML = `<div class="box">${msg}</div>`;
    return;
  }
  $('sample').hidden = !projects.sample;
  initProjects(projects);
  ready = true;
}

// Ticker de la watchlist : OKX, sinon Binance. Masqué si aucune source ne répond.
async function ticker() {
  const fromOkx = async () => Promise.all(WATCHLIST.map(async s => {
    const r = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${s}-USDT`).then(x => x.json());
    const t = r.data[0];
    return { s, last: Number(t.last), change: Number(t.last) / Number(t.open24h) - 1 };
  }));
  const fromBinance = async () => {
    const q = encodeURIComponent(JSON.stringify(WATCHLIST.map(s => `${s}USDT`)));
    const r = await fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${q}`).then(x => x.json());
    return r.map(t => ({ s: t.symbol.replace('USDT', ''), last: Number(t.lastPrice), change: Number(t.priceChangePercent) / 100 }));
  };
  let rows;
  try { rows = await fromOkx(); } catch { rows = await fromBinance().catch(() => null); }
  if (!rows) return;
  const html = rows.map(r => `<span class="t">${r.s} <span class="num">${price(r.last)}</span> ${pct(r.change)}</span>`).join('');
  $('ticker-track').innerHTML = html.repeat(4);
  $('ticker').hidden = false;
}

window.addEventListener('hashchange', route);
route();
load();
ticker();
setInterval(ticker, 60_000);
