// Point d'entrée : navigation, chargement des données, watchlist et ticker.
import { ago, esc, fmt, pct, price } from './format.js';
import { initProjects, renderProject } from './projects.js';
import { initSetups, renderSetup, setupsUnavailable } from './setups.js';
import { focusNews, initNews, newsFocus, newsUnavailable } from './news.js';
import { starTitle, watchlist } from './watchlist.js';
import { initMarche, marcheUnavailable, renderIndicator } from './marche.js';
import { alertSymbols, initAccount, refreshAccount, setFeed } from './account.js';
import './heatmap.js';
import { setOutilsData, showTool } from './outils.js';

const $ = id => document.getElementById(id);
const PAGES = ['resume', 'marche', 'projets', 'setups', 'actu', 'heatmap', 'outils', 'historique', 'compte'];
// Actifs connus du site, par symbole : projets, marchés des setups, setup en jeu. Servent au ticker et à Mon compte.
const known = { projects: new Map(), assets: new Map(), live: new Map() };
const quotes = new Map(); // derniers prix OKX du ticker
const asked = new Map(); // heure de la dernière demande à OKX, par symbole
let ready = false;
let setupsReady = false;
let newsReady = false;
let marcheReady = false;

// Navigation par ancre : #resume, #projets, #projet/<id>…
function route() {
  const [page, id] = location.hash.slice(1).split('/');
  const target = ['projet', 'setup', 'indicateur'].includes(page) ? page : PAGES.includes(page) ? page : 'resume';
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === `page-${target}`));
  // Une fiche indicateur garde l'onglet d'où on vient (Résumé ou Marché) et y ramène.
  if (['resume', 'marche'].includes(target)) $('ind-back').href = `#${target}`;
  const tab = { projet: 'projets', setup: 'setups', indicateur: $('ind-back').hash.slice(1) }[target] || target;
  document.querySelectorAll('#nav [data-tab]').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  // Sur mobile, Outils est rangé dans Plus pour que la barre du bas tienne.
  $('more').classList.toggle('on', tab === 'historique' || (tab === 'outils' && matchMedia('(max-width: 700px)').matches));
  $('me').classList.toggle('on', tab === 'compte');
  $('menu').hidden = true;
  $('more').setAttribute('aria-expanded', 'false');
  if (target === 'projet' && ready) renderProject(decodeURIComponent(id || ''));
  if (target === 'setup' && setupsReady) renderSetup(decodeURIComponent(id || ''));
  if (target === 'indicateur') { $('ind-back').textContent = $('ind-back').hash === '#marche' ? '← Marché' : '← Résumé'; if (marcheReady) renderIndicator(decodeURIComponent(id || '')); }
  window.scrollTo(0, 0);
  // Bouton Connexion en haut à droite : sur mobile, le bloc de connexion est sous la watchlist, on l'amène à l'écran.
  if (target === 'compte' && id === 'connexion') $('account').scrollIntoView({ block: 'center' });
  if (target === 'actu' && id && newsReady) focusNews(decodeURIComponent(id));
  if (target === 'outils') showTool(decodeURIComponent(id || ''));
}

$('more').addEventListener('click', () => {
  const open = $('menu').hidden;
  $('menu').hidden = !open;
  $('more').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', e => { if (!e.target.closest('.more')) $('menu').hidden = true; });

// Étoiles : un clic ajoute ou retire l'actif de la watchlist, sans ouvrir la ligne ou la carte autour.
document.addEventListener('click', e => {
  const b = e.target.closest('button.star[data-sym]');
  if (!b) return;
  e.preventDefault();
  watchlist.toggle(b.dataset.sym);
});
watchlist.subscribe(list => {
  for (const b of document.querySelectorAll('button.star[data-sym]')) {
    const on = list.includes(b.dataset.sym);
    b.setAttribute('aria-pressed', String(on));
    b.title = starTitle(b.dataset.sym, on);
  }
  ticker();
});

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
  const [projects, setups, news, market, marche] = await Promise.all(
    ['projects', 'setups', 'news', 'market', 'marche'].map(name => getJson(`data/${name}.json`).catch(() => null)),
  );
  showProjects(projects);
  setOutilsData(marche);
  if (marche) initMarche(marche);
  else marcheUnavailable();
  marcheReady = true;
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
  for (const p of projects?.projects || []) if (p.symbol && !known.projects.has(p.symbol.toUpperCase())) known.projects.set(p.symbol.toUpperCase(), p);
  for (const a of setups?.assets || []) known.assets.set(a.symbol, a);
  for (const s of (setups?.live || []).filter(x => x.outcome === 'open')) if (!known.live.has(s.symbol)) known.live.set(s.symbol, s);
  setFeed(setups, news, projects);
  refreshAccount([...new Set([...known.assets.keys(), ...known.projects.keys()])].sort());
  ticker();
  const latest = [projects, setups, news].map(d => d?.generatedAt).filter(Boolean).sort().at(-1);
  if (latest) $('updated').textContent = `Données mises à jour ${ago(latest)}`;
  route();

  const brent = setups?.assets.find(a => a.symbol === 'BZ');
  // Chaque tuile ouvre la fiche de l'indicateur avec son graphique, ou l'onglet correspondant.
  const tiles = [
    ['Dominance BTC', market?.btcDominance != null ? `${fmt(market.btcDominance, 1)} %` : '—', '#indicateur/dominance'],
    ['Fear & Greed', market?.fearGreed ? `${market.fearGreed.value} · ${esc(market.fearGreed.label)}` : '—', '#indicateur/fng'],
    ['Pétrole Brent', brent ? `${price(brent.price)} ${pct(brent.change24h)}` : '—', '#indicateur/brent'],
    ['Projets suivis', projects ? String(projects.projects.length) : '—', '#projets'],
    ['Setups en jeu', setups ? String(setups.live.filter(s => s.outcome === 'open').length) : '—', '#setups'],
    ['News critiques 24 h', news ? String(news.items.filter(i => i.importance === 'critical' && Date.now() - i.time < 86_400_000).length) : '—', '#actu'],
  ];
  $('macro').innerHTML = tiles.map(([k, v, href]) => `<a href="${href}"><span>${k} <span class="go">→</span></span><b>${v}</b></a>`).join('');
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

// Nom, dernier prix et lien d'un actif suivi.
function assetInfo(s) {
  const p = known.projects.get(s), a = known.assets.get(s), setup = known.live.get(s);
  const q = quotes.get(s) || (p ? { last: p.price, change: p.change24h } : a ? { last: a.price, change: a.change24h } : null);
  return {
    name: p?.name || (a && a.name !== s ? a.name : ''),
    last: q?.last ?? null, change: q?.change ?? null,
    href: p ? `#projet/${encodeURIComponent(p.id)}` : setup ? `#setup/${encodeURIComponent(setup.id)}` : null,
    hrefLabel: p ? 'Fiche' : 'Setup en jeu',
  };
}

// Prix en direct sur OKX : le perpétuel des marchés des setups, sinon la paire au comptant, sinon le perpétuel.
async function quote(s) {
  const ids = known.assets.get(s)?.instId ? [known.assets.get(s).instId] : [`${s}-USDT`, `${s}-USDT-SWAP`];
  for (const id of ids) {
    try {
      const r = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${id}`).then(x => x.json());
      const t = r.data?.[0];
      if (t) return { last: Number(t.last), change: Number(t.last) / Number(t.open24h) - 1 };
    } catch { return null; } // OKX injoignable : le dernier prix des données du site prend le relais
  }
  return null;
}

// Ticker de la watchlist (12 premiers actifs) : OKX en direct, sinon le dernier prix des données du site.
// Un clic sur une étoile ne redemande que le nouvel actif ; tout est rafraîchi chaque minute.
async function ticker() {
  // Plus les actifs des alertes de prix, même hors de la watchlist.
  const todo = [...new Set([...watchlist.get().slice(0, 12), ...alertSymbols()])].filter(s => Date.now() - (asked.get(s) ?? 0) > 30_000);
  for (let i = 0; i < todo.length; i += 4) {
    const batch = todo.slice(i, i + 4);
    batch.forEach(s => asked.set(s, Date.now()));
    const got = await Promise.all(batch.map(quote));
    batch.forEach((s, k) => { if (got[k]) quotes.set(s, got[k]); });
  }
  // Affiche la watchlist du moment, même si elle a changé pendant les demandes.
  const rows = watchlist.get().slice(0, 12).map(s => ({ s, ...assetInfo(s) })).filter(r => r.last != null);
  $('ticker').hidden = !rows.length;
  $('ticker-track').innerHTML = rows.map(r => `<span class="t">${esc(r.s)} <span class="num">${price(r.last)}</span> ${pct(r.change)}</span>`).join('').repeat(4);
  refreshAccount();
}

window.addEventListener('hashchange', route);
initAccount(assetInfo);
route();
load();
ticker();
setInterval(ticker, 60_000);
window.addEventListener('dinexo-alerts', ticker);
