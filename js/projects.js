// Onglet Projets : filtres, tableau, fiche détaillée et blocs de l'accueil.
import { esc, fmt, money, pct, price, safeUrl } from './format.js';
import { revenueChart, sparkline } from './charts.js';
import { newsForProject, newsRows } from './news.js';

const TOP = 25;
const ETH_L2 = new Set(['Ethereum', 'Arbitrum', 'Base', 'Optimism', 'zkSync Era', 'Linea', 'Scroll', 'Blast', 'Mantle',
  'Polygon zkEVM', 'Mode', 'Taiko', 'Unichain', 'Ink', 'Starknet', 'Abstract', 'Soneium', 'Zora', 'Fraxtal', 'Manta']);
const CHAINS = [
  ['all', 'Toutes les chaînes', () => true],
  ['solana', 'Solana', p => p.chains.includes('Solana')],
  ['evm', 'Ethereum + L2', p => p.chains.some(c => ETH_L2.has(c))],
  ['other', 'Autres chaînes', p => !p.chains.includes('Solana') && !p.chains.some(c => ETH_L2.has(c))],
];
const BADGES = [
  ['buyback', 'Buyback', 'acc'],
  ['accelerating', 'Accélère', 'up'],
  ['lowFloat', 'Faible flottant', 'down'],
  ['binanceAlpha', 'Binance Alpha', ''],
  ['okx', 'Sur OKX', ''],
  ['trending', 'Tendance', ''],
];
const FILTER_BADGES = ['buyback', 'accelerating', 'binanceAlpha', 'okx', 'trending'];

const store = {
  get() { try { return JSON.parse(localStorage.getItem('dinexo-filters')) || {}; } catch { return {}; } },
  set(v) { try { localStorage.setItem('dinexo-filters', JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};
const state = { chain: 'all', badges: [], hideLowFloat: false, mcap: 1e9, rev: 0, sort: 'score', ...store.get() };
let data = null;

export function badges(p, { short = false } = {}) {
  const out = [];
  if (p.isNew) out.push('<span class="tag acc">Nouveau</span>');
  for (const [key, label, cls] of BADGES) {
    if (!p.badges[key]) continue;
    if (short && !['buyback', 'accelerating', 'lowFloat'].includes(key)) continue;
    out.push(`<span class="tag ${cls}">${label}</span>`);
  }
  return out.join(' ');
}

const sorters = {
  score: (a, b) => b.score - a.score,
  revenue30d: (a, b) => b.revenue30d - a.revenue30d,
  revenueGrowth: (a, b) => (b.revenueGrowth ?? -Infinity) - (a.revenueGrowth ?? -Infinity),
  tvlGrowth: (a, b) => (b.tvlGrowth ?? -Infinity) - (a.tvlGrowth ?? -Infinity),
  psRatio: (a, b) => (a.psRatio ?? Infinity) - (b.psRatio ?? Infinity),
};

function filtered() {
  const chainTest = CHAINS.find(c => c[0] === state.chain)?.[2] ?? (() => true);
  return data.projects
    .filter(p => chainTest(p))
    .filter(p => state.badges.every(b => p.badges[b]))
    .filter(p => !(state.hideLowFloat && p.badges.lowFloat))
    .filter(p => (p.mcap ?? 0) < state.mcap && p.revenue30d >= state.rev)
    .sort(sorters[state.sort] || sorters.score);
}

export function initProjects(projectsData) {
  data = projectsData;
  const chips = (items, isOn) => items.map(([key, label]) => `<button type="button" class="chip" data-key="${key}" aria-pressed="${isOn(key)}">${label}</button>`).join('');
  const chainsEl = document.getElementById('chains');
  const badgesEl = document.getElementById('badges');
  const renderChips = () => {
    chainsEl.innerHTML = chips(CHAINS, k => state.chain === k);
    badgesEl.innerHTML = chips(BADGES.filter(b => FILTER_BADGES.includes(b[0])), k => state.badges.includes(k))
      + `<span class="sep"></span><button type="button" class="chip" data-key="hideLowFloat" aria-pressed="${state.hideLowFloat}">Masquer faible flottant</button>`;
  };
  renderChips();
  chainsEl.addEventListener('click', e => {
    const k = e.target.closest('.chip')?.dataset.key;
    if (!k) return;
    state.chain = k;
    update();
  });
  badgesEl.addEventListener('click', e => {
    const k = e.target.closest('.chip')?.dataset.key;
    if (!k) return;
    if (k === 'hideLowFloat') state.hideLowFloat = !state.hideLowFloat;
    else state.badges = state.badges.includes(k) ? state.badges.filter(b => b !== k) : [...state.badges, k];
    update();
  });
  for (const [id, key] of [['f-mcap', 'mcap'], ['f-rev', 'rev'], ['f-sort', 'sort']]) {
    const el = document.getElementById(id);
    el.value = String(state[key]);
    el.addEventListener('change', () => { state[key] = key === 'sort' ? el.value : Number(el.value); update(); });
  }
  document.getElementById('projects-body').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('a')) location.hash = `projet/${tr.dataset.id}`;
  });
  document.getElementById('warnings').innerHTML = (data.warnings || []).map(w => `<p class="warn">⚠ ${esc(w)}</p>`).join('');

  function update() {
    store.set(state);
    renderChips();
    renderTable();
  }
  renderTable();
  renderResume();
}

function renderTable() {
  const list = filtered();
  const shown = list.slice(0, TOP);
  const c = data.counts || {};
  document.getElementById('count').textContent = list.length
    ? `${shown.length} projets affichés sur ${list.length} qui passent les filtres · ${data.projects.length} analysés en détail parmi ${c.total ?? '?'} protocoles`
    : '';
  document.getElementById('projects-body').innerHTML = shown.length ? shown.map((p, i) => `
    <tr data-id="${esc(p.id)}">
      <td class="l n muted">${i + 1}</td>
      <td class="l name"><a href="#projet/${esc(p.id)}">${esc(p.name)}</a><small>${esc(p.symbol || '')}</small><br><span class="muted" style="font-size:12px">${esc(p.category || '')} · ${esc(p.chains.slice(0, 2).join(', '))}${p.chainsTotal > 2 ? ` +${p.chainsTotal - 2}` : ''}</span></td>
      <td class="l">${sparkline(p.series)}</td>
      <td class="n"><span class="score"><i style="--w:${p.score}%"></i>${p.score}</span></td>
      <td class="n">${money(p.mcap)}</td>
      <td class="n">${money(p.revenue30d)}</td>
      <td class="n">${pct(p.revenueGrowth)}</td>
      <td class="n">${pct(p.tvlGrowth)}</td>
      <td class="n">${p.psRatio === null ? '—' : `${fmt(p.psRatio, p.psRatio < 10 ? 1 : 0)}×`}</td>
      <td class="n ${p.badges.lowFloat ? 'down' : ''}">${p.float === null ? '—' : `${fmt(p.float * 100, 0)} %`}</td>
      <td class="l"><span class="tags">${badges(p)}</span></td>
    </tr>`).join('')
    : '<tr><td colspan="11"><div class="empty">Aucun projet ne correspond à ces filtres. Retire un filtre pour élargir la recherche.</div></td></tr>';
}

function renderResume() {
  const top = data.projects.slice(0, TOP);
  document.getElementById('resume-projects').innerHTML = top.slice(0, 5).map((p, i) => `
    <a class="row" href="#projet/${esc(p.id)}"><span class="t">${i + 1}. ${esc(p.name)}</span><span class="d">${money(p.revenue30d)}/mois · MC ${money(p.mcap)}</span><span class="r">${pct(p.revenueGrowth)}</span></a>`).join('')
    || '<div class="soon">Aucun projet pour le moment.</div>';

  const picks = [];
  const used = new Set();
  const add = (p, k, why) => { if (p && !used.has(p.id)) { used.add(p.id); picks.push({ p, k, why }); } };
  const first = list => list.find(p => !used.has(p.id));
  top.filter(p => p.isNew).slice(0, 2).forEach(p => add(p, 'NOUVEAU DANS LE TOP', `Entré dans le top 25 avec un score de ${p.score}. Revenus ${money(p.revenue30d)} sur 30 jours.`));
  const acc = first(top.filter(p => p.badges.accelerating).sort((a, b) => (b.revenueGrowth ?? 0) - (a.revenueGrowth ?? 0)));
  add(acc, 'REVENUS QUI ACCÉLÈRENT', acc && `Revenus ${pctText(acc.revenueGrowth)} sur 30 jours, et la dernière semaine est encore plus forte.`);
  const bb = first(top.filter(p => p.badges.buyback).sort((a, b) => b.holdersShare - a.holdersShare));
  add(bb, 'BUYBACK', bb && `${fmt(bb.holdersShare * 100, 0)} % des revenus reversés aux détenteurs du token (${money(bb.holdersRevenue30d)} sur 30 jours).`);
  const cheap = first(top.filter(p => p.psRatio !== null && (p.revenueGrowth ?? 0) > 0).sort((a, b) => a.psRatio - b.psRatio));
  add(cheap, 'LE MOINS CHER DU TOP', cheap && `Valorisé ${fmt(cheap.psRatio, 1)}× ses revenus annuels, avec des revenus en hausse.`);
  document.getElementById('focus').innerHTML = picks.slice(0, 4).map(({ p, k, why }) => `
    <a class="card" href="#projet/${esc(p.id)}"><span class="k">${k}</span>
      <span class="hd"><b>${esc(p.name)}</b><span class="mono muted">${esc(p.symbol || '')}</span>${badges(p, { short: true })}</span>
      <span class="why">${why}</span></a>`).join('')
    || '<div class="card"><span class="why">Rien de particulier à signaler pour le moment.</span></div>';
}

const pctText = r => (r === null || r === undefined ? '—' : `${r >= 0 ? '+' : ''}${fmt(r * 100, 0)} %`);

export function renderProject(id) {
  const el = document.getElementById('project-detail');
  const p = data?.projects.find(x => x.id === id);
  if (!p) {
    el.innerHTML = '<div class="box"><div class="empty">Ce projet n\'est plus dans la sélection. Il a peut-être été listé sur Binance ou dépassé 1 Md$ de market cap.</div></div>';
    return;
  }
  const row = (k, v, cls = '') => `<dt>${k}</dt><dd class="${cls}">${v}</dd>`;
  const parts = p.scoreParts;
  const link = (url, label, cls = '') => (safeUrl(url) ? `<a class="${cls}" href="${safeUrl(url)}" target="_blank" rel="noopener">${label}</a>` : '');
  const buy = p.links.okx ? link(p.links.okx, 'Acheter sur OKX', 'buy') : link(`${p.links.coingecko}#markets`, "Voir où l'acheter (DEX)", 'buy');
  const news = newsForProject(p.id);
  el.innerHTML = `
    <div class="ph"><h1>${esc(p.name)}</h1><span class="mono muted">${esc(p.symbol || '')}</span>
      <span class="tag">${esc(p.category || '')}</span><span class="tags">${badges(p)}</span></div>
    <p class="sub">${esc(p.chains.join(', '))}${p.chainsTotal > p.chains.length ? ` et ${p.chainsTotal - p.chains.length} autres` : ''} · n°${p.rank} au classement général</p>
    <div class="nfa">⚠ Ceci n'est pas un conseil financier. Fais tes propres recherches avant tout investissement.</div>
    <div class="detail">
      <div class="stack">
        <div class="box"><h2>Revenus quotidiens · 90 jours <span class="muted" style="font-weight:400;font-size:12px">ligne = moyenne 7 jours</span></h2>
          <div class="chart">${p.series.length ? '<canvas id="rev-chart" role="img" aria-label="Revenus quotidiens sur 90 jours"></canvas>' : '<div class="empty">Historique des revenus indisponible.</div>'}</div></div>
        <div class="box"><h2>Pourquoi ce score : ${p.score}/100</h2><div class="why-score">
          <div class="bar-row"><span>Revenus · 50 %</span><i style="--w:${parts.revenue}%"></i><span class="num">${parts.revenue}</span>
            <p>${money(p.revenue30d)} sur 30 jours, soit ${money(p.revenueAnnualized)} par an. Plus que ${parts.revenue} % des projets analysés.</p></div>
          <div class="bar-row"><span>Croissance · 30 %</span><i style="--w:${parts.growth}%"></i><span class="num">${parts.growth}</span>
            <p>Revenus ${pctText(p.revenueGrowth)} et TVL ${pctText(p.tvlGrowth)} sur 30 jours.</p></div>
          <div class="bar-row"><span>Valorisation · 20 %</span><i style="--w:${parts.valuation}%"></i><span class="num">${parts.valuation}</span>
            <p>${p.psRatio === null ? 'Valorisation inconnue.' : `Le marché valorise le projet ${fmt(p.psRatio, 1)}× ses revenus annuels. Moins cher que ${parts.valuation} % des projets analysés.`}</p></div>
        </div></div>
      </div>
      <div class="stack">
        <div class="box"><h2>Chiffres clés</h2><dl>
          ${row('Prix', `${price(p.price)} $ ${p.change24h === null ? '' : pct(p.change24h, false)}`)}
          ${row('Market cap', money(p.mcap))}
          ${row('Valorisation diluée', money(p.fdv))}
          ${row('Volume 24h', money(p.volume24h))}
          ${row('Revenu 30 j', money(p.revenue30d))}
          ${row('Croissance revenus', pct(p.revenueGrowth))}
          ${row('TVL', money(p.tvl))}
          ${row('Croissance TVL', pct(p.tvlGrowth))}
          ${row('MC / revenu', p.psRatio === null ? '—' : `${fmt(p.psRatio, 1)}×`)}
          ${row('Flottant', p.float === null ? '—' : `${fmt(p.float * 100, 0)} %${p.badges.lowFloat ? ' · risque de dilution' : ''}`, p.badges.lowFloat ? 'down' : '')}
          ${row('Buyback', p.badges.buyback ? `Oui · ${fmt(p.holdersShare * 100, 0)} % des revenus` : 'Non', p.badges.buyback ? 'up' : '')}
        </dl></div>
        ${news.length ? `<div class="box"><h2>News récentes <a href="#actu">Actu →</a></h2>${newsRows(news)}</div>` : ''}
        <div class="box"><h2>Investisseurs</h2><dl>
          ${p.investors.length ? row('Fonds', esc(p.investors.join(', ')) + (p.investorsTotal > p.investors.length ? ` et ${p.investorsTotal - p.investors.length} autres` : ''), 'txt') : row('Fonds', 'Aucune levée connue', 'txt')}
          ${row('Total levé', money(p.raisedUsd))}
        </dl></div>
        <div class="box"><h2>Liens</h2><div class="links">
          ${buy}
          ${link(p.links.site, 'Site')}
          ${link(p.links.twitter, 'X')}
          ${link(p.links.defillama, 'DefiLlama')}
          ${link(p.links.coingecko, 'CoinGecko')}
        </div></div>
      </div>
    </div>`;
  const canvas = document.getElementById('rev-chart');
  if (canvas) revenueChart(canvas, p.series, p.seriesStart);
}
