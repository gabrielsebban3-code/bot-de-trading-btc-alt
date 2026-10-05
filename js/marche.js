// Onglet Marché : chiffres clés, lecture de la direction, graphique à courbes au choix et plus grosses cryptos.
// Le graphique empile des panneaux qui partagent l'axe du temps (comme les indicateurs sous un graphique de trading) :
// chaque courbe garde sa propre échelle, sans double axe.
import { esc, fmt, money, pct, price } from './format.js';
import { DAY, sma, sortTop, tallyText } from './marche-lib.js';
import { drawPanes } from './chart.js';

const $ = id => document.getElementById(id);
const PERIODS = [['3 mois', 91], ['6 mois', 182], ['1 an', 365], ['3 ans', 1095]];
const ASSETS = [['btc', 'BTC'], ['eth', 'ETH'], ['sol', 'SOL']];
// Courbes qu'on peut cocher, dans l'ordre d'affichage. Le prix est toujours affiché.
const TOGGLES = [
  ['ma50', 'Moyenne 50 j'], ['ma200', 'Moyenne 200 j'], ['fng', 'Fear & Greed'],
  ['stables', 'Stablecoins'], ['funding', 'Funding BTC'], ['oi', 'Open interest BTC'],
];
const STORE = 'dinexo-marche';
let data = null;
let state = { asset: 'btc', days: 365, on: TOGGLES.map(t => t[0]) };
try { state = { ...state, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { /* stockage indisponible */ }
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* stockage indisponible */ } };

// Gros montants des tuiles : 3 010 Md$, 95,2 Md$, 84,9 M$.
const big = n => (n == null ? '—' : Math.abs(n) >= 1e11 ? `${fmt(n / 1e9, 0)}\u00a0Md$` : Math.abs(n) >= 1e9 ? `${fmt(n / 1e9, 1)}\u00a0Md$` : money(n));
const fundingFmt = v => `${v >= 0 ? '+' : ''}${fmt(v, 4)} %`;

// Fiches indicateur (#indicateur/<clé>) : titre, format, panneau et comment le lire.
const usd = v => `${price(v)} $`;
const PRICE_READ = 'Au-dessus de sa moyenne 200 jours, la tendance de fond est haussière ; en dessous, baissière. La moyenne 50 jours donne le court terme. Quand la 50 passe au-dessus de la 200, la tendance se retourne à la hausse.';
export const IND = {
  btc: { title: 'Prix BTC', fmt: usd, ma: true, about: 'Clôture quotidienne du Bitcoin (OKX, en dollars).', read: PRICE_READ },
  eth: { title: 'Prix ETH', fmt: usd, ma: true, about: "Clôture quotidienne d'Ethereum (OKX, en dollars).", read: PRICE_READ },
  sol: { title: 'Prix SOL', fmt: usd, ma: true, about: 'Clôture quotidienne de Solana (OKX, en dollars).', read: PRICE_READ },
  brent: { title: 'Pétrole Brent', fmt: usd, ma: true, about: 'Prix du baril de Brent (perpétuel OKX, en dollars).',
    read: "Un pétrole qui flambe relance l'inflation et éloigne les baisses de taux : c'est en général mauvais pour la crypto et la Bourse. Un pétrole qui s'effondre signale souvent un ralentissement de l'économie." },
  dominance: { title: 'Dominance BTC', fmt: v => `${fmt(v, 1)} %`, unit: '%', about: 'Part du Bitcoin dans la valeur totale de toutes les cryptos (CoinGecko).',
    read: "Quand elle monte, l'argent se réfugie sur BTC et les altcoins souffrent en général. Quand elle baisse pendant que le marché monte, c'est souvent la saison des altcoins.",
    note: "CoinGecko ne donne pas l'historique gratuitement : Dinexo l'enregistre lui-même, un point par jour, depuis la mise en ligne de cette page." },
  fng: { title: 'Fear & Greed', fmt: v => fmt(v, 0), about: "Indice de 0 à 100 qui mesure l'humeur du marché crypto : volatilité, volumes, réseaux sociaux, dominance BTC (alternative.me).",
    read: "Sous 25, peur extrême : le marché est souvent proche d'un creux. Au-dessus de 75, euphorie : souvent proche d'un sommet. Entre les deux, c'est le sens du mouvement qui compte.",
    extra: { lo: 0, hi: 100, bands: [[0, 25, 'b-fear'], [75, 100, 'b-greed']], ticks: [25, 50, 75] } },
  stables: { title: 'Stablecoins', pane: 'Stablecoins en circulation', fmt: money, about: 'Total des stablecoins en dollars en circulation (DefiLlama).',
    read: "C'est l'argent prêt à acheter de la crypto. S'il augmente, de l'argent frais arrive sur le marché ; s'il baisse, de l'argent sort." },
  tvl: { title: 'Argent bloqué en DeFi', fmt: money, about: 'Total des dépôts dans les protocoles DeFi, toutes blockchains (DefiLlama).',
    read: "Une TVL qui monte avec les prix montre que les gens utilisent vraiment la DeFi. Une TVL qui baisse plus vite que les prix montre que l'argent part." },
  funding: { title: 'Funding BTC', pane: 'Funding BTC (% par 8 h)', fmt: fundingFmt, about: "Ce que les acheteurs à levier paient aux vendeurs (ou l'inverse) toutes les 8 heures sur le perpétuel BTC d'OKX, moyenne du jour.",
    read: 'Au-dessus de 0,03 % par 8 h, trop de monde parie à la hausse avec du levier : risque de purge brutale. Négatif, les vendeurs paient : une remontée peut les forcer à racheter.',
    extra: { bars: true } },
  oi: { title: 'Open interest BTC', fmt: money, about: 'Valeur totale des contrats BTC ouverts sur OKX (futures et perpétuels).',
    read: "Qui monte avec le prix : de nouvelles positions suivent la hausse. Qui monte pendant une baisse : les vendeurs appuient. Qui chute d'un coup : le levier vient d'être liquidé." },
};
const IND_PERIODS = [...PERIODS, ['Tout', 1500]];
let indDays = 365;
let indKey = null;
let indObserver = null;

// Page d'un indicateur : valeur, variations, graphique sur la période choisie et comment le lire.
export function renderIndicator(key) {
  indKey = key;
  const ind = IND[key];
  const box = $('indicator');
  if (!ind) { box.innerHTML = '<div class="box"><div class="empty">Indicateur inconnu.</div></div>'; return; }
  const pts = data?.series?.[key]?.points || [];
  if (!data) { box.innerHTML = '<div class="box"><div class="empty">Les données du marché ne sont pas encore disponibles. Reviens dans quelques minutes.</div></div>'; return; }
  const last = pts.at(-1)?.[1];
  const back = d => { const t = pts.at(-1)?.[0] - d; const p = pts.findLast(x => x[0] <= t); return p ? p[1] : null; };
  const ch = (d, label) => { const o = back(d); return o != null && last != null ? `<span>${label} ${ind.unit === '%' || key === 'fng' || key === 'funding' ? `<b class="${last - o >= 0 ? 'up' : 'down'}">${last - o >= 0 ? '+' : ''}${fmt(last - o, key === 'funding' ? 4 : key === 'fng' ? 0 : 1)}${ind.unit === '%' ? ' pt' : ''}</b>` : `<b>${pct(last / o - 1)}</b>`}</span>` : ''; };
  const sig = (data.signals || []).find(s => s.key === key || (key === 'btc' && s.key === 'trend'));
  box.innerHTML = `<div class="ph"><h1>${esc(ind.title)}</h1></div>
    <div class="ind-head"><span class="v num">${last != null ? ind.fmt(last) : '—'}</span><span class="chg num">${ch(1, '24 h')}${ch(7, '7 j')}${ch(30, '30 j')}${ch(365, '1 an')}</span></div>
    <div class="box mk"><div class="tools" id="ind-periods" role="group" aria-label="Période">${IND_PERIODS.map(([l, n]) => `<button type="button" class="chip" data-inddays="${n}" aria-pressed="${indDays === n}">${l}</button>`).join('')}</div>
    <div class="mk-chart" id="ind-chart"></div></div>
    <div class="detail ind-text"><div class="box"><h2>Comment le lire</h2><p class="txt">${esc(ind.read)}</p>${sig ? `<p class="txt"><b>En ce moment :</b> ${esc(sig.text)}</p>` : ''}</div>
    <div class="box"><h2>D'où vient le chiffre</h2><p class="txt">${esc(ind.about)}</p>${ind.note ? `<p class="txt muted">${esc(ind.note)}</p>` : ''}</div></div>`;
  indicatorChart();
  indObserver?.disconnect();
  let w = 0;
  indObserver = new ResizeObserver(() => { const nw = $('ind-chart')?.clientWidth; if (nw && nw !== w) { w = nw; indicatorChart(); } });
  indObserver.observe($('ind-chart'));
}

function indicatorChart() {
  const box = $('ind-chart');
  const ind = IND[indKey];
  const pts = data?.series?.[indKey]?.points || [];
  if (!box || !ind) return;
  if (pts.length < 2) {
    box.innerHTML = `<div class="empty">${pts.length ? "L'historique commence aujourd'hui : la courbe se dessine au fil des jours." : 'Pas encore de données pour cet indicateur.'}</div>`;
    return;
  }
  const end = pts.at(-1)[0], start = Math.max(end - indDays, pts[0][0]);
  const cut = p => p.filter(q => q[0] >= start && q[1] != null);
  const lines = [{ key: indKey === 'btc' || indKey === 'eth' || indKey === 'sol' || indKey === 'brent' ? 'price' : indKey, label: ind.title, pts: cut(pts), cls: ind.ma ? 'l-price' : 'l-ind' }];
  if (ind.ma) {
    lines.push({ key: 'ma50', label: 'Moy. 50 j', pts: cut(sma(pts, 50)), cls: 'l-ma50' });
    lines.push({ key: 'ma200', label: 'Moy. 200 j', pts: cut(sma(pts, 200)), cls: 'l-ma200' });
  }
  drawPanes(box, [{ title: ind.ma ? `${ind.title} · moyennes 50 et 200 jours` : ind.pane || ind.title, h: 300, fmt: ind.fmt, lines, ...ind.extra }], start, end);
}

document.addEventListener('click', e => {
  const b = e.target.closest('#ind-periods .chip');
  if (!b) return;
  indDays = Number(b.dataset.inddays);
  document.querySelectorAll('#ind-periods .chip').forEach(c => c.setAttribute('aria-pressed', String(c === b)));
  indicatorChart();
});

export function marcheUnavailable() {
  $('marche-tiles').innerHTML = '<div class="empty">Les données du marché ne sont pas encore disponibles. Elles sont générées automatiquement toutes les heures : reviens dans quelques minutes.</div>';
}

export function initMarche(d) {
  data = d;
  tiles(d.tiles || {});
  direction(d);
  agenda(d.agenda);
  season(d.altseason, d.top || []);
  sectors(d.sectors);
  controls();
  chart();
  top(d.top || []);
  let w = 0;
  new ResizeObserver(() => { const nw = $('mk-chart').clientWidth; if (nw !== w) { w = nw; chart(); } }).observe($('mk-chart'));
}

function tiles(t) {
  const tile = (k, v, d, hero, href) => `<${href ? `a href="#indicateur/${href}"` : 'div'} class="kpi${hero ? ' hero' : ''}"><span class="k">${k}${href ? ' <span class="go">→</span>' : ''}</span><span class="v num">${v}</span><span class="d">${d}</span></${href ? 'a' : 'div'}>`;
  const ch = (r, when) => (r == null ? '<span class="muted">—</span>' : `${pct(r)} <span class="muted">${when}</span>`);
  const fg = t.fearGreed;
  $('marche-tiles').innerHTML = [
    tile('Capitalisation crypto', big(t.marketCap?.value), ch(t.marketCap?.change24h, 'sur 24 h'), true),
    tile('Volume échangé 24 h', big(t.volume24h), '<span class="muted">tous marchés</span>'),
    tile('Dominance BTC', t.btcDominance != null ? `${fmt(t.btcDominance, 1)} %` : '—', t.ethDominance != null ? `<span class="muted">ETH ${fmt(t.ethDominance, 1)} %</span>` : '', false, 'dominance'),
    tile('Fear &amp; Greed', fg ? String(fg.value) : '—', fg ? `<span class="muted">${fngLabel(fg.value)}${fg.change1d ? ` · ${fg.change1d > 0 ? '+' : ''}${fg.change1d} depuis hier` : ''}</span>` : '', false, 'fng'),
    tile('Argent bloqué en DeFi', big(t.tvl?.value), ch(t.tvl?.change1d, 'sur 24 h'), false, 'tvl'),
    tile('Stablecoins', big(t.stables?.value), ch(t.stables?.change7d, 'sur 7 j'), false, 'stables'),
    tile('Volume DEX 24 h', big(t.dex?.total24h), ch(t.dex?.change1d, 'vs hier')),
    tile('Volume des dérivés 24 h', big(t.derivs?.volume24h), t.derivs ? `<span class="muted">open interest ${big(t.derivs.openInterest)}</span>` : ''),
  ].join('');
}

const fngLabel = v => (v <= 25 ? 'Peur extrême' : v < 45 ? 'Peur' : v <= 55 ? 'Neutre' : v < 75 ? 'Avidité' : 'Avidité extrême');

function direction(d) {
  const v = d.verdict;
  if (!v?.total) { $('marche-direction').hidden = true; return; }
  const cls = v.dir > 0 ? 'up' : v.dir < 0 ? 'down' : 'mid';
  $('marche-direction').innerHTML = `<div class="bh"><h2>Direction du marché</h2><span class="verdict ${cls}">${esc(v.label)}</span></div>
    <p class="tally">${tallyText(v)}</p>
    <ul class="signals">${d.signals.map(s => `<li><span class="sig ${s.dir > 0 ? 'up' : s.dir < 0 ? 'down' : 'flat'}">${s.dir > 0 ? '▲' : s.dir < 0 ? '▼' : '•'}</span><span><b>${esc(s.label)}.</b> ${esc(s.text)}</span></li>`).join('')}</ul>`;
}

// Agenda macro : les annonces à venir, à l'heure de Paris ; celles de l'heure passée restent affichées.
// Les grosses d'abord (8 au plus), puis les moyennes, en discret, jusqu'à 12 lignes.
function agenda(a) {
  const box = $('marche-agenda');
  box.hidden = !a?.events;
  if (box.hidden) return;
  const now = Date.now();
  const coming = a.events.filter(e => Date.parse(e.t) > now - 3_600_000);
  const big = coming.filter(e => !e.minor).slice(0, 8);
  const list = [...big, ...coming.filter(e => e.minor).slice(0, 12 - big.length)].sort((x, y) => x.t.localeCompare(y.t));
  const paris = (t, o) => new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', ...o });
  const dayKey = t => paris(t, { year: 'numeric', month: 'numeric', day: 'numeric' });
  const day = t => (dayKey(t) === dayKey(now) ? "Aujourd'hui" : dayKey(t) === dayKey(now + DAY) ? 'Demain' : paris(t, { weekday: 'short', day: 'numeric', month: 'short' }));
  const soon = t => {
    const min = Math.round((Date.parse(t) - now) / 60_000);
    return min < 0 ? `il y a ${-min} min` : min < 60 ? `dans ${min} min` : min < 24 * 60 ? `dans ${Math.round(min / 60)} h` : '';
  };
  const figures = e => [e.forecast && `prévu\u00a0${esc(e.forecast)}`, e.previous && `avant\u00a0${esc(e.previous)}`].filter(Boolean).join(' · ');
  box.innerHTML = `<div class="bh"><h2>Agenda macro</h2><span class="muted">heure de Paris</span></div>
    <p class="tally">En blanc, les annonces qui font le plus bouger BTC, souvent de plusieurs % dans l'heure qui suit. En gris, les annonces moyennes, qui le bougent moins souvent.</p>
    ${list.length ? `<ul class="agenda">${list.map(e => `<li${e.minor ? ' class="minor"' : ''}><span class="when"><b>${day(e.t)}</b> ${paris(e.t, { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="what">${esc(e.title)}${figures(e) ? `<small>${figures(e)}</small>` : ''}</span>${soon(e.t) ? `<span class="tag ${e.minor ? 'flat' : 'mid'}">${soon(e.t)}</span>` : ''}</li>`).join('')}</ul>`
      : `<p class="empty">Aucune annonce ${a.nextWeek ? 'dans les prochains jours' : "d'ici la fin de la semaine"}.</p>`}`;
}

// Saison des altcoins : jauge de 0 (saison du Bitcoin) à 100 (saison des altcoins) et les cryptos les plus fortes face à BTC.
function season(s, top) {
  const box = $('marche-saison');
  box.hidden = !s;
  if (!s) return;
  const cls = s.dir > 0 ? 'alt' : s.dir < 0 ? 'btc' : 'mid';
  const fiche = new Set(top.map(c => c.id));
  const name = c => (fiche.has(c.id) ? `<a href="#crypto/${esc(c.id)}">${esc(c.symbol)}</a>` : esc(c.symbol));
  box.innerHTML = `<div class="bh"><h2>Saison des altcoins</h2><span class="verdict ${cls}">${esc(s.label)}</span></div>
    <div class="as-gauge" role="img" aria-label="Indice ${s.value} sur 100 : ${esc(s.label)}">
      <div class="as-track"><i style="left:${Math.min(100, Math.max(0, s.value))}%"></i></div>
      <div class="as-scale"><span>Bitcoin</span><b class="num">${s.value}</b><span>Altcoins</span></div>
    </div>
    <p class="tally">${s.beat} des ${s.total} plus grosses cryptos font mieux que BTC sur 30 jours (BTC\u00a0${pct(s.btc30d)}). Saison des altcoins à partir de 75, saison du Bitcoin à 25 ou moins.</p>
    <p class="as-list"><span class="muted">Les plus fortes face à BTC :</span> ${s.best.map(c => `${name(c)}\u00a0${pct(c.vsBtc)}`).join(' · ')}</p>`;
}

// Secteurs : variation de la capitalisation de chaque secteur, sur 24 h ou 7 jours quand l'historique le permet.
const SECTOR_PERIODS = [['change24h', '24 h'], ['change7d', '7 j']];
function sectors(sec) {
  const box = $('marche-secteurs');
  const list = sec?.list || [];
  box.hidden = !list.some(x => x.change24h != null);
  if (box.hidden) return;
  const has7d = list.filter(x => x.change7d != null).length >= list.length / 2;
  const key = has7d && state.sector === 'change7d' ? 'change7d' : 'change24h';
  const rows = list.filter(x => x[key] != null).sort((a, b) => b[key] - a[key]);
  const max = Math.max(...rows.map(x => Math.abs(x[key])), 0.005);
  const bar = v => `<i class="${v >= 0 ? 'up' : 'down'}" style="${v >= 0 ? 'left' : 'right'}:50%;width:${((Math.abs(v) / max) * 50).toFixed(1)}%"></i>`;
  box.innerHTML = `<div class="bh"><h2>Secteurs</h2>${has7d
    ? `<div class="tools" role="group" aria-label="Période">${SECTOR_PERIODS.map(([k, l]) => `<button type="button" class="chip" data-sector="${k}" aria-pressed="${k === key}">${l}</button>`).join('')}</div>`
    : '<span class="muted">variation sur 24 h</span>'}</div>
    <ul class="sectors">${rows.map(x => `<li><span class="nm">${esc(x.name)}${x.top?.length ? `<small>${x.top.map(esc).join(' · ')}</small>` : ''}</span>
      <span class="sbar">${bar(x[key])}</span><span class="num">${pct(x[key])}</span><span class="num muted mc">${big(x.mcap)}</span></li>`).join('')}</ul>`;
}

document.addEventListener('click', e => {
  const b = e.target.closest('#marche-secteurs [data-sector]');
  if (!b) return;
  state.sector = b.dataset.sector;
  save();
  sectors(data?.sectors);
});

function controls() {
  const pill = (group, key, label, on) => `<button type="button" class="chip${on ? ' on' : ''}" data-${group}="${key}" aria-pressed="${on}">${label}</button>`;
  $('mk-assets').innerHTML = ASSETS.map(([k, l]) => pill('asset', k, l, state.asset === k)).join('');
  $('mk-periods').innerHTML = PERIODS.map(([l, n]) => pill('days', n, l, state.days === n)).join('');
  $('mk-toggles').innerHTML = TOGGLES.filter(([k]) => k.startsWith('ma') || data.series[k]?.points.length)
    .map(([k, l]) => pill('on', k, `<i class="key k-${k}"></i>${l}`, state.on.includes(k))).join('');
}

document.addEventListener('click', e => {
  const b = e.target.closest('#page-marche .chip');
  if (!b || !data) return;
  if (b.dataset.asset) state.asset = b.dataset.asset;
  if (b.dataset.days) state.days = Number(b.dataset.days);
  if (b.dataset.on) state.on = state.on.includes(b.dataset.on) ? state.on.filter(k => k !== b.dataset.on) : [...state.on, b.dataset.on];
  save();
  controls();
  chart();
});

function chart() {
  const box = $('mk-chart');
  const W = box.clientWidth;
  if (!W || !data) return;
  const S = data.series;
  const prices = S[state.asset]?.points || [];
  if (!prices.length) { box.innerHTML = '<div class="empty">Pas encore d\'historique de prix.</div>'; return; }
  const end = prices.at(-1)[0], start = end - state.days;
  const cut = pts => (pts || []).filter(p => p[0] >= start && p[1] != null);
  const name = ASSETS.find(a => a[0] === state.asset)[1];
  const main = { title: `Prix ${name}`, h: 240, fmt: v => `${price(v)} $`, lines: [{ key: 'price', label: name, pts: cut(prices), cls: 'l-price' }] };
  if (state.on.includes('ma50')) main.lines.push({ key: 'ma50', label: 'Moy. 50 j', pts: cut(sma(prices, 50)), cls: 'l-ma50' });
  if (state.on.includes('ma200')) main.lines.push({ key: 'ma200', label: 'Moy. 200 j', pts: cut(sma(prices, 200)), cls: 'l-ma200' });
  const panes = [main];
  for (const key of ['fng', 'stables', 'funding', 'oi']) {
    const pts = state.on.includes(key) ? cut(S[key]?.points) : [];
    if (!pts.length) continue; // pas de point sur la période : pas de panneau vide
    const ind = IND[key];
    panes.push({ title: ind.pane || ind.title, h: 92, fmt: ind.fmt, lines: [{ key, label: ind.title, pts, cls: 'l-ind' }], ...ind.extra });
  }

  drawPanes(box, panes, start, end);
}

// Tableau des plus grosses cryptos : la tendance de chaque crypto vient de sa fiche (data/crypto/index.json, écrit par
// scripts/build-cryptos.mjs avec le même calcul que la page de la crypto). Un clic sur un titre de colonne trie,
// un second clic inverse le sens ; le tri est gardé avec les autres choix de l'onglet.
const COLS = [['rank', '#', 'l'], [null, 'Actif', 'l'], ['trend', 'Tendance', 'l'], ['price', 'Prix'], ['change24h', '24 h'],
  ['change7d', '7 j'], ['change30d', '30 j'], ['mcap', 'Market cap'], ['volume', 'Volume 24 h']];
if (!COLS.some(([k]) => k && k === state.sort)) Object.assign(state, { sort: 'rank', rev: false });
let topList = [];
let trends = new Map();

function top(list) {
  topList = list;
  renderTop();
  fetch('data/crypto/index.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).then(ix => {
    if (!ix?.coins?.length) return;
    trends = new Map(ix.coins.map(c => [c.id, c.trend]));
    renderTop();
  }).catch(() => { /* pas encore de résumé : colonne Tendance vide */ });
}

function trendCell(t) {
  if (!t) return '<span class="muted">—</span>';
  const [cls, text] = t.dir > 0 ? [' up', '▲ Haussier'] : t.dir < 0 ? [' down', '▼ Baissier'] : ['', '• Neutre'];
  return `<span class="tag trend${cls}" title="${esc(`${t.label} : ${tallyText(t)}`)}">${text}</span>`;
}

function renderTop() {
  const asc = (state.sort === 'rank') !== Boolean(state.rev);
  $('marche-head').innerHTML = `<tr>${COLS.map(([k, label, cls]) => {
    const on = k === state.sort;
    const th = `<th${cls ? ` class="${cls}"` : ''}${on ? ` aria-sort="${asc ? 'ascending' : 'descending'}"` : ''}>`;
    return k ? `${th}<button type="button" class="sort" data-mksort="${k}">${label}<span class="arr" aria-hidden="true">${on ? (asc ? '▲' : '▼') : ''}</span></button></th>` : `${th}${label}</th>`;
  }).join('')}</tr>`;
  // Chaque ligne ouvre la fiche de sa crypto (#crypto/<id>, js/crypto.js) ; # reste le rang au classement.
  const rank = new Map(topList.map((c, i) => [c, i + 1]));
  const name = c => `<b>${esc(c.symbol)}</b> <span class="muted">${esc(c.name)}</span>`;
  $('marche-top').innerHTML = topList.length ? sortTop(topList, state.sort, trends, state.rev).map(c => `<tr${c.id ? ` data-id="${esc(c.id)}"` : ''}><td class="l num">${rank.get(c)}</td><td class="l name">${c.id ? `<a href="#crypto/${esc(c.id)}">${name(c)}</a>` : name(c)}</td>
    <td class="l">${trendCell(trends.get(c.id))}</td><td class="num">${price(c.price)} $</td><td class="num">${pct(c.change24h)}</td><td class="num">${pct(c.change7d)}</td><td class="num">${pct(c.change30d)}</td>
    <td class="num">${money(c.mcap)}</td><td class="num">${money(c.volume)}</td></tr>`).join('')
    : `<tr><td colspan="${COLS.length}"><div class="empty">Classement indisponible à cette mise à jour.</div></td></tr>`;
}

document.addEventListener('click', e => {
  const b = e.target.closest('#marche-head button[data-mksort]');
  if (!b) return;
  const k = b.dataset.mksort;
  if (k === state.sort) state.rev = !state.rev;
  else Object.assign(state, { sort: k, rev: false });
  save();
  renderTop();
});
