// Onglets Setups et Historique : 3 indicateurs dans le sens de la tendance (9 cryptos et le Brent), fiche détaillée avec graphique, bilan sur 12 mois.
// Catégorie Court terme : mêmes règles, tendance sur bougies de 4 h (data/setups-court.json).
import { ago, esc, fmt } from './format.js';
import { linkedNews, linkedText } from './news.js';
import { watchlist } from './watchlist.js';
import { mountLegs, showLegs } from './jambe.js';
import { journalStats, openRisk } from './journal-lib.js';
import { delayed, historyDays, hoursText, isPremium, onTier, visibleIn } from './premium.js';

const BAR = 4 * 3600_000;
export const OUTCOME = {
  sl: ['Stop touché', 'down'],
  be: ['Moitié prise, reste à l\'entrée', 'up'],
  exit: ['Sortie de tendance', ''],
  open: ['En jeu', 'acc'],
};
export const TREND = { haussière: 'up', baissière: 'down', neutre: '' };

let data = null;
let courtData = null;
const COURT_ON = false;
let projectsBySymbol = new Map();
// Les fonctions d'affichage lisent `data` : on le remplace le temps de dessiner le Court terme.
function withData(d, fn) {
  const keep = data;
  data = d;
  try { return fn(); } finally { data = keep; }
}
const barMs = () => data?.rules?.barMs ?? BAR;
const isCourt = () => data?.model === 'h1h4';
const unitWord = () => (barMs() === 3600_000 ? '1 h' : '4 h');
const state = { detectors: null, kind: 'all', dir: 'all', watch: false, cat: 'setups' };
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

export const dirTag = d => `<span class="tag ${d === 'long' ? 'up' : 'down'}">${d === 'long' ? '▲ Long' : '▼ Short'}</span>`;
export const statusTag = s => `<span class="tag ${s.status === 'confirmé' ? 'acc' : 'mid'}">${s.status === 'confirmé' ? 'Confirmé' : 'En cours'}</span>`;
export const outcomeTag = s => (s.status === 'confirmé' && s.outcome !== 'open' ? `<span class="tag ${outcomeCls(s)}">${OUTCOME[s.outcome][0]}</span>` : '');
const asset = sym => data.assets.find(a => a.symbol === sym) || { symbol: sym, name: sym };
export const okxUrl = sym => `https://www.okx.com/trade-swap/${sym.toLowerCase()}-usdt-swap`;
export const parisDay = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// Résultat en % du capital. Risque de base data.rules.riskPct % du compte, multiplié par la taille du trade (s.sz) :
// on risque plus quand le marché est calme, moins quand il est agité (entre la moitié et le double).
export const cap = (r, s = null) => { const x = r * (data.rules.riskPct ?? 1) * (s?.sz ?? 1); return `${x > 0 ? '+' : ''}${fmt(x, x >= 10 || x <= -10 ? 0 : 1)} %`; };
// Un pourcentage sans zéros inutiles : 0,75 · 1 · 1,5.
export const pctTxt = x => fmt(x, Math.abs(x - Math.round(x)) < 1e-9 ? 0 : Math.abs(x * 10 - Math.round(x * 10)) < 1e-9 ? 1 : 2);
// Risque conseillé pour un trade, en % du capital, et l'état du marché qui l'explique.
export const riskOf = s => (data.rules.riskPct ?? 1) * (s?.sz ?? 1);
export const moodOf = s => ((s?.sz ?? 1) >= 1.2 ? 'marché calme' : (s?.sz ?? 1) <= 0.83 ? 'marché agité' : 'marché normal');
export const baseRiskTxt = () => `risque de base ${pctTxt(data.rules.riskPct ?? 1)} %, ajusté selon l'agitation du marché`;
// Somme des résultats en « R de base » (taille comprise), à passer à cap().
export const sumR = list => Math.round(list.reduce((t, s) => t + s.r * (s.sz ?? 1), 0) * 10) / 10;
export const outcomeCls = s => (s.outcome === 'exit' ? (s.r > 0 ? 'up' : s.r < 0 ? 'down' : '') : OUTCOME[s.outcome][1]);

// Sous 20 trades terminés, un pourcentage de gagnants ne veut rien dire : on donne le nombre et le gain, sans taux.
export const MIN_TRADES = 20;
function winLine(key) {
  const s = data.stats[key];
  if (!s || s.winRate === null) return `${esc(data.detectors[key])} : pas encore assez de trades pour un bilan`;
  if (s.resolved < MIN_TRADES) return `${esc(data.detectors[key])} : ${s.resolved} trade${s.resolved > 1 ? 's' : ''} terminé${s.resolved > 1 ? 's' : ''} sur 12 mois, trop peu pour juger (${cap(s.totalR)} du capital)`;
  return `${esc(data.detectors[key])} : ${fmt(s.winRate * 100, 0)} % de trades gagnants sur ${s.resolved}, ${cap(s.totalR)} du capital sur 12 mois (${baseRiskTxt()})`;
}

export function projectLink(sym) {
  const p = projectsBySymbol.get(sym);
  return p ? `<a class="link" href="#projet/${esc(p.id)}"><b>Projet du top</b> · n°${p.rank} dans Projets</a>` : '';
}

// News importante des dernières 24 h sur l'actif (ou sur tout le marché crypto) : dans le sens du setup ou contre lui.
const newsOf = s => linkedNews(s.symbol, asset(s.symbol).kind || 'crypto');
export function newsLink(s, tag = 'a') {
  const n = newsOf(s);
  if (!n) return '';
  const href = tag === 'a' ? ` href="#actu/${encodeURIComponent(n.item.id)}"` : '';
  return `<${tag} class="link"${href}><b>News liée</b> · ${esc(linkedText(n, s.dir))}</${tag}>`;
}

// Signal pas encore visible sans Premium (SOL et pétrole : 24 h de retard) : carte fermée, sans entrée ni stop.
function lockedCard(s) {
  const a = asset(s.symbol);
  return `<a class="card setup locked" href="#premium">
    <span class="hd"><b class="mono">${esc(s.symbol)}</b><span class="muted">${esc(a.name)}</span><span class="ptag">Premium</span></span>
    <span class="why">Nouveau signal sur ${esc(a.name)}. Il sera visible pour tout le monde dans ${hoursText(visibleIn(s))}.</span>
    <span class="wr">Avec Premium, tu le vois tout de suite, avec le prix d'entrée et le stop.</span>
    <span class="go">Voir Premium →</span>
  </a>`;
}

function card(s, link = true) {
  if (delayed(s)) return lockedCard(s);
  const a = asset(s.symbol);
  const tag = link ? `a class="card setup" href="#setup/${encodeURIComponent(s.id)}"` : 'div class="card setup"';
  return `<${tag}>
    <span class="hd"><b class="mono">${esc(s.symbol)}</b><span class="muted">${esc(a.name)}</span>${dirTag(s.dir)}${statusTag(s)}${outcomeTag(s)}</span>
    <span class="tags"><span class="tag">${esc(data.detectors[s.detector])}</span><span class="tag ${TREND[s.trend]}">Tendance ${isCourt() ? '4h' : '1D'} ${esc(s.trend)}</span>
      <span class="when">${s.status === 'en cours' ? 'bougie en cours' : ago(new Date(s.time + barMs()).toISOString())}</span></span>
    <span class="why">${esc(s.why)}</span>
    <span class="lv"><span><i>Entrée</i>${px(s.entry)}</span><span><i>Stop</i>${px(s.sl)}</span><span><i>Moitié à ${fmt(data.rules.partialR ?? s.rr, 0)}R</i>${px(s.tp[0])}</span>${s.exitAt ? `<span><i>Sortie</i>${px(s.exitAt)}</span>` : `<span><i>R:R</i>1:${fmt(s.rr, 1)}</span>`}</span>
    <span class="sm">Risque conseillé : <b>${pctTxt(Math.round(riskOf(s) * 20) / 20)} % du capital</b> (${moodOf(s)}${s.grosCut ? ', moitié moins car les gros traders étaient déjà très acheteurs' : ''})</span>
    <span class="wr">${winLine(s.detector)}</span>
    ${newsLink(s, 'span')}
  </${link ? 'a' : 'div'}>`;
}

// Radar : une carte par paire, même sans signal. Trade en jeu, sinon le prix qui déclencherait le prochain signal.
// Chaque carte ouvre la fiche de la paire (#paire/<symbole>).
export const plainPct = x => `${x > 0 ? '+' : x < 0 ? '−' : ''}${fmt(Math.abs(x) * 100, 1)} %`;
export const liveOf = sym => data?.live.find(s => s.symbol === sym && s.outcome === 'open') || null;
export const lastTradeOf = sym => data?.history.find(s => s.symbol === sym && s.outcome !== 'open' && !delayed(s)) || null;
export const setupsData = () => data;

// Où en est la paire : trade en jeu, prix de déclenchement, ou attente d'une tendance.
export function radarBody(a) {
  const r = a.radar;
  const live = liveOf(a.symbol);
  if (live && delayed(live)) {
    return `<span class="state"><span class="ptag">Premium</span> <b>Nouveau signal</b> sur ${esc(a.name)}</span>
      <span class="sm">Il sera visible pour tout le monde dans ${hoursText(visibleIn(live))}. Avec Premium, tu le vois tout de suite.</span>`;
  }
  if (live) {
    const move = (a.price - live.entry) / Math.abs(live.entry - live.sl) * (live.dir === 'long' ? 1 : -1);
    const r0 = live.tpHit ? ((data.rules.partialR ?? 5) + move) / 2 : move; // moitié déjà prise à 5R
    return `<span class="state">${dirTag(live.dir)} <b>Trade en cours</b> depuis le ${parisDay(live.time)}</span>
      <span class="sm">Entrée ${px(live.entry)}, stop ${px(live.stop ?? live.sl)}. En ce moment <b class="${r0 >= 0 ? 'up' : 'down'}">${cap(r0, live)}</b> du capital</span>`;
  }
  if (!r) return '<span class="state">Pas assez de données pour le moment.</span>';
  if (r.trend === 'neutre') return `<span class="state">Pas de trade : le marché n'a pas de direction claire.</span>
    <span class="sm">On attend qu'il reparte nettement à la hausse (achats) ou à la baisse (ventes).</span>`;
  const up = r.dir === 'long';
  const word = up ? 'au-dessus de' : 'sous';
  const macd = `le prix repart ${up ? 'à la hausse après une petite baisse' : 'à la baisse après une petite hausse'}`;
  const NAMES = isCourt()
    ? { range20: `${up ? 'plus haut' : 'plus bas'} des 3 derniers jours`, range10: `${up ? 'plus haut' : 'plus bas'} des 40 dernières heures` }
    : { range20: `${up ? 'plus haut' : 'plus bas'} du dernier mois`, range10: `${up ? 'plus haut' : 'plus bas'} des 10 derniers jours` };
  if (r.trigger) {
    const near = Math.max(0, 1 - Math.abs(r.trigger.distance) / 0.1); // plein à 0 %, vide à 10 % ou plus
    return `<span class="state"><b class="${up ? 'up' : 'down'}">${up ? 'Achat' : 'Vente'}</b> si le prix clôture une bougie de ${unitWord()} ${word} <b>${px(r.trigger.price)}</b> (${plainPct(r.trigger.distance)})</span>
      <span class="meter" title="Distance au déclenchement"><i style="width:${Math.round(near * 100)}%"></i></span>
      <span class="sm">C'est son ${NAMES[r.trigger.key] || esc(data.detectors[r.trigger.key])}. Stop prévu vers ${px(r.trigger.stop)} (${plainPct((r.trigger.stop - r.trigger.price) / r.trigger.price)}).${r.macdReady ? ` Le signal peut aussi venir plus tôt si ${macd}.` : ''}</span>
      ${r.trigger.grosCut === 0.5 ? `<span class="sm down">Les gros traders sont déjà très acheteurs (${fmt(r.trigger.gros, 2)} achat pour 1 vente) : cet achat serait pris avec moitié moins de risque.</span>` : ''}
      ${r.trigger.scoreOk === true ? '<span class="sm up">Note du moment : bonne, le signal serait gardé.</span>' : r.trigger.scoreOk === false ? '<span class="sm muted">Note du moment trop basse : pour l\'instant, ce signal serait ignoré.</span>' : ''}`;
  }
  return `<span class="state">Le prix est déjà ${up ? 'au-dessus de ses plus hauts' : 'sous ses plus bas'} ${isCourt() ? 'des derniers jours' : 'du mois'}.</span>
    <span class="sm">Prochain signal quand ${r.macdReady ? macd : `il fera une petite ${up ? 'baisse' : 'hausse'} puis repartira`}, s'il n'y a pas d'obstacle juste devant.</span>`;
}

function radarCard(a, link = true) {
  const r = a.radar;
  const last = lastTradeOf(a.symbol);
  const head = `<span class="hd"><b class="mono">${esc(a.symbol)}</b><span class="muted">${esc(a.name)}</span>
    ${r ? `<span class="tag ${TREND[r.trend]}">Tendance ${esc(r.trend)}</span>` : ''}<span class="px">${px(a.price)}</span></span>`;
  const g = a.ctx?.gros;
  const grosLine = g && r?.trend !== 'neutre' && !liveOf(a.symbol) && r?.trigger?.grosCut !== 0.5 ? `<span class="sm">Gros traders : ${fmt(g, 2)} achat pour 1 vente${g >= (data.rules.grosMax ?? 1.65) ? ' <b class="down">(déjà très acheteurs)</b>' : ''}</span>` : '';
  const lastLine = grosLine + (last ? `<span class="sm">Dernier trade : ${esc(OUTCOME[last.outcome][0].toLowerCase())} le ${parisDay(last.at)} (${cap(last.r, last)})</span>` : '');
  if (!link) return `<div class="card">${head}${radarBody(a)}${lastLine}</div>`;
  return `<a class="card" href="#paire/${encodeURIComponent(a.symbol)}">${head}${radarBody(a)}${lastLine}<span class="go">Voir la fiche ${esc(a.symbol)} →</span></a>`;
}

// Ce qu'on peut attendre de la méthode, en chiffres honnêtes (test sur 2020-2026, frais compris), à la place d'un seul gros chiffre.
function expectBox() {
  const e = data.expect;
  if (!e) return '';
  const risk = data.rules.riskPct ?? 1;
  const court = isCourt();
  const safe = court ? 0.25 : 0.5;
  return `<div class="box expect"><b>Ce qu'on peut attendre${court ? ' du court terme' : ''}</b>
    <ul>
      ${e.prudent ? `<li><b>Estimation prudente : environ +${fmt(e.prudent.perTrade * risk, 1)} % du capital par trade</b>, soit autour de <b>+${e.prudent.yearPct} % par an</b>. Elle vient du test le plus sévère (20 cryptos, 2025-2026, frais compris). C'est le chiffre à garder en tête.</li>` : ''}
      ${e.yearPct ? `<li>Le haut de la fourchette : environ +${e.yearPct} % par an en 2025-2026 sur les 9 cryptos suivies, en réinvestissant les gains (${esc(e.years)}). Ce chiffre est sûrement trop beau : on a regardé cette période plusieurs fois avant de choisir les réglages, donc les règles lui sont un peu « taillées sur mesure ».</li>
      ${e.score ? `<li>Le bot ne garde que les signaux les mieux notés, environ 4 sur 10. La note est bonne quand le marché est calme, que Bitcoin va dans le même sens et que tout le marché n'est pas déjà lancé. Sans ce tri : environ +${e.score.without.yearPct} % par an, ${e.score.without.perMonth} signaux par mois et un recul jusqu'à −${e.score.without.ddPct} %.</li>` : ''}
      ${e.gros ? `<li>Quand les gros traders de Binance sont déjà très acheteurs (au moins ${fmt(data.rules.grosMax ?? 1.65, 2)} achat pour 1 vente), le bot prend les achats avec moitié moins de risque : ces achats ont très peu rapporté dans nos tests. Sans cette règle : environ +${e.gros.without.yearPct} % par an, mais un recul jusqu'à −${e.gros.without.ddPct} %. C'est la seule des 17 données testées (open interest, funding, peur et avidité, options…) qui aide vraiment.</li>` : ''}
      <li>Le risque de chaque trade suit l'agitation du marché : ${pctTxt(risk)} % du capital en temps normal, jusqu'au double quand le prix bouge peu, la moitié quand il s'agite. Le risque conseillé est écrit sur chaque carte. Sans cet ajustement, on gagnait moins (environ +${e.score?.fixedPct ?? 23} % par an à 1 % fixe).</li>`
      : `<li>En moyenne <b>+${fmt(e.perTrade * risk, 2)} %</b> du capital par trade, frais compris (${fmt(risk, 0)} % du compte risqué à chaque fois). C'est ce qu'a donné la méthode en 2025-2026 sur les 9 cryptos suivies (${esc(e.years)}).</li>`}
      <li>Seulement <b>${fmt(e.winRate * 100, 0)} % de trades gagnants</b> : la plupart finissent au stop, avec une petite perte. Quelques gros gains paient tout le reste.</li>
      <li>Environ <b>${e.perMonth} signaux par mois</b>${court ? ', soit 1 à 2 par jour' : ''}.</li>
      ${e.ddPct ? `<li class="down">Les pertes peuvent s'enchaîner : jusqu'à <b>${e.streak} stops d'affilée</b>, car plusieurs paires perdent en même temps. Le capital a reculé jusqu'à <b>−${e.ddPct} %</b> depuis son plus haut. Avec ${pctTxt(e.safe.base)} % de base au lieu de ${pctTxt(risk)} % : environ +${e.safe.yearPct} % par an, recul maximal −${e.safe.ddPct} %.</li>`
      : `<li class="down">Les pertes peuvent s'enchaîner : jusqu'à <b>${e.streak} stops d'affilée</b>, car plusieurs paires perdent en même temps. En risquant ${fmt(risk, 0)} % à chaque trade, la pire baisse a été de <b>${e.ddR} %</b>${e.ddR * risk >= 100 ? ' : le compte aurait été vidé' : ''}. Avec ${fmt(safe, 2).replace(/,?0+$/, '')} % par trade, elle aurait été d'environ ${Math.round(e.ddR * safe / risk)} %.</li>`}
      ${e.score ? `<li class="down">Ces chiffres reposent sur ${e.score.trades} trades seulement : attends-toi à moins en vrai. Sur 2020-2024, la période qui a servi à apprendre la note, on trouve environ +${e.score.dev.yearPct} % par an avec un recul jusqu'à −${e.score.dev.ddPct} %, et 2023 a été une année à plat.</li>` : ''}
      ${court ? '<li>Chaque trade gagne moins qu\'en Setups et les frais pèsent plus lourd. Les bougies de 15 minutes ont été testées aussi : elles perdent à cause des frais, elles ne sont donc pas proposées.</li>' : ''}
    </ul>
    <p class="sm muted">Résultats passés, pas une promesse. Le pétrole n'a pas assez d'historique pour ce test. Ceci n'est pas un conseil financier.</p></div>`;
}

// Catégorie Court terme : radar, signaux en jeu et bilan, depuis data/setups-court.json.
function renderCourt() {
  const box = document.getElementById('court-grid');
  if (!box) return;
  if (!courtData) {
    box.innerHTML = '<div class="box"><div class="empty">Le court terme n\'est pas encore disponible. Il est calculé toutes les heures : reviens dans quelques minutes.</div></div>';
    return;
  }
  withData(courtData, () => {
    document.getElementById('court-expect').innerHTML = expectBox();
    document.getElementById('court-radar').innerHTML = data.assets.map(a => radarCard(a, false)).join('');
    const live = data.live;
    document.getElementById('court-count').textContent = `${live.length} signal${live.length > 1 ? 's' : ''} · ${data.assets.length} marchés surveillés`;
    box.innerHTML = live.length ? live.map(s => card(s, false)).join('')
      : '<div class="box"><div class="empty">Aucun trade court terme en ce moment. Les prix qui déclencheraient le prochain sont dans les cartes au-dessus.</div></div>';
    const from = Date.now() - historyDays() * 86_400_000;
    const done = data.history.filter(s => s.status === 'confirmé' && s.outcome !== 'open' && s.time >= from && !delayed(s));
    const total = sumR(done);
    const wins = done.filter(s => s.r > 0).length;
    const rows = done.slice(0, 30).map(s => `<tr><td class="l">${parisDay(s.time)}</td><td class="l"><b class="mono">${esc(s.symbol)}</b></td><td class="l">${esc(data.detectors[s.detector])}</td><td class="l">${dirTag(s.dir)}</td><td class="n">${px(s.entry)}</td><td class="l"><span class="tag ${outcomeCls(s)}">${OUTCOME[s.outcome][0]}</span></td><td class="n ${s.r > 0 ? 'up' : s.r < 0 ? 'down' : ''}">${cap(s.r, s)}</td></tr>`).join('');
    document.getElementById('court-bilan').innerHTML = `<p class="wait-sum">Sur les ${historyDays() > 100 ? '12 derniers mois' : '3 derniers mois'} : <b>${done.length} trades terminés</b>, ${wins} gagnant${wins > 1 ? 's' : ''},
      <b class="${total > 0 ? 'up' : total < 0 ? 'down' : ''}">${cap(total)} du capital</b> au total, avant frais.</p>
      ${rows ? `<div class="tbl"><table><thead><tr><th class="l">Date</th><th class="l">Paire</th><th class="l">Signal</th><th class="l">Sens</th><th>Entrée</th><th class="l">Résultat</th><th>Capital</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
  });
}

// Catégorie Indicateurs : une carte par paire avec l'état de ses indicateurs, sans signal de trade.
const VERDICT = { 'plutôt haussier': 'up', 'plutôt baissier': 'down', partagé: '' };
// Indicateur Jambe : petit graphique des 6 derniers mois, vert en jambe haussière, rouge en jambe baissière,
// avec le creux (ou le sommet) d'où part la jambe en cours et l'extrême atteint depuis.
const shortDay = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export function legBlock(leg, sym) {
  if (!leg) return '';
  const up = leg.dir === 'up';
  const o = leg.origin;
  const past = leg.past.map(l => `<li><span class="${l.dir === 'up' ? 'up' : 'down'}">${l.dir === 'up' ? '▲' : '▼'}</span> ${shortDay(l.from)} → ${shortDay(l.to)} <b class="mono">${plainPct(l.move)}</b></li>`).join('');
  return `<div class="leg ${up ? 'up' : 'down'}">
    <span class="leg-hd"><b>${up ? 'Jambe haussière' : 'Jambe baissière'}</b> depuis le ${shortDay(leg.since.t)} <span class="muted">(${leg.days} j, bougies journalières)</span></span>
    <span class="leg-txt">${o ? `Elle part du ${up ? 'creux' : 'sommet'} du ${shortDay(o.t)} à <b class="mono">${px(o.price)}</b> : ${plainPct(leg.fromOrigin)} depuis. ` : ''}${up ? 'Plus haut' : 'Plus bas'} atteint le ${shortDay(leg.ext.t)} : <b class="mono">${px(leg.ext.price)}</b>.</span>
    <span class="leg-txt">${up ? 'On reste dans la jambe tant que la moyenne 9 jours reste au-dessus de la 21 jours.' : 'On reste à l\'écart (ou short) tant que la moyenne 9 jours reste sous la 21 jours.'}</span>
    ${past ? `<details><summary>Jambes précédentes</summary><ul class="leg-past">${past}</ul></details>` : ''}
    <button type="button" class="jb-go" data-jb-sym="${esc(sym)}">Voir les jambes de ${esc(sym)} sur le graphique ↑</button>
  </div>`;
}

export function indicatorCard(a) {
  const ind = a.ind;
  const head = `<span class="hd"><b class="mono">${esc(a.symbol)}</b><span class="muted">${esc(a.name)}</span><span class="px">${px(a.price)}</span></span>`;
  if (!ind) return `<div class="card">${head}<span class="sm">Pas assez de données pour le moment.</span></div>`;
  const rows = ind.items.map(x => `<li><span class="ik">${esc(x.label)}</span><span class="iv ${x.tone}">${esc(x.value)}</span><span class="it">${esc(x.text)}</span></li>`).join('');
  return `<div class="card">${head}
    ${legBlock(a.leg, a.symbol)}
    <span class="ind-sum">Dans l'ensemble : <b class="${VERDICT[ind.verdict] ?? ''}">${esc(ind.verdict)}</b> <span class="muted">(${ind.ups} vert${ind.ups > 1 ? 's' : ''}, ${ind.downs} rouge${ind.downs > 1 ? 's' : ''})</span></span>
    <ul class="ind-list">${rows}</ul>
    <a class="go" href="#paire/${encodeURIComponent(a.symbol)}">Voir la fiche ${esc(a.symbol)} →</a></div>`;
}

let legsMounted = false;
function renderIndicators() {
  document.getElementById('setups-ind').innerHTML = data.assets.map(indicatorCard).join('');
  // Le graphique se charge à la première ouverture de la catégorie (moteur de graphique et bougies).
  if (state.cat === 'ind' && !legsMounted) {
    legsMounted = true;
    mountLegs(document.getElementById('setups-legs'), data.assets.map(a => a.symbol));
  }
}

function renderCat() {
  for (const b of document.querySelectorAll('#setups-cats .chip')) b.setAttribute('aria-pressed', String(b.dataset.cat === state.cat));
  document.getElementById('setups-cat-setups').hidden = state.cat !== 'setups';
  document.getElementById('setups-cat-ind').hidden = state.cat !== 'ind';
  const court = document.getElementById('setups-cat-court');
  if (court) court.hidden = state.cat !== 'court';
  if (data) renderIndicators();
}

function renderRadar() {
  document.getElementById('setups-radar').innerHTML = data.assets.map(radarCard).join('');
}

function filtered() {
  return data.live.filter(s => state.detectors.includes(s.detector)
    && (state.dir === 'all' || s.dir === state.dir)
    && (state.kind === 'all' || (asset(s.symbol).kind || 'crypto') === state.kind)
    && (!state.watch || watchlist.has(s.symbol)));
}

function renderList() {
  const list = filtered();
  const total = data.live.length;
  document.getElementById('setups-count').textContent = total
    ? `${list.length} setup${list.length > 1 ? 's' : ''} affiché${list.length > 1 ? 's' : ''} sur ${total} · ${data.assets.length} marchés surveillés`
    : `${data.assets.length} marchés surveillés`;
  document.getElementById('setups-grid').innerHTML = list.length ? list.map(card).join('')
    : !total ? waiting()
      : `<div class="box"><div class="empty">${state.watch ? 'Aucun setup en ce moment sur les actifs de ta watchlist.' : 'Aucun setup ne correspond à ces filtres.'} <a href="#historique">Voir l'historique →</a></div></div>`;
}

// Bilan public des 12 derniers mois et série en cours (gains ou stops d'affilée), du trade fermé le plus récent au plus ancien.
// Les pertes restent visibles pour tout le monde : c'est ce qui permet de juger la méthode.
export function trackRecord(history, now = Date.now()) {
  const done = history.filter(s => s.outcome !== 'open' && s.at && now - s.at < 365 * 86_400_000).sort((a, b) => b.at - a.at);
  const wins = done.filter(s => s.r > 0).length;
  const total = Math.round(done.reduce((t, s) => t + s.r * (s.sz ?? 1), 0) * 10) / 10;
  const first = done[0];
  let streak = { kind: null, n: 0, sum: 0, since: null };
  if (first && first.r !== 0) {
    const kind = first.r > 0 ? 'win' : 'loss';
    let i = 0;
    while (i < done.length && (kind === 'win' ? done[i].r > 0 : done[i].r < 0)) { streak.sum += done[i].r * (done[i].sz ?? 1); i++; }
    // Depuis quand : la date du dernier trade de l'autre sorte (le dernier gain pour une série de stops).
    streak = { kind, n: i, sum: Math.round(streak.sum * 10) / 10, since: done[i]?.at ?? null };
  }
  return { n: done.length, wins, total, streak };
}

const dayFr = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });

// Encadré de confiance : les vrais signaux (journal figé), le bilan rejoué sur 12 mois et le risque total en cours.
function renderTrack() {
  const el = document.getElementById('setups-track');
  if (!el) return;
  const risk = data.rules.riskPct ?? 1;
  const j = journalStats(data.journal);
  const t = trackRecord(data.history);
  const o = openRisk(data.live, risk);
  const parts = [];

  // 1. Le risque total en cours : plusieurs trades dans le même sens = un seul gros pari.
  if (o.atRisk >= 2) {
    const same = Math.max(o.dirs.long, o.dirs.short);
    const sens = o.dirs.long >= o.dirs.short ? 'achats' : 'ventes';
    const safe = o.open - o.atRisk;
    parts.push(`<p class="risk-now"><b>Risque total en ce moment : −${pctTxt(o.pct)} % du compte</b> si tous les trades ouverts touchent leur stop en même temps. ${same >= 2 ? `Ce sont ${same} ${sens} sur des cryptos qui bougent souvent ensemble : en pratique, c'est presque un seul pari${same >= 3 ? ', pas plusieurs petits' : ''}.` : ''}${safe ? ` ${safe} autre${safe > 1 ? 's' : ''} trade${safe > 1 ? 's ont' : ' a'} déjà ${safe > 1 ? 'leur' : 'son'} stop au prix d'entrée : ${safe > 1 ? 'ils ne peuvent' : 'il ne peut'} plus rien faire perdre.` : ''}</p>`);
  } else if (o.atRisk === 1) {
    parts.push(`<p class="risk-now">Risque total en ce moment : −${pctTxt(o.pct)} % du compte (un seul trade ouvert qui peut encore toucher son stop).</p>`);
  }

  // 2. Les vrais signaux, notés au moment où ils ont été publiés et jamais recalculés.
  if (j.start) {
    const since = dayFr(j.start);
    const body = !j.signals ? `Aucun signal publié depuis le ${since}. Le prochain sera noté ici.`
      : !j.done ? `${j.signals} ${j.signals > 1 ? 'signaux' : 'signal'} publié${j.signals > 1 ? 's' : ''} depuis le ${since}, encore en cours.`
        : `Depuis le ${since} : <b>${j.signals} ${j.signals > 1 ? 'signaux' : 'signal'}</b>, ${j.done} terminé${j.done > 1 ? 's' : ''} dont ${j.wins} gagnant${j.wins > 1 ? 's' : ''}, <b class="${j.total > 0 ? 'up' : j.total < 0 ? 'down' : ''}">${j.total > 0 ? '+' : ''}${fmt(j.total * risk, 1)} % du capital</b>${j.open ? `, ${j.open} encore en cours` : ''}.`;
    parts.push(`<p><b>Les vrais signaux</b> · ${body}</p>
      <p class="sm muted">Chaque signal est noté au moment où le site le publie : prix d'entrée, stop et taille. Ces chiffres ne sont plus jamais recalculés, même si les règles changent. C'est la seule vraie preuve${j.done < MIN_TRADES ? ` : il faut au moins ${MIN_TRADES} trades terminés avant de juger` : ''}.${j.orphans ? ` ${j.orphans} trade${j.orphans > 1 ? 's' : ''} n'${j.orphans > 1 ? 'ont' : 'a'} pas pu être suivi${j.orphans > 1 ? 's' : ''} jusqu'au bout et ne compte${j.orphans > 1 ? 'nt' : ''} pas.` : ''}</p>`);
  }

  // 3. Le bilan rejoué avec les règles actuelles (utile, mais ce n'est pas du vrai).
  if (t.n) {
    const st = t.streak;
    const day = new Date(st.since || 0).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
    const serie = st.n >= 3 && st.kind === 'loss'
      ? ` <b>Série en cours : ${st.n} stops d'affilée</b>${st.since ? ` depuis le dernier gain du ${day}` : ''} (<b class="down">${cap(st.sum)} du capital</b>). C'est normal pour cette méthode : la plupart des trades perdent un peu, quelques-uns gagnent beaucoup.`
      : st.n >= 2 && st.kind === 'win' ? ` <b>Série en cours : ${st.n} gains d'affilée</b>. Les séries de stops reviennent toujours : garde le même risque.` : '';
    parts.push(`<p><b>Rejoué sur 12 mois</b> · ${t.n} trades terminés, ${t.wins} gagnants, <b class="${t.total > 0 ? 'up' : t.total < 0 ? 'down' : ''}">${cap(t.total)} du capital</b>.${serie}</p>
      <p class="sm muted">Ce bilan applique les règles d'aujourd'hui au passé. Il est recalculé à chaque mise à jour : il montre comment la méthode se comporte, pas ce qu'elle a vraiment donné.</p>`);
  }

  if (data.rules.frozenUntil) {
    parts.push(`<p class="sm">Règles gelées jusqu'au ${dayFr(data.rules.frozenUntil + 'T12:00:00Z')} : aucun réglage ne sera changé d'ici là, pour pouvoir juger les vrais signaux honnêtement.</p>`);
  }
  if (!parts.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="box track"><h2>Le bilan réel des signaux</h2>${parts.join('')}
    <p class="sm muted">Avec un effet de levier, une petite variation peut effacer toute ta mise. Ne risque jamais plus que le risque conseillé sur chaque carte.</p>
    <p><a href="#historique">Voir tous les trades →</a></p></div>`;
}

// Aucun trade ouvert : on le dit simplement et on montre les derniers trades terminés, pour que la page ne paraisse pas vide.
function waiting() {
  const from = Date.now() - historyDays() * 86_400_000;
  const done = data.history.filter(s => s.status === 'confirmé' && s.outcome !== 'open' && s.time >= from && !delayed(s));
  const total = sumR(done);
  const wins = done.filter(s => s.r > 0).length;
  const months = historyDays() > 100 ? '12 derniers mois' : '3 derniers mois';
  const rows = done.slice(0, 3).map(s => `<li><b class="mono">${esc(s.symbol)}</b> ${dirTag(s.dir)} <span class="muted">${parisDay(s.time)}</span>
    <span class="r ${s.r > 0 ? 'up' : s.r < 0 ? 'down' : ''}">${cap(s.r, s)} du capital</span></li>`).join('');
  return `<div class="box wait"><div class="empty"><b>Aucun trade en ce moment : la méthode attend un bon moment.</b>
    C'est normal, la méthode attend une vraie cassure dans le sens de la tendance (environ ${data.expect?.perMonth ?? 'quelques'} signaux par mois). Les prix qui pourraient déclencher le prochain sont juste au-dessus : le bot ne le gardera que s'il a une bonne note.</div>
    ${done.length ? `<p class="wait-sum">Sur les ${months} : <b>${done.length} trade${done.length > 1 ? 's' : ''} terminé${done.length > 1 ? 's' : ''}</b>, ${wins} gagnant${wins > 1 ? 's' : ''},
      <b class="${total > 0 ? 'up' : total < 0 ? 'down' : ''}">${cap(total)} du capital</b> au total (${baseRiskTxt()}).</p>
    <ul class="wait-list">${rows}</ul>` : ''}
    <p class="wait-sum"><a href="#historique">Voir tout l'historique →</a></p></div>`;
}

export function initSetups(setupsData, projects) {
  data = setupsData;
  // Court terme gardé hors ligne pour l'instant (décision du 18 novembre 2026) : COURT_ON passe à true pour le montrer.
  if (COURT_ON) fetch('data/setups-court.json').then(r => (r.ok ? r.json() : null)).catch(() => null).then(d => { courtData = d; renderCourt(); });
  projectsBySymbol = new Map((projects?.projects || []).filter(p => p.symbol).map(p => [p.symbol.toUpperCase(), p]));
  const keys = Object.keys(data.detectors);
  Object.assign(state, store.get());
  if (!Array.isArray(state.detectors) || !state.detectors.length) state.detectors = keys;

  const chips = () => {
    document.getElementById('setups-detectors').innerHTML = keys.map(k =>
      `<button type="button" class="chip" data-key="${k}" aria-pressed="${state.detectors.includes(k)}">${esc(data.detectors[k])}</button>`).join('');
    document.getElementById('setups-filters').innerHTML = [
      ['dir', 'all', 'Long et short'], ['dir', 'long', 'Long'], ['dir', 'short', 'Short'], null,
      ['kind', 'all', 'Tous les marchés'], ['kind', 'crypto', 'Crypto'], ['kind', 'commodity', 'Pétrole'], null,
      ['watch', true, 'Ma watchlist'],
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
    if (b.dataset.f === 'watch') state.watch = !state.watch;
    else state[b.dataset.f] = b.dataset.v;
    update();
  });
  document.getElementById('setups-cats').addEventListener('click', e => {
    const c = e.target.closest('.chip')?.dataset.cat;
    if (!c) return;
    state.cat = c;
    store.set(state);
    renderCat();
  });
  document.getElementById('setups-ind').addEventListener('click', e => {
    const b = e.target.closest('.jb-go');
    if (b) showLegs(b.dataset.jbSym);
  });
  watchlist.subscribe(() => { if (state.watch) renderList(); });
  document.getElementById('setups-warnings').innerHTML = (data.warnings || []).map(w => `<p class="warn">⚠ ${esc(w)}</p>`).join('');
  if (!['setups', ...(COURT_ON ? ['court'] : []), 'ind'].includes(state.cat)) state.cat = 'setups';
  document.getElementById('setups-expect').innerHTML = expectBox();
  chips();
  renderCat();
  renderIndicators();
  renderRadar();
  renderList();
  renderTrack();
  renderHistory();
  renderResume();
  // Statut Premium connu après la connexion : on redessine ce qui en dépend.
  onTier(() => { renderRadar(); renderList(); renderHistory(); renderResume(); if (COURT_ON) renderCourt(); });
}

function renderResume() {
  const open = data.live.filter(s => s.outcome === 'open');
  const live = open.filter(s => !delayed(s));
  const locked = open.filter(s => delayed(s)).map(s => `
    <a class="row" href="#premium"><span class="t">${esc(s.symbol)}</span><span class="d">Nouveau signal · visible dans ${hoursText(visibleIn(s))}</span><span class="r"><span class="ptag">Premium</span></span></a>`);
  document.getElementById('resume-setups').innerHTML = [...live.slice(0, 5).map(s => `
    <a class="row" href="#setup/${encodeURIComponent(s.id)}"><span class="t">${esc(s.symbol)}</span><span class="d">${esc(data.detectors[s.detector])} · ${s.status}</span><span class="r ${s.dir === 'long' ? 'up' : 'down'}">${s.dir === 'long' ? '▲' : '▼'} 1:${fmt(s.rr, 1)}</span></a>`), ...locked].join('')
    || '<div class="soon">Aucun setup en jeu pour le moment.</div>';
  // Bloc « À regarder maintenant » : le setup confirmé du détecteur le plus fiable.
  const rate = s => data.stats[s.detector]?.winRate ?? 0;
  const best = live.filter(s => s.status === 'confirmé').sort((a, b) => rate(b) - rate(a) || b.rr - a.rr)[0];
  const focus = document.getElementById('focus');
  focus?.querySelector('[data-sfocus]')?.remove();
  if (best && focus) {
    const html = `<a class="card" data-sfocus href="#setup/${encodeURIComponent(best.id)}"><span class="k">SETUP DANS LE SENS DE LA TENDANCE</span>
      <span class="hd"><b class="mono">${esc(best.symbol)}</b><span class="tag">${esc(data.detectors[best.detector])}</span>${dirTag(best.dir)}</span>
      <span class="why">${esc(best.why)} Gain visé : ${fmt(best.rr, 0)} fois la perte possible.</span></a>`;
    if (focus.querySelector('.card .why')?.textContent.startsWith('Rien de particulier')) focus.innerHTML = html;
    else focus.insertAdjacentHTML('afterbegin', html);
    while (focus.children.length > 4) focus.lastElementChild.remove();
  }
}

// Bilan par détecteur sur une période plus courte que celle du serveur (formule gratuite : 3 mois).
// Mêmes règles que detectorStats dans scripts/lib/setups.mjs.
export function statsOf(history, detectors, from) {
  const stats = {};
  for (const key of Object.keys(detectors)) {
    const list = history.filter(s => s.detector === key && s.status === 'confirmé' && s.time >= from);
    const done = list.filter(s => s.outcome !== 'open');
    const wins = done.filter(s => s.r > 0).length;
    const bySymbol = {};
    for (const s of done) (bySymbol[s.symbol] ??= []).push(s);
    const best = Object.entries(bySymbol)
      .filter(([, l]) => l.length >= 3)
      .map(([sym, l]) => ({ symbol: sym, n: l.length, winRate: l.filter(s => s.r > 0).length / l.length }))
      .sort((x, y) => y.winRate - x.winRate || y.n - x.n)[0] || null;
    stats[key] = {
      signals: list.length, resolved: done.length, wins,
      losses: done.filter(s => s.outcome === 'sl').length,
      tp1: done.filter(s => s.tpHit > 0).length,
      winRate: done.length ? wins / done.length : null,
      avgR: done.length ? done.reduce((t, s) => t + s.r, 0) / done.length : null,
      totalR: Math.round(done.reduce((t, s) => t + s.r, 0) * 10) / 10,
      best,
    };
  }
  return stats;
}

function renderHistory() {
  const keys = Object.keys(data.detectors);
  const since = Math.min(...Object.values(data.freshStart || {}).filter(Boolean));
  const days = historyDays();
  const from = Date.now() - days * 86_400_000;
  // Les signaux encore cachés sans Premium (moins de 24 h sur SOL et le pétrole) ne comptent pas encore.
  const shown = data.history.filter(s => s.time >= from && !delayed(s));
  const stats = isPremium() ? data.stats : statsOf(shown, data.detectors, from);
  document.getElementById('history-period').textContent = days > 100 ? '12 derniers mois' : '3 derniers mois';
  document.getElementById('history-more').hidden = isPremium();
  document.getElementById('history-sub').textContent = `Un trade est gagnant s'il finit en gain. La moitié est prise à ${data.rules.partialR ?? 5}R, le reste sort quand une journée clôture au-delà du plus bas (ou du plus haut pour un short) des ${data.rules.exitDays ?? 7} derniers jours. `
    + (Number.isFinite(since) ? `Calculé sur les bougies OKX depuis le ${new Date(since).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' })}.` : '');
  document.getElementById('history-body').innerHTML = keys.map(k => {
    const s = stats[k];
    const w = s.winRate === null ? null : Math.round(s.winRate * 100);
    return `<tr>
      <td class="l"><b>${esc(data.detectors[k])}</b><br><span class="muted" style="font-size:12px">dans le sens de la tendance 1D</span></td>
      <td class="n">${s.signals}</td>
      <td class="n">${w === null ? '—' : `<span class="score"><i style="--w:${w}%"></i>${w} %</span>`}</td>
      <td class="n"><span class="up">${s.tp1}</span> / <span class="down">${s.losses}</span></td>
      <td class="n ${s.totalR > 0 ? 'up' : s.totalR < 0 ? 'down' : ''}">${s.avgR === null ? '—' : cap(s.totalR)}</td>
      <td class="l">${s.best ? `${esc(s.best.symbol)} <span class="muted">${fmt(s.best.winRate * 100, 0)} % sur ${s.best.n}</span>` : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
  const done = shown.filter(s => s.outcome !== 'open').slice(0, 60);
  document.getElementById('history-list').innerHTML = done.length ? done.map(s => `<tr data-trade="${esc(s.id)}" title="Voir l'explication du trade">
      <td class="l"><a href="#setup/${encodeURIComponent(s.id)}">${parisDay(s.time)}</a></td>
      <td class="l"><b class="mono">${esc(s.symbol)}</b></td>
      <td class="l">${esc(data.detectors[s.detector])}</td>
      <td class="l">${dirTag(s.dir)}</td>
      <td class="n">${px(s.entry)}</td>
      <td class="n">1:${fmt(s.rr, 1)}</td>
      <td class="l"><span class="tag ${outcomeCls(s)}">${OUTCOME[s.outcome][0]}</span></td>
      <td class="n ${s.r > 0 ? 'up' : s.r < 0 ? 'down' : ''}">${cap(s.r, s)}</td>
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

// ---------- Contexte du marché (labo 9, novembre 2026) ----------
// Chaque donnée en mots simples, avec ce que le test a donné : utile pour trier les signaux, ou seulement à titre d'info.
const sgn = x => (x > 0 ? '+' : x < 0 ? '−' : '');
const pctPlain = (x, d = 1) => `${sgn(x)}${fmt(Math.abs(x) * 100, d)} %`;
function testLine(key) {
  const t = data?.context?.test?.[key];
  if (!t) return '';
  return `<span class="it ctx-t ${t.helps ? 'ok' : t.helps === false ? 'no' : ''}">${t.helps ? '✔ ' : t.helps === false ? '✗ ' : '… '}${esc(t.text)}</span>`;
}
function ctxItem(key, label, value, text, tone = '', testKey = key) {
  return `<li><span class="ik">${esc(label)}</span><span class="iv ${tone}">${value}</span><span class="it">${text}</span>${testLine(testKey)}</li>`;
}
export function contextItems(a) {
  const c = a.ctx;
  if (!c || a.kind === 'commodity') return [];
  const g = data?.context ?? {};
  const out = [];
  if (c.gros) {
    const hot = c.gros >= (data.rules.grosMax ?? 1.65);
    out.push(ctxItem('gros', 'Gros traders : achats pour 1 vente (Binance, hier soir)', `${fmt(c.gros, 2)} pour 1`,
      hot ? (a.radar?.dir === 'short' ? 'Ils sont déjà très acheteurs. La règle ne joue que pour les achats : en ce moment, le bot cherche des ventes.' : 'Ils sont déjà très acheteurs. Un achat maintenant arrive souvent tard : le bot le prend avec moitié moins de risque.')
        : c.gros < 1 ? 'Ils sont plutôt vendeurs.' : 'Ils sont un peu plus acheteurs que vendeurs, sans excès.', hot ? 'down' : ''));
  }
  if (c.oi) out.push(ctxItem('oi', 'Positions ouvertes sur 24 h (open interest OKX)', `${c.oi.ch1 === null ? '—' : pctPlain(c.oi.ch1)}`,
    `${c.oi.ch7 === null ? '' : `${pctPlain(c.oi.ch7)} en 7 jours. `}${c.oi.ch7 > 0.1 ? 'Beaucoup de nouveaux paris arrivent : le mouvement attire du monde, mais il peut aussi se retourner d\'un coup.' : c.oi.ch7 < -0.1 ? 'Beaucoup de traders ferment leurs positions.' : 'Pas de grand changement.'}`));
  if (c.crowd) out.push(ctxItem('crowd', 'Foule : acheteurs pour 1 vendeur (comptes OKX)', `${fmt(c.crowd, 2)} pour 1`,
    c.crowd >= 2 ? 'La plupart des petits comptes parient sur la hausse.' : c.crowd <= 0.8 ? 'La plupart des petits comptes parient sur la baisse.' : 'La foule est partagée.'));
  if (c.taker) out.push(ctxItem('taker', 'Part des achats pressés sur 24 h (OKX)', `${fmt(c.taker * 100, 0)} %`,
    c.taker >= 0.53 ? 'Les acheteurs pressés dominent.' : c.taker <= 0.47 ? 'Les vendeurs pressés dominent.' : 'Équilibre entre acheteurs et vendeurs pressés.'));
  if (c.funding !== undefined && c.funding !== null) out.push(ctxItem('funding', 'Funding moyen sur 7 jours (OKX)', `${sgn(c.funding)}${fmt(Math.abs(c.funding) * 100, 4)} %`,
    c.funding > 0.0002 ? 'Les acheteurs paient cher pour rester : beaucoup de paris à la hausse.' : c.funding < 0 ? 'Les vendeurs paient : beaucoup de paris à la baisse.' : 'Normal.', c.funding > 0.0002 ? 'down' : ''));
  if (g.fng) out.push(ctxItem('fng', 'Peur et avidité (tout le marché)', `${g.fng.value} / 100`,
    `${g.fng.value >= 75 ? 'Avidité extrême' : g.fng.value >= 55 ? 'Avidité' : g.fng.value > 45 ? 'Neutre' : g.fng.value > 25 ? 'Peur' : 'Peur extrême'}${g.fng.week !== null ? ` (${g.fng.week} il y a une semaine)` : ''}.`));
  const dv = g.dvol?.[a.symbol === 'ETH' ? 'ETH' : 'BTC'];
  if (dv) out.push(ctxItem('dvol', `Agitation attendue par les options (${a.symbol === 'ETH' ? 'ETH' : 'BTC'})`, `${fmt(dv.value, 0)} %`,
    `Sur un an (indice DVOL de Deribit). Les options parient sur des mouvements d'environ ${fmt(dv.value / Math.sqrt(365), 1)} % par jour${dv.week ? `, ${dv.value > dv.week * 1.05 ? 'en hausse' : dv.value < dv.week * 0.95 ? 'en baisse' : 'stable'} sur une semaine` : ''}.`));
  const z = c.zones;
  if (z?.top?.length) {
    const near = [...z.top].sort((x, y) => Math.abs(x.distance) - Math.abs(y.distance))[0];
    out.push(ctxItem('zones', `Prix les plus échangés (${z.days} derniers jours)`, `${px(near.price)}`,
      `Zone la plus proche à ${pctPlain(near.distance)} du prix. ${z.top.length > 1 ? `Autres : ${z.top.filter(x => x !== near).map(x => px(x.price)).join(', ')}. ` : ''}Le prix ralentit souvent dans ces zones.`));
  }
  return out;
}
export function contextBox(a) {
  const items = contextItems(a);
  if (!items.length) return '';
  const t = data?.context?.test ?? {};
  return `<div class="box ctx-box"><h2>Contexte du marché</h2>
    <p class="txt">Ces données ont toutes été testées sur les signaux du bot (2020-2026, frais compris). Une seule aide vraiment : les gros traders. Les autres sont là pour comprendre le marché, pas pour décider.</p>
    <ul class="ind-list">${items.join('')}</ul>
    ${t.season ? `<p class="fine">✗ ${esc(t.season.text)}</p>` : ''}
    ${t.liq ? `<p class="fine">… Liquidations : ${esc(t.liq.text)}</p>` : ''}
    <p class="fine">Sources gratuites : Binance (fichiers publics), OKX, alternative.me, Deribit. Mis à jour toutes les heures.</p></div>`;
}
