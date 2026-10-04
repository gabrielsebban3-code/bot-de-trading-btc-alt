// Onglet Impôts (#impots, Premium) : où en est ton portefeuille crypto, combien d'impôt pour chaque année et les
// chiffres à recopier dans le formulaire 2086. Les opérations restent sur l'appareil (rien n'est envoyé).
// Sans Premium : la page montre un exemple, sans pouvoir ajouter ses propres opérations.
import { esc, fmt } from './format.js';
import { isPremium, onTier, premiumBox } from './premium.js';
import { EXEMPT, STABLES, TYPES, compute, dcaOps, importFile, makePriceAt, normalizeOp, rates, standing, yearOf, yearSummary, years } from './fiscal-lib.js';

const $ = id => document.getElementById(id);
const DAY = 86_400_000;
const STORE = 'dinexo-impots';
const MODES = [['un', 'Un par un', 'un achat ou une vente'], ['dca', 'Mode DCA', 'achats réguliers'], ['import', 'Importer', 'fichier Binance, Coinbase']];
const SRC = { manuel: 'saisi', dca: 'DCA', binance: 'Binance', coinbase: 'Coinbase', exemple: 'exemple' };

const prices = { index: null, series: new Map(), usdEur: null, loading: null };
const state = { mode: 'un', type: 'achat', year: null, every: 'mois', dcaAsset: 'BTC', all: false, pending: null, open: null, clear: false, msg: '' };
let mine = load();
let example = null;

function load() {
  try { return (JSON.parse(localStorage.getItem(STORE))?.ops || []).map(normalizeOp).filter(Boolean); } catch { return []; }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ ops: mine })); } catch { state.msg = 'Impossible d\'enregistrer sur cet appareil (stockage plein ou bloqué).'; }
}

const eur = (n, d = 0) => (n == null ? '—' : `${fmt(n, d)} €`);
const qty = q => fmt(q, q >= 100 ? 2 : q >= 1 ? 4 : 8).replace(/(,\d*?)0+$/, '$1').replace(/,$/, '');
const day = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const isoDay = t => new Date(t).toISOString().slice(0, 10);
const noon = s => (s ? Date.parse(`${s}T12:00:00Z`) : NaN);
const signed = n => `<b class="${n > 0 ? 'up' : n < 0 ? 'down' : ''}">${n > 0 ? '+' : ''}${eur(n)}</b>`;

// ---------- Prix ----------

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function loadPrices(symbols) {
  if (!prices.index) {
    prices.loading ??= getJson('data/prix/index.json').then(ix => { prices.index = ix; prices.usdEur = ix.usdEur; }).catch(() => { prices.index = { coins: [] }; });
    await prices.loading;
  }
  const known = new Set(prices.index.coins.map(c => c.symbol));
  const todo = [...new Set(symbols)].filter(s => known.has(s) && !prices.series.has(s));
  await Promise.all(todo.map(s => getJson(`data/prix/${s}.json`).then(d => prices.series.set(s, d)).catch(() => prices.series.set(s, null))));
}

const priceAt = (a, t) => makePriceAt(prices.series, prices.usdEur)(a, t);
const priceNow = a => priceAt(a, Date.now());
const knownCoins = () => (prices.index?.coins || []).map(c => c.symbol);

// Exemple montré sans Premium : 100 € de BTC chaque mois depuis début 2023, un achat d'ETH, une vente en 2025.
function buildExample() {
  const from = Date.UTC(2023, 0, 5, 12);
  const { ops } = dcaOps({ asset: 'BTC', eur: 100, every: 'mois', from, feePct: 1 }, priceAt);
  const ethDay = Date.UTC(2024, 2, 12, 12), sellDay = Date.UTC(2025, 2, 3, 12);
  const pEth = priceAt('ETH', ethDay), pSell = priceAt('BTC', sellDay);
  const list = ops.map(o => ({ ...o, src: 'exemple' }));
  if (pEth) list.push({ id: 'ex-eth', date: ethDay, type: 'achat', asset: 'ETH', qty: Number((1000 / pEth).toPrecision(6)), eur: 1000, fee: 0, src: 'exemple' });
  if (pSell) list.push({ id: 'ex-sell', date: sellDay, type: 'vente', asset: 'BTC', qty: Number((1500 / pSell).toPrecision(6)), eur: 1500, fee: 0, src: 'exemple' });
  return list.map(normalizeOp).filter(Boolean);
}

const ops = () => (isPremium() ? mine : example || []);

// ---------- Page ----------

export async function renderImpots() {
  const el = $('impots');
  if (!el) return;
  if (!prices.index) el.innerHTML = '<div class="box"><div class="empty">Chargement des prix…</div></div>';
  await loadPrices(['BTC', 'ETH', ...mine.flatMap(o => [o.asset, o.to].filter(Boolean))]);
  if (!example) example = buildExample();
  draw();
}

function draw() {
  const el = $('impots');
  const list = ops();
  const res = compute(list, priceAt);
  const st = standing(res, priceNow);
  const ys = years(res.cessions);
  const thisYear = yearOf(Date.now());
  if (!ys.includes(thisYear)) ys.unshift(thisYear);
  // Par défaut, la dernière année où il y a eu des ventes.
  if (!ys.includes(state.year)) state.year = ys.find(y => res.cessions.some(c => yearOf(c.date) === y)) ?? thisYear;
  const sum = yearSummary(res.cessions, state.year);
  el.innerHTML = `
    ${isPremium() ? '' : premiumBox('Voici un exemple : 100 € de bitcoin chaque mois depuis 2023, un achat d\'ether et une vente. Avec Premium, tu entres tes propres achats et ventes, sur toutes tes plateformes.')}
    ${state.msg ? `<p class="warn">${esc(state.msg)}</p>` : ''}
    <div class="detail fi-top">
      <div class="stack">${standingBox(st)}${addBox()}</div>
      <div class="stack">${yearBox(sum, ys, res)}</div>
    </div>
    ${opsBox(list, res)}
    ${howBox()}`;
}

function standingBox(st) {
  const r = rates(yearOf(Date.now()));
  const rows = st.lines.map(l => `<tr><td class="l"><b class="mono">${esc(l.asset)}</b></td><td class="n">${qty(l.qty)}</td>
    <td class="n">${l.price == null ? '<span class="muted">inconnu</span>' : eur(l.price, l.price >= 1000 ? 0 : l.price >= 10 ? 2 : 4)}</td><td class="n">${eur(l.value)}</td></tr>`).join('');
  return `<div class="box"><h2>Où tu en es aujourd'hui</h2>
    <div class="fi-kpis">
      <div><span>Valeur de ton portefeuille</span><b>${eur(st.value)}</b></div>
      <div><span>Ce que tu as payé</span><b>${eur(st.base)}</b></div>
      <div><span>Gain si tu vendais tout</span>${signed(st.gain)}</div>
      <div><span>Impôt si tu vendais tout</span><b>${eur(st.taxIfSold)}</b><small>${fmt(r.total, 1)} % du gain</small></div>
    </div>
    ${rows ? `<div class="wrap flat"><table class="static"><thead><tr><th class="l">Crypto</th><th>Quantité</th><th>Prix</th><th>Valeur</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="soon">Aucune crypto pour le moment : ajoute tes achats ci-dessous.</div>'}
    ${st.missing.length ? `<p class="t-note warn-inline">Prix inconnu pour ${st.missing.map(esc).join(', ')} : leur valeur n'est pas comptée.</p>` : ''}
    <p class="t-note">« Ce que tu as payé » : le prix d'achat de tes cryptos, moins la part déjà comptée dans tes ventes passées. Prix du jour mis à jour toutes les heures.</p></div>`;
}

function yearBox(s, ys, res) {
  const chips = ys.map(y => `<button type="button" class="chip" data-fy="${y}" aria-pressed="${y === s.year}">${y}</button>`).join('');
  const lines = s.list.map(c => cessionRow(c)).join('');
  let verdict;
  if (!s.list.length) verdict = `<p class="txt">Aucune vente en ${s.year} : rien à payer. Échanger une crypto contre une autre ne compte pas.</p>`;
  else if (s.exempt) verdict = `<p class="txt"><b class="up">Rien à payer.</b> Tes ventes de ${s.year} font ${eur(s.sales)}, sous le seuil de ${EXEMPT} € par an.</p>`;
  else if (s.gain <= 0) verdict = `<p class="txt"><b>Rien à payer.</b> Tu es en perte de ${eur(-s.gain)} sur tes ventes de ${s.year}. Cette perte se déclare, mais ne se reporte pas sur les années suivantes.</p>`;
  else verdict = `<p class="txt">Gain sur tes ventes de ${s.year} : <b class="up">${eur(s.gain)}</b>. Il est imposé à ${fmt(s.rates.total, 1)} % : ${fmt(s.rates.ir, 1)} % d'impôt sur le revenu et ${fmt(s.rates.ps, 1)} % de prélèvements sociaux.</p>`;
  return `<div class="box fi-year"><h2>Impôt sur tes ventes</h2>
    <div class="tools fi-years" role="group" aria-label="Année">${chips}</div>
    <div class="t-hero"><span class="k">À payer pour ${s.year}</span><b>${eur(s.tax)}</b>
      <span class="s">${s.list.length} vente${s.list.length > 1 ? 's' : ''} · ${eur(s.sales)} encaissés</span></div>
    ${verdict}
    ${s.box ? `<div class="fi-box"><span>À reporter sur ta déclaration (formulaire 2042 C)</span><b>Case ${s.box.key} : ${fmt(s.box.value)} €</b>
      <small>${s.box.key === '3AN' ? 'Plus-value' : 'Moins-value'}, après avoir rempli un formulaire 2086 avec le détail de chaque vente ci-dessous.</small></div>` : ''}
    ${s.estimated ? '<p class="t-note warn-inline">Une vente au moins utilise une valeur de portefeuille estimée (prix inconnu pour une de tes cryptos) : ouvre-la pour saisir la vraie valeur.</p>' : ''}
    ${lines ? `<div class="fi-cessions">${lines}</div>` : ''}
    ${res.warnings.length ? `<p class="t-note warn-inline">${res.warnings.length} opération${res.warnings.length > 1 ? 's vendent' : ' vend'} plus que ce que tu détiens : il manque sans doute un achat (voir « Mes opérations »).</p>` : ''}
    <p class="t-note">Tes comptes sur des plateformes à l'étranger (Binance, Coinbase…) se déclarent aussi chaque année avec le formulaire 3916-bis, même sans vente.</p></div>`;
}

const L = [
  ['211', 'Date de la cession', c => day(c.date)],
  ['212', 'Valeur globale du portefeuille au moment de la cession', c => eur(c.l212)],
  ['213', 'Prix de cession', c => eur(c.l213)],
  ['214', 'Frais de cession', c => eur(c.l214)],
  ['215', 'Prix de cession net des frais', c => eur(c.l215)],
  ['216', 'Soulte reçue ou versée', () => '0 €'],
  ['217', 'Prix de cession net des soultes', c => eur(c.l217)],
  ['218', 'Prix de cession net des frais et soultes', c => eur(c.l218)],
  ['220', 'Prix total d\'acquisition', c => eur(c.l220)],
  ['221', 'Fractions de capital initial déjà imputées', c => eur(c.l221)],
  ['222', 'Soultes reçues lors d\'échanges antérieurs', () => '0 €'],
  ['223', 'Prix total d\'acquisition net', c => eur(c.l223)],
  ['224', 'Plus-value ou moins-value', c => signed(c.l224)],
];

function cessionRow(c) {
  const open = state.open === c.id;
  const manual = isPremium() ? `<form class="fi-fix" data-fix="${esc(c.id)}"><label for="fix-${esc(c.id)}">Valeur réelle de tout ton portefeuille ce jour-là</label>
    <span class="field"><span class="t-in"><input id="fix-${esc(c.id)}" name="v" inputmode="decimal" autocomplete="off" value="${c.manual ? fmt(c.l212, 2) : ''}" placeholder="${fmt(c.l212, 0)}"><span class="u">€</span></span><button class="btn">Enregistrer</button></span></form>` : '';
  return `<div class="fi-c${open ? ' on' : ''}">
    <button type="button" class="fi-ch" data-open="${esc(c.id)}" aria-expanded="${open}"><span>${day(c.date)} · vente de ${qty(c.qty)} ${esc(c.asset)}</span>
      <span class="num">${eur(c.l213)}</span>${signed(c.l224)}${c.estimated ? '<span class="tag mid">estimé</span>' : ''}</button>
    ${open ? `<div class="fi-cd"><p class="t-note">À recopier dans le formulaire 2086, une colonne par vente :</p>
      <dl class="fi-2086">${L.map(([n, label, v]) => `<dt><b class="mono">${n}</b> ${label}</dt><dd class="num">${v(c)}</dd>`).join('')}</dl>
      ${c.estimated ? `<p class="t-note warn-inline">Prix inconnu ce jour-là pour ${c.missing.map(esc).join(', ')} : la valeur du portefeuille (ligne 212) est incomplète.</p>` : ''}
      ${manual}</div>` : ''}
  </div>`;
}

function addBox() {
  if (!isPremium()) return '';
  const m = state.mode;
  return `<div class="box t-form fi-add"><h2>Ajouter des opérations</h2>
    <div class="t-modes fi-modes" role="group" aria-label="Façon d'ajouter">${MODES.map(([v, l, s]) =>
      `<button type="button" data-fm="${v}" aria-pressed="${m === v}"><b>${l}</b><span>${s}</span></button>`).join('')}</div>
    ${m === 'un' ? oneForm() : m === 'dca' ? dcaForm() : importForm()}</div>`;
}

const field = (id, label, attrs = '', unit = '', hint = '') => `<label class="t-field" for="${id}"><span class="lb">${label}</span>
  <span class="t-in"><input id="${id}" name="${id.replace('fi-', '')}" autocomplete="off" spellcheck="false" ${attrs}>${unit ? `<span class="u">${unit}</span>` : ''}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;

function oneForm() {
  const t = state.type;
  const coins = `<datalist id="fi-coins">${[...knownCoins(), ...STABLES].map(s => `<option value="${s}">`).join('')}</datalist>`;
  return `<form class="t-fields" id="fi-one">
    <div class="t-field t-wide"><span class="lb">Type</span><div class="tools" role="group" aria-label="Type d'opération">${Object.entries(TYPES).map(([k, l]) =>
      `<button type="button" class="chip" data-ft="${k}" aria-pressed="${t === k}">${l}</button>`).join('')}</div>
      <span class="hint">${{ achat: 'Tu as payé des euros pour recevoir une crypto.', vente: 'Tu as reçu des euros (ou payé un achat) avec une crypto.', echange: 'Une crypto contre une autre (par exemple BTC contre USDT) : pas d\'impôt.', recompense: 'Staking, airdrop, récompense reçue gratuitement.' }[t]}</span></div>
    ${field('fi-date', 'Date', `type="date" value="${isoDay(Date.now())}" max="${isoDay(Date.now())}"`)}
    ${field('fi-asset', t === 'echange' ? 'Crypto donnée' : 'Crypto', 'list="fi-coins" autocapitalize="characters" maxlength="15" placeholder="BTC"')}
    ${field('fi-qty', t === 'echange' ? 'Quantité donnée' : 'Quantité', 'inputmode="decimal" placeholder="0,01"')}
    ${t === 'achat' || t === 'vente' ? field('fi-eur', t === 'achat' ? 'Montant payé' : 'Montant reçu', 'inputmode="decimal" placeholder="500"', '€') : ''}
    ${t === 'achat' || t === 'vente' ? field('fi-fee', 'Frais', 'inputmode="decimal" placeholder="0"', '€', 'facultatif') : ''}
    ${t === 'echange' ? field('fi-to', 'Crypto reçue', 'list="fi-coins" autocapitalize="characters" maxlength="15" placeholder="ETH"') + field('fi-toqty', 'Quantité reçue', 'inputmode="decimal" placeholder="0,2"') : ''}
    ${t === 'vente' ? field('fi-port', 'Valeur de tout ton portefeuille ce jour-là', 'inputmode="decimal" placeholder="calculée par le site"', '€', 'facultatif : à remplir si tu détiens des cryptos dont le site ne connaît pas le prix') : ''}
    <div class="t-field t-wide"><button class="btn primary">Ajouter</button><span class="msg" id="fi-msg" role="status"></span></div>
    ${coins}</form>`;
}

function dcaForm() {
  const coins = knownCoins();
  const p = state.pending?.kind === 'dca' ? state.pending : null;
  return `<form class="t-fields" id="fi-dca">
    <div class="t-field t-wide"><span class="lb">Crypto</span><div class="tools" role="group" aria-label="Crypto achetée">${coins.slice(0, 12).map(s =>
      `<button type="button" class="chip" data-fa="${s}" aria-pressed="${state.dcaAsset === s}">${s}</button>`).join('')}</div></div>
    ${field('fi-amount', 'Montant de chaque achat', 'inputmode="decimal" value="100"', '€')}
    <div class="t-field"><span class="lb">Tous les</span><div class="tools" role="group" aria-label="Fréquence">${[['jour', 'jours'], ['semaine', 'semaines'], ['mois', 'mois']].map(([v, l]) =>
      `<button type="button" class="chip" data-fe="${v}" aria-pressed="${state.every === v}">${l}</button>`).join('')}</div></div>
    ${field('fi-from', 'Depuis le', `type="date" value="${isoDay(Date.UTC(new Date().getUTCFullYear() - 1, 0, 1))}" max="${isoDay(Date.now())}"`)}
    ${field('fi-until', 'Jusqu\'au', `type="date" value="${isoDay(Date.now())}" max="${isoDay(Date.now())}"`)}
    ${field('fi-feepct', 'Frais de la plateforme', 'inputmode="decimal" value="0"', '%', 'facultatif, par exemple 1,49 sur Coinbase')}
    <div class="t-field t-wide"><button class="btn">Calculer les achats</button><span class="msg" id="fi-msg" role="status"></span></div>
    ${p ? `<div class="t-field t-wide fi-pending"><p class="txt"><b>${p.ops.length} achats de ${esc(state.dcaAsset)}</b> pour ${eur(p.ops.reduce((t, o) => t + o.eur + o.fee, 0))}, soit ${qty(p.ops.reduce((t, o) => t + o.qty, 0))} ${esc(state.dcaAsset)} au prix de chaque jour.${p.skipped ? ` ${p.skipped} date${p.skipped > 1 ? 's' : ''} sans prix connu, sautée${p.skipped > 1 ? 's' : ''}.` : ''}</p>
      <div class="links"><button type="button" class="btn primary" data-fadd>Ajouter ces ${p.ops.length} achats</button><button type="button" class="btn" data-fcancel>Annuler</button></div></div>` : ''}
  </form>`;
}

function importForm() {
  const p = state.pending?.kind === 'import' ? state.pending : null;
  return `<div class="t-fields">
    <div class="t-field t-wide"><p class="txt fi-help"><b>Binance</b> : Portefeuille → Historique des transactions → Exporter, puis choisis « Historique des transactions » (fichier CSV).<br>
      <b>Coinbase</b> : Profil → Relevés → Générer un relevé, format CSV.<br>
      Le fichier est lu sur ton appareil, rien n'est envoyé. Importe un fichier par plateforme.</p>
      <label class="btn fi-file" for="fi-file">Choisir un fichier CSV</label><input type="file" id="fi-file" accept=".csv,text/csv" hidden>
      <span class="msg" id="fi-msg" role="status"></span></div>
    ${p ? `<div class="t-field t-wide fi-pending"><p class="txt">${importText(p)}</p>
      ${p.skipped.length ? `<details class="fi-skip"><summary>Voir les lignes non reconnues</summary><ul>${p.skipped.slice(0, 30).map(s => `<li class="mono">${esc(s)}</li>`).join('')}</ul></details>` : ''}
      <div class="links"><button type="button" class="btn primary" data-fadd ${p.ops.length ? '' : 'disabled'}>Ajouter ces opérations</button><button type="button" class="btn" data-fcancel>Annuler</button></div></div>` : ''}
  </div>`;
}

function importText(p) {
  const name = p.format === 'binance' ? 'Binance' : 'Coinbase';
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  const kinds = Object.entries(TYPES).map(([k, l]) => [l.toLowerCase(), p.ops.filter(o => o.type === k).length]).filter(([, n]) => n).map(([l, n]) => plural(n, l)).join(', ');
  const skipped = p.skipped.length ? ` ${plural(p.skipped.length, 'ligne')} non reconnue${p.skipped.length > 1 ? 's' : ''}, à ajouter à la main si besoin.` : '';
  if (!p.ops.length && p.dupes) return `Ce fichier ${name} est déjà importé : ses ${p.dupes} opérations sont déjà dans ta liste.${skipped}`;
  if (!p.ops.length) return `Aucune opération reconnue dans ce fichier ${name}.${skipped}`;
  return `<b>${plural(p.ops.length, 'opération')} trouvée${p.ops.length > 1 ? 's' : ''}</b> dans le fichier ${name} : ${kinds}.${p.dupes ? ` ${p.dupes} déjà dans ta liste, pas ajoutée${p.dupes > 1 ? 's' : ''} une deuxième fois.` : ''}${skipped}`;
}

function opsBox(list, res) {
  const warn = new Set(res.warnings.map(w => w.id));
  const sorted = [...list].sort((a, b) => b.date - a.date);
  const shown = state.all ? sorted : sorted.slice(0, 30);
  // Sur mobile, le type passe sous la date et la quantité peut aller à la ligne avant le symbole.
  const what = o => (o.type === 'echange' ? `<span class="nw">${qty(o.qty)} ${esc(o.asset)}</span> → <span class="nw">${qty(o.toQty)} ${esc(o.to)}</span>` : `<span class="nw">${qty(o.qty)}</span> ${esc(o.asset)}`);
  const tag = o => `<span class="tag ${o.type === 'vente' ? 'down' : o.type === 'achat' ? 'up' : ''}">${TYPES[o.type]}</span>`;
  const rows = shown.map(o => `<tr${warn.has(o.id) ? ' class="fi-bad" title="Plus vendu que détenu à cette date"' : ''}><td class="l">${day(o.date)}<span class="fi-tm">${tag(o)}</span></td>
    <td class="l">${tag(o)}</td><td class="l mono">${what(o)}</td>
    <td class="n">${o.eur == null ? '—' : eur(o.eur + (o.type === 'achat' ? o.fee : 0), 2)}</td><td class="l muted">${SRC[o.src] || esc(o.src)}</td>
    <td class="n">${isPremium() ? `<button type="button" class="t-del" data-fdel="${esc(o.id)}" aria-label="Supprimer cette opération">×</button>` : ''}</td></tr>`).join('');
  return `<h2 class="section">${isPremium() ? 'Mes opérations' : 'Opérations de l\'exemple'} <span class="muted">${list.length}</span></h2>
    <div class="wrap"><table class="static fi-ops"><thead><tr><th class="l">Date</th><th class="l">Type</th><th class="l">Crypto</th><th>Euros</th><th class="l">Source</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6"><div class="empty">Aucune opération. Ajoute ton premier achat avec le bloc « Ajouter des opérations ».</div></td></tr>'}</tbody></table></div>
    <div class="links fi-links">${sorted.length > 30 ? `<button type="button" class="btn" data-fall>${state.all ? 'Afficher les 30 dernières' : `Afficher les ${sorted.length}`}</button>` : ''}
      ${isPremium() && list.length ? `<button type="button" class="btn danger" data-fclear>${state.clear ? 'Confirmer : tout effacer' : 'Tout effacer'}</button>` : ''}</div>`;
}

function howBox() {
  return `<div class="box fi-how"><h2>Comment c'est calculé</h2><ol class="t-steps">
    <li><b>Seules les ventes contre des euros comptent</b>Vendre une crypto pour des euros, ou payer un achat avec, est imposable. Échanger une crypto contre une autre (y compris contre un stablecoin comme l'USDT) ne l'est pas.</li>
    <li><b>Le gain d'une vente</b>Ce que tu as reçu, moins la part de ton prix d'achat total qui correspond à cette vente. Cette part = prix d'achat restant × montant vendu ÷ valeur de tout ton portefeuille ce jour-là. C'est la formule officielle du formulaire 2086 (ligne 224).</li>
    <li><b>L'impôt de l'année</b>On additionne les gains et les pertes de toutes les ventes de l'année. Si le résultat est un gain, il est taxé à 31,4 % (30 % pour les ventes faites avant 2025). Si tes ventes de l'année ne dépassent pas 305 €, rien n'est dû.</li>
    <li><b>Une autre option</b>Tu peux choisir d'être imposé au barème de l'impôt sur le revenu à la place des 31,4 % (case 3CN), ce qui peut être moins cher si tu paies peu d'impôt.</li>
  </ol><p class="t-note">C'est une estimation pour t'aider à préparer ta déclaration, pas un conseil fiscal. Les règles sont celles des particuliers qui investissent de temps en temps ; si le trading est ton métier, d'autres règles s'appliquent. Vérifie sur impots.gouv.fr ou avec un conseiller.</p></div>`;
}

// ---------- Actions ----------

function setMsg(text) { const m = $('fi-msg'); if (m) m.textContent = text; }

function addOps(list) {
  const ids = new Set(mine.map(o => o.id));
  mine = [...mine, ...list.filter(o => !ids.has(o.id))];
  save();
}

// Empreinte d'une opération importée : un même fichier importé deux fois n'ajoute rien.
const print = o => `${o.src}|${o.date}|${o.type}|${o.asset}|${o.qty}|${o.eur ?? ''}|${o.to ?? ''}`;

async function onFile(file) {
  if (!file) return;
  if (file.size > 20_000_000) { setMsg('Fichier trop gros (plus de 20 Mo).'); return; }
  const text = await file.text();
  const r = importFile(text);
  if (!r.format) { setMsg('Format non reconnu : il faut l\'historique des transactions en CSV de Binance ou de Coinbase.'); return; }
  const have = new Set(mine.map(print));
  const fresh = r.ops.map(o => ({ ...o, id: `${r.format}-${o.date.toString(36)}-${Math.random().toString(36).slice(2, 7)}` })).filter(o => !have.has(print(o)));
  state.pending = { kind: 'import', format: r.format, ops: fresh, skipped: r.skipped, dupes: r.ops.length - fresh.length };
  draw();
}

const page = () => $('page-impots');

document.addEventListener('click', async e => {
  if (!page()?.contains(e.target)) return;
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.fy) { state.year = Number(d.fy); state.open = null; }
  else if (d.open) state.open = state.open === d.open ? null : d.open;
  else if (d.fm) { state.mode = d.fm; state.pending = null; }
  else if (d.ft) state.type = d.ft;
  else if (d.fa) { state.dcaAsset = d.fa; state.pending = null; }
  else if (d.fe) { state.every = d.fe; state.pending = null; }
  else if (d.fall !== undefined) state.all = !state.all;
  else if (d.fdel) { mine = mine.filter(o => o.id !== d.fdel); save(); }
  else if (d.fclear !== undefined) {
    if (!state.clear) { state.clear = true; draw(); setTimeout(() => { state.clear = false; if (page()?.classList.contains('on')) draw(); }, 5000); return; }
    mine = []; state.clear = false; save();
  } else if (d.fadd !== undefined && state.pending) {
    const sales = state.pending.ops.filter(o => o.type === 'vente');
    if (sales.length) state.year = Math.max(...sales.map(o => yearOf(o.date))); // on montre l'impôt de la dernière vente ajoutée
    addOps(state.pending.ops);
    state.pending = null;
    await loadPrices(mine.flatMap(o => [o.asset, o.to].filter(Boolean)));
  }
  else if (d.fcancel !== undefined) state.pending = null;
  else return;
  draw();
});

document.addEventListener('submit', async e => {
  if (!page()?.contains(e.target)) return;
  e.preventDefault();
  const f = e.target;
  if (f.id === 'fi-one') {
    const v = n => f.elements[n]?.value ?? '';
    const o = normalizeOp({ date: noon(v('date')), type: state.type, asset: v('asset'), qty: v('qty'), eur: v('eur'), fee: v('fee'), to: v('to'), toQty: v('toqty'), portfolio: v('port'), src: 'manuel' });
    if (!o) { setMsg('Vérifie la date, la crypto, la quantité et le montant.'); return; }
    if (o.date > Date.now() + DAY) { setMsg('La date est dans le futur.'); return; }
    addOps([o]);
    if (o.type === 'vente') state.year = yearOf(o.date);
    await loadPrices([o.asset, o.to].filter(Boolean));
    state.msg = '';
    draw();
    setMsg(`${TYPES[o.type]} de ${qty(o.qty)} ${o.asset} ajouté${o.type === 'vente' || o.type === 'recompense' ? 'e' : ''}.`);
  } else if (f.id === 'fi-dca') {
    await loadPrices([state.dcaAsset]);
    const r = dcaOps({ asset: state.dcaAsset, eur: f.elements.amount.value, every: state.every, from: noon(f.elements.from.value), to: noon(f.elements.until.value), feePct: f.elements.feepct.value }, priceAt);
    if (!r.ops.length) { setMsg('Aucun achat : vérifie le montant et les dates.'); return; }
    state.pending = { kind: 'dca', ...r };
    const keep = { amount: f.elements.amount.value, from: f.elements.from.value, until: f.elements.until.value, feepct: f.elements.feepct.value };
    draw();
    const g = $('fi-dca');
    for (const [k, val] of Object.entries(keep)) g.elements[k].value = val;
  } else if (f.dataset.fix) {
    const id = f.dataset.fix;
    const raw = f.elements.v.value.trim();
    mine = mine.map(o => (o.id === id ? normalizeOp({ ...o, portfolio: raw }) || o : o));
    if (!raw) mine = mine.map(o => (o.id === id ? (({ portfolio, ...rest }) => rest)(o) : o));
    save();
    draw();
  }
});

document.addEventListener('change', e => {
  if (e.target.id === 'fi-file') onFile(e.target.files?.[0]);
});

onTier(() => { if (page()?.classList.contains('on')) renderImpots(); });
