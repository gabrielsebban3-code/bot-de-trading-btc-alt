// Onglet Marché : chiffres clés, lecture de la direction, graphique à courbes au choix et plus grosses cryptos.
// Le graphique empile des panneaux qui partagent l'axe du temps (comme les indicateurs sous un graphique de trading) :
// chaque courbe garde sa propre échelle, sans double axe.
import { esc, fmt, money, pct, price } from './format.js';
import { DAY, sma } from './marche-lib.js';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
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

const dateFr = d => new Date(d * DAY).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
// Gros montants des tuiles : 3 010 Md$, 95,2 Md$, 84,9 M$.
const big = n => (n == null ? '—' : Math.abs(n) >= 1e11 ? `${fmt(n / 1e9, 0)} Md$` : Math.abs(n) >= 1e9 ? `${fmt(n / 1e9, 1)} Md$` : money(n));
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
    tile('Volume perps 24 h', big(t.perps?.total24h), t.fees?.total24h != null ? `<span class="muted">frais payés ${big(t.fees.total24h)}</span>` : ''),
  ].join('');
}

const fngLabel = v => (v <= 25 ? 'Peur extrême' : v < 45 ? 'Peur' : v <= 55 ? 'Neutre' : v < 75 ? 'Avidité' : 'Avidité extrême');

function direction(d) {
  const v = d.verdict;
  if (!v?.total) { $('marche-direction').hidden = true; return; }
  const cls = v.dir > 0 ? 'up' : v.dir < 0 ? 'down' : 'mid';
  $('marche-direction').innerHTML = `<div class="bh"><h2>Direction du marché</h2><span class="verdict ${cls}">${esc(v.label)}</span></div>
    <p class="tally">${v.up} signal${v.up > 1 ? 's' : ''} haussier${v.up > 1 ? 's' : ''}, ${v.down} baissier${v.down > 1 ? 's' : ''} sur ${v.total}</p>
    <ul class="signals">${d.signals.map(s => `<li><span class="sig ${s.dir > 0 ? 'up' : s.dir < 0 ? 'down' : 'flat'}">${s.dir > 0 ? '▲' : s.dir < 0 ? '▼' : '•'}</span><span><b>${esc(s.label)}.</b> ${esc(s.text)}</span></li>`).join('')}</ul>`;
}

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

const el = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
};

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

// Dessine des panneaux empilés qui partagent l'axe du temps, avec survol au doigt, à la souris ou au clavier.
export function drawPanes(box, panes, start, end) {
  const W = box.clientWidth;
  if (!W) return;
  const days = end - start;
  const L = 8, R = 72, GAP = 26, TOP = 4, AX = 22;
  const H = TOP + panes.reduce((s, p) => s + p.h + GAP, 0) - GAP + AX;
  const x = d => L + ((d - start) / (end - start)) * (W - L - R);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `Graphique ${panes.map(p => p.title).join(', ')}` });
  let y0 = TOP;
  for (const p of panes) {
    const vals = p.lines.flatMap(l => l.pts.map(q => q[1]));
    let lo = p.lo ?? Math.min(...vals), hi = p.hi ?? Math.max(...vals);
    if (p.bars) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (p.lo == null) { const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.05 || 1; lo -= p.bars ? 0 : pad; hi += pad; }
    const top = y0 + 18, bottom = y0 + p.h;
    const y = v => bottom - ((v - lo) / (hi - lo || 1)) * (bottom - top);
    Object.assign(p, { y, top, bottom });
    svg.append(el('text', { x: L, y: y0 + 11, class: 'pt' }, p.title));
    for (const [a, b, cls] of p.bands || []) svg.append(el('rect', { x: L, width: W - L - R, y: y(b), height: y(a) - y(b), class: cls }));
    const ticks = p.ticks || [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
    for (const t of ticks) {
      svg.append(el('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: 'grid' }));
      svg.append(el('text', { x: W - R + 6, y: y(t) + 4, class: 'tick' }, p.fmt(t)));
    }
    for (const l of p.lines) {
      if (!l.pts.length) continue;
      if (p.bars) {
        const bw = Math.max(1, (W - L - R) / days - 1);
        for (const [d, v] of l.pts) svg.append(el('rect', { x: x(d) - bw / 2, width: bw, y: Math.min(y(v), y(0)), height: Math.max(1, Math.abs(y(v) - y(0))), class: v >= 0 ? 'bar-up' : 'bar-down' }));
        svg.append(el('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'zero' }));
        continue;
      }
      const d = l.pts.map((q, i) => `${i ? 'L' : 'M'}${x(q[0]).toFixed(1)},${y(q[1]).toFixed(1)}`).join('');
      if (l.key === 'price' || p.lines.length === 1) {
        svg.append(el('path', { d: `${d}L${x(l.pts.at(-1)[0]).toFixed(1)},${bottom}L${x(l.pts[0][0]).toFixed(1)},${bottom}Z`, class: 'area' }));
      }
      svg.append(el('path', { d, class: `ln ${l.cls}` }));
      const [ld, lv] = l.pts.at(-1);
      svg.append(el('circle', { cx: x(ld), cy: y(lv), r: 3, class: `dot-end ${l.cls}` }));
    }
    y0 = bottom + GAP;
  }
  // Axe du temps sous le dernier panneau.
  const months = [];
  for (let d = start; d <= end; d++) {
    const dt = new Date(d * DAY);
    if (dt.getUTCDate() === 1) months.push(d);
  }
  const every = Math.ceil(months.length / Math.max(2, Math.floor((W - L - R) / 70)));
  months.filter((_, i) => i % every === 0).forEach(d => {
    svg.append(el('text', { x: x(d), y: H - 6, class: 'tick mid' }, new Date(d * DAY).toLocaleDateString('fr-FR', { month: 'short', year: days > 365 ? '2-digit' : undefined, timeZone: 'UTC' })));
  });

  // Survol : une ligne verticale sur tous les panneaux et une bulle avec toutes les valeurs du jour.
  const cross = el('line', { y1: TOP, y2: H - AX, class: 'cross', visibility: 'hidden' });
  const hit = el('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent', tabindex: 0 });
  svg.append(cross, hit);
  box.replaceChildren(svg);
  const tip = document.createElement('div');
  tip.className = 'mk-tip';
  tip.hidden = true;
  box.append(tip);
  const valueAt = (pts, d) => { for (let i = pts.length - 1; i >= 0; i--) if (pts[i][0] <= d) return pts[i][0] >= d - 3 ? pts[i][1] : null; return null; };
  const show = d => {
    d = Math.max(start, Math.min(end, d));
    cross.setAttribute('x1', x(d)); cross.setAttribute('x2', x(d)); cross.setAttribute('visibility', 'visible');
    const rows = panes.flatMap(p => p.lines.map(l => [l, p.fmt, valueAt(l.pts, d)])).filter(r => r[2] != null);
    tip.replaceChildren();
    const h = document.createElement('b'); h.textContent = dateFr(d); tip.append(h);
    for (const [l, f, v] of rows) {
      const r = document.createElement('div');
      const k = document.createElement('i'); k.className = `key k-${l.key}`;
      const n = document.createElement('span'); n.textContent = l.label;
      const val = document.createElement('span'); val.className = 'num'; val.textContent = f(v);
      r.append(k, n, val); tip.append(r);
    }
    tip.hidden = false;
    const left = x(d) + 14;
    tip.style.left = `${left + tip.offsetWidth > W ? x(d) - 14 - tip.offsetWidth : left}px`;
  };
  let cursor = end;
  hit.addEventListener('pointermove', e => { const r = svg.getBoundingClientRect(); cursor = Math.round(start + ((e.clientX - r.left - L) / (W - L - R)) * (end - start)); show(cursor); });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  hit.addEventListener('focus', () => show(cursor));
  hit.addEventListener('blur', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  hit.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    cursor += e.key === 'ArrowLeft' ? -1 : 1;
    show(cursor);
  });
}

function top(list) {
  // Chaque ligne ouvre la fiche de sa crypto (#crypto/<id>, js/crypto.js).
  const name = c => `<b>${esc(c.symbol)}</b> <span class="muted">${esc(c.name)}</span>`;
  $('marche-top').innerHTML = list.length ? list.map((c, i) => `<tr${c.id ? ` data-id="${esc(c.id)}"` : ''}><td class="l num">${i + 1}</td><td class="l name">${c.id ? `<a href="#crypto/${esc(c.id)}">${name(c)}</a>` : name(c)}</td>
    <td class="num">${price(c.price)} $</td><td class="num">${pct(c.change24h)}</td><td class="num">${pct(c.change7d)}</td><td class="num">${pct(c.change30d)}</td>
    <td class="num">${money(c.mcap)}</td><td class="num">${money(c.volume)}</td></tr>`).join('')
    : '<tr><td colspan="8"><div class="empty">Classement indisponible à cette mise à jour.</div></td></tr>';
}
