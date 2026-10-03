// Onglet Heatmap : les plus grosses cryptos en tuiles, taille = market cap, couleur = variation sur la période.
// Données en direct depuis l'API publique et gratuite de CoinGecko, redemandées toutes les 2 minutes tant que
// l'onglet est ouvert. Calculs dans js/treemap.js.
import { esc, money, pct, price } from './format.js';
import { PERIODS, coins, squarify, summary, tileColor } from './treemap.js';
import { star, watchlist } from './watchlist.js';

const URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&price_change_percentage=1h,24h,7d';
const EVERY = 120_000;
const SETUP_ASSETS = ['BTC', 'ETH', 'SOL'];
const $ = id => document.getElementById(id);
const KEY = 'dinexo-heatmap';

const state = { period: '24h', top: 100, size: 'mcap', raw: null, at: 0, error: '', picked: null };
try { Object.assign(state, pick(JSON.parse(localStorage.getItem(KEY) || '{}'))); } catch { /* stockage indisponible */ }
let timer = null;
let loading = null;

function pick(o) {
  return {
    ...(o.period in PERIODS ? { period: o.period } : {}),
    ...([50, 100, 200].includes(o.top) ? { top: o.top } : {}),
    ...(['mcap', 'equal'].includes(o.size) ? { size: o.size } : {}),
  };
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ period: state.period, top: state.top, size: state.size })); } catch { /* stockage indisponible */ }
}

const isOn = () => location.hash.slice(1).split('/')[0] === 'heatmap';

async function load() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch(URL);
      if (!res.ok) throw new Error(res.status === 429 ? 'trop de demandes' : `erreur ${res.status}`);
      state.raw = await res.json();
      state.at = Date.now();
      state.error = '';
    } catch (e) {
      state.error = `CoinGecko ne répond pas (${e.message === 'Failed to fetch' ? 'connexion impossible' : e.message}) : nouvel essai dans 2 minutes.`;
    } finally { loading = null; }
    render();
  })();
  return loading;
}

function chips() {
  const group = (name, options, current) => options.map(([v, label]) =>
    `<button type="button" class="chip" data-${name}="${v}" aria-pressed="${String(v) === String(current)}">${label}</button>`).join('');
  $('heatmap-tools').innerHTML = [
    group('period', Object.entries(PERIODS).map(([k, p]) => [k, p.label]), state.period),
    '<span class="sep"></span>',
    group('top', [[50, 'Top 50'], [100, 'Top 100'], [200, 'Top 200']], state.top),
    '<span class="sep"></span>',
    group('size', [['mcap', 'Taille = market cap'], ['equal', 'Taille égale']], state.size),
  ].join('');
}

function render() {
  chips();
  const list = state.raw ? coins(state.raw, state.top) : [];
  $('heatmap-warn').innerHTML = state.error ? `<div class="warn">${esc(state.error)}</div>` : '';
  if (!list.length) {
    $('heatmap').innerHTML = `<div class="empty">${state.error ? 'Heatmap indisponible pour le moment.' : 'Chargement des prix…'}</div>`;
    $('heatmap-sub').textContent = '';
    $('heatmap-movers').innerHTML = '';
    $('heatmap-info').hidden = true;
    return;
  }
  const { period } = state;
  const full = PERIODS[period].full;
  const s = summary(list, period);
  $('heatmap-sub').innerHTML = `${list.length} cryptos · <b class="up">${s.up} en hausse</b>, <b class="down">${s.down} en baisse</b> sur ${PERIODS[period].label}`
    + ` · moyenne pondérée ${pct(s.avg, false)} · prix CoinGecko <span id="heatmap-age"></span>`;
  age();

  const box = $('heatmap');
  const w = box.clientWidth || 800;
  const h = Math.round(w < 600 ? Math.max(460, w * 1.35) : Math.min(640, Math.max(420, w * 0.55)));
  const rects = squarify(list.map(c => (state.size === 'mcap' ? c.mcap : 1)), 0, 0, w, h);
  const wl = new Set(watchlist.get());
  box.style.height = `${h}px`;
  box.innerHTML = list.map((c, i) => {
    const r = rects[i];
    const v = c.change[period];
    const small = Math.min(r.w, r.h);
    const fs = Math.max(10, Math.min(30, small / 4.2));
    const label = small < 26 ? '' : `<b style="font-size:${fs.toFixed(0)}px">${esc(c.symbol)}</b>${small >= 44 ? `<span style="font-size:${Math.max(10, fs * 0.6).toFixed(0)}px">${v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 10 ? 1 : 0).replace('.', ',')} %`}</span>` : ''}`;
    return `<button type="button" class="tile${wl.has(c.symbol) ? ' wl' : ''}${state.picked === c.id ? ' on' : ''}" data-id="${esc(c.id)}"`
      + ` style="left:${r.x.toFixed(1)}px;top:${r.y.toFixed(1)}px;width:${r.w.toFixed(1)}px;height:${r.h.toFixed(1)}px;background:${tileColor(v, full)}"`
      + ` title="${esc(`${c.name} (${c.symbol}) · ${v === null ? '—' : `${v.toFixed(2)} %`}`)}">${label}</button>`;
  }).join('');

  const known = list.filter(c => c.change[period] !== null).sort((a, b) => b.change[period] - a.change[period]);
  const row = c => `<button type="button" class="row" data-id="${esc(c.id)}"><span class="t">${esc(c.symbol)}</span><span class="d">${esc(c.name)}</span><span class="r">${pct(c.change[period], false)}</span></button>`;
  $('heatmap-movers').innerHTML = `
    <div class="box"><h2>Plus fortes hausses · ${PERIODS[period].label}</h2>${known.slice(0, 5).map(row).join('')}</div>
    <div class="box"><h2>Plus fortes baisses · ${PERIODS[period].label}</h2>${known.slice(-5).reverse().map(row).join('')}</div>`;
  info(list);
}

// Fiche de la crypto touchée : sur téléphone, il n'y a pas de survol.
function info(list) {
  const c = list.find(x => x.id === state.picked);
  const el = $('heatmap-info');
  el.hidden = !c;
  if (!c) return;
  const links = [
    `<a href="https://www.coingecko.com/fr/coins/${encodeURIComponent(c.id)}" target="_blank" rel="noopener">CoinGecko ↗</a>`,
    SETUP_ASSETS.includes(c.symbol) ? '<a href="#setups">Setups</a>' : '',
  ].join('');
  el.innerHTML = `<div class="hd">${c.image && /^https:\/\//.test(c.image) ? `<img src="${esc(c.image)}" alt="" width="22" height="22">` : ''}<b>${esc(c.name)}</b><span class="muted">${esc(c.symbol)} · #${c.rank ?? '—'}</span>
      ${star(c.symbol, { text: true })}
      <button type="button" class="x" aria-label="Fermer">×</button></div>
    <div class="lv"><span><i>Prix</i>${price(c.price)} $</span><span><i>1 h</i>${pct(c.change['1h'], false)}</span><span><i>24 h</i>${pct(c.change['24h'], false)}</span><span><i>7 j</i>${pct(c.change['7d'], false)}</span></div>
    <div class="lv"><span><i>Market cap</i>${money(c.mcap)}</span><span><i>Volume 24 h</i>${money(c.volume)}</span><span></span><span></span></div>
    <div class="links">${links}</div>`;
}

function age() {
  const el = $('heatmap-age');
  if (!el || !state.at) return;
  const min = Math.round((Date.now() - state.at) / 60_000);
  el.textContent = min < 1 ? "à l'instant" : `il y a ${min} min`;
}

function start() {
  if (Date.now() - state.at > EVERY) load(); else render();
  clearInterval(timer);
  timer = setInterval(() => { if (isOn() && !document.hidden) load(); }, EVERY);
}

function route() {
  if (isOn()) start();
  else { clearInterval(timer); timer = null; }
}

document.addEventListener('click', e => {
  const page = e.target.closest('#page-heatmap');
  if (!page) return;
  const chip = e.target.closest('.chip');
  if (chip) {
    const { period, top, size } = chip.dataset;
    if (period) state.period = period;
    if (top) state.top = Number(top);
    if (size) state.size = size;
    save();
    render();
    return;
  }
  if (e.target.closest('#heatmap-info .x')) { state.picked = null; render(); return; }
  const t = e.target.closest('[data-id]');
  if (t) {
    state.picked = state.picked === t.dataset.id && t.classList.contains('tile') ? null : t.dataset.id;
    render();
    if (state.picked && !t.classList.contains('tile')) $('heatmap-info').scrollIntoView({ block: 'nearest' });
  }
});

let resized = 0;
window.addEventListener('resize', () => {
  clearTimeout(resized);
  resized = setTimeout(() => { if (isOn() && state.raw) render(); }, 150);
});
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (isOn() && !document.hidden && Date.now() - state.at > EVERY) load(); });
watchlist.subscribe(() => { if (isOn() && state.raw) render(); });
setInterval(() => { if (isOn()) age(); }, 30_000);
route();
