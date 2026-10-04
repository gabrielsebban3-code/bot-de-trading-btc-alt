// Fiche d'une crypto (#crypto/<id>), ouverte depuis le tableau « Les plus grosses cryptos » de l'onglet Marché :
// graphique en bougies avec moyennes et volume, lecture de la tendance, force face à BTC, levier sur OKX,
// chiffres clés, news et présentation du projet. Les données viennent de data/crypto/<id>.json (mis à jour
// toutes les heures par scripts/build-cryptos.mjs) ; le prix du haut est celui d'OKX en direct.
import { ago, esc, fmt, money, pct, safeUrl } from './format.js';
import { drawCandles } from './candles.js';
import { BTC_EDGE, changeOver, coinSignals, deSym, fundingYear, groupCandles, keyLevels, LEVERS, liquidation, macdOf, mentions, perfVsBtc, pickGroup, priceText, ratioToBtc, rsiOf, smaOf } from './crypto-lib.js';
import { tallyText } from './marche-lib.js';
import { newsRows, newsWhere } from './news.js';
import { star } from './watchlist.js';

const $ = id => document.getElementById(id);
const DAY = 86_400_000, HOUR = 3_600_000;
// Périodes du graphique : la plus courte en bougies de 4 h, les autres en bougies d'un jour (regroupées si
// l'écran est trop étroit pour les afficher une par une).
const PERIODS = [['1 mois', 'h4', 180], ['3 mois', 'd1', 91], ['6 mois', 'd1', 182], ['1 an', 'd1', 365], ['2 ans', 'd1', 730]];
const MAS = [['ma20', 20, 'Moy. 20 j', 'l-ma20'], ['ma50', 50, 'Moy. 50 j', 'l-ma50'], ['ma200', 200, 'Moy. 200 j', 'l-ma200']];
const PANES = [['vol', 'Volume'], ['rsi', 'RSI'], ['macd', 'MACD'], ['btc', 'Face à BTC'], ['funding', 'Funding'], ['oi', 'Open interest'], ['ls', 'Long / short']];
const STORE = 'dinexo-crypto';
let state = { period: '6 mois', on: ['ma20', 'ma50', 'ma200', 'vol', 'rsi'] };
try { state = { ...state, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { /* stockage indisponible */ }
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* stockage indisponible */ } };

const ctx = { marche: null, setups: null, projects: null };
const cache = new Map(); // fiches déjà chargées, gardées 10 minutes
let current = null; // { id, d, ratio }
let live = null; // dernier prix OKX en direct de la fiche ouverte
let timer = null;
let observer = null;

// Données du reste du site : BTC (force face à BTC), dominance, setups en jeu, projets.
export function setCryptoContext(c) { Object.assign(ctx, c); }

async function load(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.d;
  const res = await fetch(`data/crypto/${id}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`data/crypto/${id}.json : ${res.status}`);
  const d = await res.json();
  cache.set(id, { at: Date.now(), d });
  return d;
}

export async function renderCrypto(id) {
  const box = $('crypto');
  clearInterval(timer);
  if (!/^[a-z0-9-]{1,80}$/.test(id)) { box.innerHTML = '<div class="box"><div class="empty">Crypto inconnue.</div></div>'; return; }
  if (current?.id !== id) { live = null; box.innerHTML = '<div class="box"><div class="empty">Chargement de la fiche…</div></div>'; }
  let d;
  try { d = await load(id); } catch {
    if (location.hash.slice(1).split('/')[1] === id) {
      box.innerHTML = '<div class="box"><div class="empty">La fiche de cette crypto n\'est pas encore disponible. Les fiches sont mises à jour toutes les heures : reviens dans quelques minutes.</div></div>';
    }
    return;
  }
  if (location.hash.slice(1).split('/')[1] !== id) return; // on a changé de page pendant le chargement
  current = { id, d, ratio: d.symbol === 'BTC' ? [] : ratioToBtc(d.candles.d1, ctx.marche?.series?.btc?.points) };
  box.innerHTML = page(current);
  chart();
  observer?.disconnect();
  let w = $('cx-chart').clientWidth;
  observer = new ResizeObserver(() => { const nw = $('cx-chart')?.clientWidth; if (nw && nw !== w) { w = nw; chart(); } });
  observer.observe($('cx-chart'));
  const inst = d.okx?.spot || d.okx?.swap;
  if (inst) {
    ticker(id, inst);
    timer = setInterval(() => ticker(id, inst), 60_000);
  }
}

// Prix OKX en direct (comme le ticker de la watchlist) ; si OKX ne répond pas, le prix de la mise à jour reste affiché.
async function ticker(id, inst) {
  if (document.hidden) return;
  if (location.hash.slice(1).split('/')[1] !== id) { clearInterval(timer); return; }
  try {
    const t = (await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${inst}`).then(r => r.json())).data?.[0];
    if (!t || current?.id !== id) return;
    live = { last: Number(t.last), change: Number(t.last) / Number(t.open24h) - 1 };
    $('cx-price').textContent = `${priceText(live.last)} $`;
    $('cx-24h').innerHTML = pct(live.change);
    $('cx-live').textContent = 'OKX en direct';
  } catch { /* OKX injoignable */ }
}

const dayFr = (d, opts = {}) => new Date(d * DAY).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts });
const isoFr = iso => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const supply = (n, sym) => (n == null ? '—' : `${n >= 1e9 ? `${fmt(n / 1e9, 2)} Md` : n >= 1e6 ? `${fmt(n / 1e6, 2)} M` : fmt(n, 0)} ${esc(sym)}`);
const usd = v => `${priceText(v)} $`;
const fundingFmt = v => `${v >= 0 ? '+' : ''}${fmt(v, 4)} %`;
const row = (k, v, cls = '') => `<dt>${k}</dt><dd class="${cls}">${v}</dd>`;

function page({ d, ratio }) {
  const m = d.market || {};
  const sym = d.symbol;
  const last = d.candles.d1.at(-1)[4];
  const read = coinSignals({ symbol: sym, d1: d.candles.d1, h4: d.candles.h4, ratio, funding: d.funding?.history || [], oi: d.oi || [] });
  const setup = (ctx.setups?.live || []).find(s => s.symbol === sym && s.outcome === 'open');
  const project = (ctx.projects?.projects || []).find(p => p.symbol?.toUpperCase() === sym);
  const ch = (r, label, id = '') => `<span>${label} <b${id ? ` id="${id}"` : ''}>${pct(r ?? null)}</b></span>`;
  const img = safeUrl(m.image);
  return `
    <div class="ph cx-ph">${img ? `<img class="cx-logo" src="${img}" alt="${esc(`Logo ${d.name}`)}" width="32" height="32" loading="lazy">` : ''}<h1>${esc(d.name)}</h1>
      <span class="mono muted">${esc(sym)}</span>${m.rank ? `<span class="tag">n°${m.rank} au classement</span>` : ''}${star(sym, { text: true })}</div>
    <div class="ind-head"><span class="v num" id="cx-price">${usd(live?.last ?? m.price ?? last)}</span>
      <span class="chg num">${ch(live?.change ?? m.change24h, '24 h', 'cx-24h')}${ch(m.change7d, '7 j')}${ch(m.change30d, '30 j')}${ch(m.change1y, '1 an')}</span>
      <span class="muted cx-when" id="cx-live">${live ? 'OKX en direct' : `mis à jour ${ago(d.generatedAt)}`}</span></div>
    ${setup || project ? `<div class="tools cx-cross">${setup ? `<a class="chip" href="#setup/${encodeURIComponent(setup.id)}">Setup ${esc(setup.dir)} en jeu sur ${esc(sym)} →</a>` : ''}${project ? `<a class="chip" href="#projet/${encodeURIComponent(project.id)}">Fiche projet →</a>` : ''}</div>` : ''}
    <div class="nfa">⚠ Ceci n'est pas un conseil financier. Fais tes propres recherches avant tout investissement.</div>
    <div class="box mk cx-box">
      <div class="tools" id="cx-periods" role="group" aria-label="Période"></div>
      <div class="tools mk-toggles" id="cx-toggles" role="group" aria-label="Courbes et panneaux affichés"></div>
      <div class="cx-chart" id="cx-chart"></div>
    </div>
    <div class="detail cx-detail">
      <div class="stack">
        ${trendBox(read, sym)}
        ${btcBox(d, ratio)}
        ${leverBox(d, last)}
      </div>
      <div class="stack">
        <div class="box"><h2>Chiffres clés</h2><dl>${keyFigures(d, last)}</dl></div>
        ${newsBox(d)}
        ${aboutBox(d)}
        ${linksBox(d)}
      </div>
    </div>
    <p class="fine">${d.candles.line
      ? 'Source gratuite : CoinGecko (cours, chiffres clés, présentation). Cette crypto n\'est pas sur OKX : courbe des clôtures quotidiennes sur un an.'
      : `Sources gratuites : OKX (bougies ${esc(d.okx?.candles || '')}${d.okx?.swap ? ', funding, open interest, comptes long / short' : ''}), CoinGecko (chiffres clés, présentation).`} Fiche mise à jour toutes les heures.</p>`;
}

function trendBox(read, sym) {
  const v = read.verdict;
  if (!v.total) return '';
  const cls = v.dir > 0 ? 'up' : v.dir < 0 ? 'down' : 'mid';
  return `<div class="box direction"><div class="bh"><h2>Lecture de la tendance</h2><span class="verdict ${cls}">${esc(v.label)}</span></div>
    <p class="tally">${tallyText(v)}</p>
    <ul class="signals">${read.signals.map(s => `<li><span class="sig ${s.dir > 0 ? 'up' : s.dir < 0 ? 'down' : 'flat'}">${s.dir > 0 ? '▲' : s.dir < 0 ? '▼' : '•'}</span><span><b>${esc(s.label)}.</b> ${esc(s.text)}</span></li>`).join('')}</ul>
    <p class="txt muted cx-note">Les repères des setups : moyennes 20, 50 et 200 jours, sortie de la zone des 20 derniers jours, MACD 4 h. ${esc(sym)} est lu seul ; la direction du marché entier est dans l'onglet <a href="#marche">Marché</a>.</p></div>`;
}

function btcBox(d, ratio) {
  if (d.symbol === 'BTC') {
    const dom = ctx.marche?.tiles?.btcDominance;
    return `<div class="box"><h2>Force face à BTC</h2><p class="txt">Bitcoin est la référence du marché. ${dom != null ? `Sa part dans la valeur de toutes les cryptos (dominance) est de <b>${fmt(dom, 1)} %</b>. Quand elle monte, l'argent se réfugie sur BTC et les autres cryptos souffrent en général.` : ''}</p>
      ${dom != null ? '<a class="link" href="#indicateur/dominance">Voir la dominance BTC <b>→</b></a>' : ''}</div>`;
  }
  const btc = ctx.marche?.series?.btc?.points;
  if (!btc?.length || !ratio.length) return '';
  const perf = perfVsBtc(d.candles.d1, btc).filter(p => p.coin != null && p.btc != null);
  if (!perf.length) return '';
  const label = days => ({ 7: '7 jours', 30: '30 jours', 90: '90 jours', 365: '1 an' })[days];
  const gap = p => (1 + p.coin) / (1 + p.btc) - 1;
  const p30 = perf.find(p => p.days === 30) || perf[0];
  const g = gap(p30);
  return `<div class="box"><h2>Force face à BTC <button type="button" class="chip cx-show" data-cxshow="btc">Voir sur le graphique</button></h2>
    <p class="txt">Sur ${label(p30.days)}, ${esc(d.symbol)} ${Math.abs(g) <= BTC_EDGE ? 'suit à peu près BTC' : g > 0 ? `fait <b class="up">mieux que BTC</b>` : `fait <b class="down">moins bien que BTC</b>`} (${pct(g)} face à BTC). Une crypto plus forte que BTC monte plus vite quand le marché monte ; plus faible, elle baisse en général plus vite que lui.</p>
    <table class="cx-table"><thead><tr><th class="l">Période</th><th>${esc(d.symbol)}</th><th>BTC</th><th>Face à BTC</th></tr></thead>
    <tbody>${perf.map(p => `<tr><td class="l">${label(p.days)}</td><td class="num">${pct(p.coin)}</td><td class="num">${pct(p.btc)}</td><td class="num">${pct(gap(p))}</td></tr>`).join('')}</tbody></table></div>`;
}

function leverBox(d, last) {
  const sym = esc(d.symbol);
  if (!d.okx?.swap) {
    return `<div class="box"><h2>Levier sur OKX</h2><p class="txt">Pas de contrat perpétuel ${sym} sur OKX : pas de levier possible sur cette plateforme.${d.okx?.spot ? ` ${sym} s'achète au comptant (sans levier).` : ''}</p></div>`;
  }
  const entry = live?.last ?? last;
  const lv = keyLevels(d.candles.d1);
  const f = d.funding;
  let next = f?.next ?? null;
  while (next && next < Date.now()) next += (f.every || 8) * HOUR;
  const left = next ? next - Date.now() : null;
  const oi = d.oi?.at(-1)?.[1], oi7 = changeOver(d.oi, 7);
  const ls = d.longShort?.at(-1)?.[1];
  const levers = LEVERS.filter(l => !d.okx.maxLever || l <= d.okx.maxLever);
  const days = move => (lv?.atrPct ? move / lv.atrPct : null);
  const outils = document.getElementById('page-outils');
  return `<div class="box"><h2>Levier sur OKX</h2><dl>
    ${row('Contrat', `<span class="mono">${esc(d.okx.swap)}</span>`, 'txt')}
    ${row('Levier maximum', d.okx.maxLever ? `${d.okx.maxLever}×` : '—')}
    ${f ? row('Funding actuel', `${fundingFmt(f.rate)} / 8 h <span class="muted">· ${f.rate >= 0 ? 'les longs paient' : 'les shorts paient'} ≈ ${fmt(Math.abs(fundingYear(f.rate)), 1)} % par an</span>`, f.rate > 0.03 ? 'down' : '') : ''}
    ${left != null ? row('Prochain paiement', `${new Date(next).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })} <span class="muted">· dans ${left >= HOUR ? `${Math.floor(left / HOUR)} h ` : ''}${String(Math.floor((left % HOUR) / 60_000)).padStart(2, '0')} min</span>`) : ''}
    ${oi != null ? row('Open interest', `${money(oi)} <span class="muted">· 7&nbsp;j</span> ${pct(oi7)}`) : ''}
    ${ls != null ? row('Comptes à l\'achat', `${fmt((ls / (1 + ls)) * 100, 0)} % <span class="muted">· ratio long / short ${fmt(ls, 2)}</span>`) : ''}
  </dl>
  <p class="txt cx-sub">Liquidation d'une position ouverte maintenant à ${usd(entry)}, en marge isolée${lv?.atrPct ? `. Une journée normale ${deSym(sym)} bouge de <b>${fmt(lv.atrPct * 100, 1)} %</b> (amplitude moyenne sur 14 jours)` : ''} :</p>
  <table class="cx-table"><thead><tr><th class="l">Levier</th><th>Long liquidé à</th><th>Short liquidé à</th><th>Écart</th>${lv?.atrPct ? '<th>Journées</th>' : ''}</tr></thead><tbody>
  ${levers.map(l => {
    const q = liquidation(entry, l);
    const n = days(q.move);
    return `<tr><td class="l num">${l}×</td><td class="num">${priceText(q.long)}</td><td class="num">${priceText(q.short)}</td><td class="num">${fmt(q.move * 100, 1)} %</td>${n != null ? `<td class="num ${n < 2 ? 'down' : n < 4 ? 'mid' : 'muted'}">${n < 10 ? fmt(n, 1) : fmt(n, 0)}</td>` : ''}</tr>`;
  }).join('')}</tbody></table>
  <p class="txt muted cx-note">« Journées » : combien de journées normales de mouvement il faut pour être liquidé. Sous 2, une seule journée agitée suffit. Calcul approché (marge de maintenance 0,5 %, frais et funding non compris).${outils ? ' <a href="#outils/liquidation">Calculer ma liquidation →</a>' : ''}</p></div>`;
}

function keyFigures(d, last) {
  const m = d.market || {};
  const sym = d.symbol;
  const lv = keyLevels(d.candles.d1);
  const supplyShare = m.max ? ` <span class="muted">· ${fmt((m.circulating / m.max) * 100, 0)}&nbsp;% du&nbsp;max</span>` : '';
  return [
    row('Prix', usd(live?.last ?? m.price ?? last)),
    m.high24h != null ? row('Plus haut / bas 24 h', `${priceText(m.high24h)} / ${priceText(m.low24h)}`) : '',
    row('Market cap', `${money(m.mcap)}${m.rank ? ` <span class="muted">· n°${m.rank}</span>` : ''}`),
    m.fdv && m.mcap && m.fdv > m.mcap * 1.02 ? row('Valorisation diluée', money(m.fdv)) : '',
    row('Volume 24 h', money(m.volume)),
    m.ath != null ? row('Record historique', `${usd(m.ath)} <span class="muted">· ${isoFr(m.athDate)}</span>`) : '',
    m.athChange != null ? row('Distance au record', pct(m.athChange), '') : '',
    lv ? row('Plus haut / bas sur 1 an', `${priceText(lv.hi1y)} / ${priceText(lv.lo1y)}`) : '',
    lv?.atrPct != null ? row('Amplitude d\'une journée', `${fmt(lv.atrPct * 100, 1)} % <span class="muted">· moyenne 14&nbsp;j</span>`) : '',
    m.circulating != null ? row('En circulation', supply(m.circulating, sym) + supplyShare) : '',
    m.max != null ? row('Offre maximale', supply(m.max, sym)) : m.circulating != null ? row('Offre maximale', '<span class="muted">pas de plafond</span>', 'txt') : '',
    d.about?.genesis ? row('Lancement', isoFr(d.about.genesis)) : '',
  ].join('');
}

// News qui citent la crypto : les critiques et moyennes d'abord (les transferts de baleines, faibles, ensuite).
function newsBox(d) {
  const all = newsWhere(i => mentions(i, d.symbol, d.name), 40);
  if (all === null) return '';
  const items = [...all.filter(i => i.importance !== 'low'), ...all.filter(i => i.importance === 'low')].slice(0, 5);
  return `<div class="box"><h2>News récentes <a href="#actu">Actu →</a></h2>${items.length ? newsRows(items) : `<div class="empty">Pas de news récente sur ${esc(d.name)} dans le fil.</div>`}</div>`;
}

function aboutBox(d) {
  const a = d.about;
  if (!a?.text && !a?.categories?.length) return '';
  return `<div class="box"><h2>À propos</h2>${a.text ? `<p class="txt">${esc(a.text)}</p>` : ''}
    ${a.categories?.length ? `<div class="tags cx-tags">${a.categories.map(c => `<span class="tag">${esc(c)}</span>`).join('')}</div>` : ''}</div>`;
}

function linksBox(d) {
  const l = d.about?.links || {};
  const link = (url, label, cls = '') => (safeUrl(url) ? `<a class="${cls}" href="${safeUrl(url)}" target="_blank" rel="noopener">${label}</a>` : '');
  const s = d.symbol.toLowerCase();
  const okx = d.okx?.spot ? link(`https://www.okx.com/trade-spot/${s}-usdt`, 'Acheter sur OKX', 'buy') : d.okx?.swap ? link(`https://www.okx.com/trade-swap/${s}-usdt-swap`, 'Trader sur OKX', 'buy') : '';
  return `<div class="box"><h2>Liens</h2><div class="links">
    ${okx}
    ${d.okx?.spot && d.okx?.swap ? link(`https://www.okx.com/trade-swap/${s}-usdt-swap`, 'Perpétuel OKX') : ''}
    ${link(l.site, 'Site')}
    ${link(l.whitepaper, 'Whitepaper')}
    ${link(l.twitter, 'X')}
    ${link(l.reddit, 'Reddit')}
    ${link(l.github, 'GitHub')}
    ${link(l.explorer, 'Explorateur')}
    ${link(`https://www.coingecko.com/en/coins/${d.id}`, 'CoinGecko')}
  </div></div>`;
}

// Panneaux possibles pour cette fiche : funding, open interest et long / short seulement avec un perpétuel OKX.
function available(d, ratio) {
  const ok = { vol: !d.candles.line || d.candles.d1.some(c => c[5] > 0), rsi: true, macd: true, btc: ratio.length > 0, funding: Boolean(d.funding?.history?.length), oi: Boolean(d.oi?.length), ls: Boolean(d.longShort?.length) };
  return PANES.filter(([k]) => ok[k]);
}

function controls(d, ratio) {
  const pill = (attr, key, label, on) => `<button type="button" class="chip" data-${attr}="${key}" aria-pressed="${on}">${label}</button>`;
  $('cx-periods').innerHTML = PERIODS.map(([l]) => pill('cxp', l, l === '1 mois' && d.candles.h4.length ? '1 mois · 4 h' : l, state.period === l)).join('');
  $('cx-toggles').innerHTML = [...MAS.map(([k, , l, cls]) => pill('cxo', k, `<i class="key ${cls}"></i>${l}`, state.on.includes(k))),
    ...available(d, ratio).map(([k, l]) => pill('cxo', k, l, state.on.includes(k)))].join('');
}

// Dessine le graphique de la période choisie : bougies (regroupées si besoin), moyennes et panneaux cochés.
function chart() {
  const box = $('cx-chart');
  if (!box || !current) return;
  const { d, ratio } = current;
  controls(d, ratio);
  const W = box.clientWidth;
  if (!W) return;
  const [, kind, count] = PERIODS.find(p => p[0] === state.period) || PERIODS[2];
  const h4 = kind === 'h4' && d.candles.h4.length > 30;
  const base = h4 ? d.candles.h4 : d.candles.d1;
  const unit = h4 ? 'hour' : 'day';
  const lastT = base.at(-1)[0];
  const from = h4 ? Math.max(0, base.length - count) : Math.max(0, base.findIndex(c => c[0] > lastT - (kind === 'h4' ? 31 : count)));
  const [k, groupLabel, key] = pickGroup(unit, base.length - from, W - 82);
  const bars = groupCandles(base.slice(from), key);
  const idx = bars.map(b => from + b[6]); // dernière bougie d'origine de chaque bougie affichée
  const dayOfBar = i => (h4 ? Math.floor(base[idx[i]][0] / 24) : base[idx[i]][0]);
  // Valeur quotidienne d'une bougie ; la journée en cours reprend la veille tant qu'OKX ne l'a pas publiée.
  const at = (m, i) => { const day = dayOfBar(i); return m.get(day) ?? m.get(day - 1) ?? m.get(day - 2) ?? null; };
  const byDay = pts => new Map(pts || []);

  // Moyennes calculées sur les clôtures quotidiennes, quelle que soit la taille des bougies.
  const d1 = d.candles.d1;
  const dayIdx = new Map(d1.map((c, i) => [c[0], i]));
  const closes = d1.map(c => c[4]);
  // En bougies de 4 h, la moyenne du jour est interpolée heure par heure depuis celle de la veille (pas d'escalier).
  const overlays = MAS.filter(([k2]) => state.on.includes(k2)).map(([k2, n, label, cls]) => {
    const ma = smaOf(closes, n);
    return { key: k2, label, cls, vals: bars.map((_, i) => {
      const j = dayIdx.get(dayOfBar(i));
      if (j == null || ma[j] == null) return null;
      if (!h4 || ma[j - 1] == null) return ma[j];
      const f = ((base[idx[i]][0] % 24) + 4) / 24;
      return ma[j - 1] + (ma[j] - ma[j - 1]) * f;
    }) };
  });
  const small = W < 600;
  const panes = [];
  const baseCloses = base.map(c => c[4]);
  const tf = h4 ? '4 h' : 'jour';
  if (state.on.includes('vol') && available(d, ratio).some(([k2]) => k2 === 'vol')) panes.push({ title: `Volume${d.candles.line ? '' : ' sur OKX'}`, h: 64, fmt: money, kind: 'volume', series: [] });
  if (state.on.includes('rsi')) {
    const r = rsiOf(baseCloses, 14);
    panes.push({ title: `RSI 14 · bougies ${tf}`, h: 84, fmt: v => fmt(v, 0), kind: 'line', lo: 0, hi: 100, ticks: [30, 70], refs: [30, 70], bands: [[70, 100, 'b-hot'], [0, 30, 'b-cold']],
      series: [{ key: 'rsi', label: 'RSI', cls: 'l-ind', vals: idx.map(j => r[j]) }] });
  }
  if (state.on.includes('macd')) {
    const mc = macdOf(baseCloses);
    panes.push({ title: `MACD 12 / 26 / 9 · bougies ${tf}`, h: 90, fmt: v => Number(v.toPrecision(3)).toLocaleString('fr-FR'), kind: 'macd',
      series: [{ key: 'hist', label: 'Histo.', cls: 'l-ind', vals: idx.map(j => mc.hist[j]) }, { key: 'macd', label: 'MACD', cls: 'l-macd', vals: idx.map(j => mc.line[j]) }, { key: 'signal', label: 'Signal', cls: 'l-signal', vals: idx.map(j => mc.signal[j]) }] });
  }
  if (state.on.includes('btc') && ratio.length) {
    const m = byDay(ratio);
    const raw = bars.map((_, i) => at(m, i));
    const first = raw.find(v => v != null);
    panes.push({ title: `${d.symbol} face à BTC · base 100 au début`, h: 90, fmt: v => fmt(v, 1), kind: 'line', refs: [100],
      series: [{ key: 'btc', label: 'Face à BTC', cls: 'l-btc', vals: raw.map(v => (v == null || !first ? null : (v / first) * 100)) }] });
  }
  if (state.on.includes('funding') && d.funding?.history?.length) {
    const m = byDay(d.funding.history);
    panes.push({ title: 'Funding OKX (% par 8 h, moyenne du jour)', h: 80, fmt: fundingFmt, kind: 'bars', series: [{ key: 'funding', label: 'Funding', cls: 'l-ind', vals: bars.map((_, i) => at(m, i)) }] });
  }
  if (state.on.includes('oi') && d.oi?.length) {
    const m = byDay(d.oi);
    panes.push({ title: 'Open interest OKX', h: 80, fmt: money, kind: 'line', series: [{ key: 'oi', label: 'Open interest', cls: 'l-ind', vals: bars.map((_, i) => at(m, i)) }] });
  }
  if (state.on.includes('ls') && d.longShort?.length) {
    const m = byDay(d.longShort);
    panes.push({ title: 'Comptes long / short OKX (1 = autant de chaque côté)', h: 80, fmt: v => fmt(v, 2), kind: 'line', refs: [1], series: [{ key: 'ls', label: 'Long / short', cls: 'l-ind', vals: bars.map((_, i) => at(m, i)) }] });
  }
  const t0 = i => bars[i][0];
  const label = i => (h4
    ? new Date(t0(i) * HOUR).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })
    : `${k === 7 ? 'Semaine du ' : ''}${dayFr(t0(i), { year: '2-digit' })}${k === 3 ? ' (3 j)' : ''}`);
  drawCandles(box, {
    bars, line: d.candles.line, label, ticks: timeTicks(bars, h4, W - 82),
    price: { title: `${d.symbol} en dollars · ${d.candles.line ? 'clôtures quotidiennes' : groupLabel.toLowerCase()}`, h: small ? 250 : 320, fmt: priceText, overlays },
    panes,
  });
}

// Graduations du temps : le début de chaque mois (ou de chaque jour en bougies de 4 h), espacées pour rester lisibles.
function timeTicks(bars, h4, width) {
  const key = t => (h4 ? Math.floor(t / 24) : new Date(t * DAY).toISOString().slice(0, 7));
  const out = [];
  bars.forEach((b, i) => { if (i && key(b[0]) !== key(bars[i - 1][0])) out.push(i); });
  const span = h4 ? 0 : bars.at(-1)[0] - bars[0][0];
  const every = Math.ceil(out.length / Math.max(2, Math.floor(width / 64)));
  return out.filter((_, j) => j % every === 0).map(i => {
    const t = bars[i][0];
    return [i, h4 ? new Date(Math.floor(t / 24) * DAY).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' })
      : new Date(t * DAY).toLocaleDateString('fr-FR', { month: 'short', year: span > 400 || new Date(t * DAY).getUTCMonth() === 0 ? '2-digit' : undefined, timeZone: 'UTC' })];
  });
}

document.addEventListener('click', e => {
  const b = e.target.closest('#page-crypto .chip[data-cxp], #page-crypto .chip[data-cxo], #page-crypto [data-cxshow]');
  if (!b || !current) return;
  if (b.dataset.cxp) state.period = b.dataset.cxp;
  if (b.dataset.cxo) state.on = state.on.includes(b.dataset.cxo) ? state.on.filter(k => k !== b.dataset.cxo) : [...state.on, b.dataset.cxo];
  if (b.dataset.cxshow) {
    if (!state.on.includes(b.dataset.cxshow)) state.on = [...state.on, b.dataset.cxshow];
    $('cx-chart').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  save();
  chart();
});

// Tableau de l'onglet Marché : chaque ligne ouvre la fiche de sa crypto.
document.addEventListener('click', e => {
  const tr = e.target.closest('#marche-top tr[data-id]');
  if (tr && !e.target.closest('a, button')) location.hash = `crypto/${tr.dataset.id}`;
});
