// Onglet Outils : calculateurs de trading, tout est calculé dans le navigateur (calculs dans js/outils-lib.js).
// Les champs communs (capital, risque, entrée, stop, frais…) sont partagés entre les outils et gardés sur l'appareil.
import { esc, fmt, price } from './format.js';
import { breakEven, compound, dca, liquidation, num, pnl, positionSize, riskReward, streaks } from './outils-lib.js';

const $ = id => document.getElementById(id);
const KEY = 'dinexo-outils';

// Valeurs par défaut : compte de 10 000 $, 1 % de risque comme les Setups, frais taker OKX sur perpétuels.
// Gagnants 32 % et gain moyen 5,8R : bilan du backtest des Setups (102 trades, +122 %).
const DEFAULTS = {
  capital: '10000', risk: '1', entry: '60000', stop: '58500', target: '67500', exit: '64000', fee: '0.05',
  winrate: '32', winR: '5.8', side: 'long', leverage: '5', mmr: '0.4', size: '20000', funding: '0.01', hours: '72',
  asset: 'btc', amount: '100', every: '7', since: '730', spotFee: '0.1',
  rate: '2', months: '36', monthly: '0', goal: '50000', trades: '30',
};

const F = {
  capital: { label: 'Capital du compte', unit: '$' },
  risk: { label: 'Risque par trade', unit: '% du capital' },
  entry: { label: "Prix d'entrée", unit: '$', prices: true },
  stop: { label: 'Stop', unit: '$' },
  target: { label: 'Objectif', unit: '$' },
  exit: { label: 'Prix de sortie', unit: '$' },
  fee: { label: 'Frais par côté', unit: '%', hint: 'OKX perpétuels : 0,05 % (taker), 0,02 % (maker)' },
  spotFee: { label: 'Frais par achat', unit: '%', hint: 'OKX comptant : 0,1 %' },
  winrate: { label: 'Trades gagnants', unit: '%' },
  winR: { label: 'Gain moyen d\'un gagnant', unit: 'R', hint: '1R = la somme risquée' },
  side: { label: 'Sens', choice: [['long', 'Long'], ['short', 'Short']] },
  leverage: { label: 'Levier', unit: '×' },
  mmr: { label: 'Marge de maintenance', unit: '%', hint: 'OKX BTC : 0,4 % pour une petite position' },
  size: { label: 'Valeur de la position', unit: '$', hint: 'quantité × prix, levier compris' },
  funding: { label: 'Funding moyen', unit: '% / 8 h', hint: 'positif : les longs paient' },
  hours: { label: 'Durée du trade', unit: 'heures' },
  asset: { label: 'Actif', choice: [['btc', 'BTC'], ['eth', 'ETH'], ['sol', 'SOL']] },
  amount: { label: 'Montant de chaque achat', unit: '$' },
  every: { label: 'Fréquence', choice: [['1', 'Jour'], ['7', 'Semaine'], ['14', '2 semaines'], ['30', 'Mois']] },
  since: { label: 'Depuis', choice: [['182', '6 mois'], ['365', '1 an'], ['730', '2 ans'], ['1095', '3 ans'], ['1460', '4 ans']] },
  rate: { label: 'Gain moyen par mois', unit: '%', hint: 'Setups en backtest : environ +1,9 % par mois' },
  months: { label: 'Durée', unit: 'mois' },
  monthly: { label: 'Ajout chaque mois', unit: '$' },
  goal: { label: 'Objectif de capital', unit: '$', optional: true },
  trades: { label: 'Nombre de trades', unit: 'trades', hint: 'Setups : environ 30 par an' },
};

const TOOLS = [
  { id: 'position', name: 'Taille de position', fields: ['capital', 'risk', 'entry', 'stop', 'fee'],
    intro: "Combien acheter (ou vendre à découvert) pour ne perdre que ton risque si le stop est touché, frais compris. Le sens se déduit du stop : sous l'entrée = long, au-dessus = short.", calc: position },
  { id: 'rr', name: 'Risque / rendement', fields: ['entry', 'stop', 'target', 'fee', 'winrate', 'risk'],
    intro: "Ce que rapporte l'objectif par rapport à ce que coûte le stop, et le pourcentage de trades gagnants qu'il faut pour ne pas perdre d'argent sur la durée.", calc: rr },
  { id: 'liquidation', name: 'Prix de liquidation', fields: ['side', 'entry', 'leverage', 'stop', 'mmr'],
    intro: "Où la plateforme ferme ta position de force en marge isolée, et le levier maximum pour que ton stop passe avant. Calcul de la formule OKX, frais de clôture ignorés : la vraie liquidation arrive un peu plus tôt.", calc: liq },
  { id: 'pnl', name: 'PnL d\'un trade', fields: ['side', 'entry', 'exit', 'size', 'leverage', 'fee', 'funding', 'hours', 'capital'],
    intro: 'Le résultat réel d\'un trade une fois les frais d\'entrée, de sortie et le funding payés, en dollars, en % de la marge et en % du compte.', calc: pnlTool },
  { id: 'breakeven', name: 'Seuil de rentabilité', fields: ['side', 'entry', 'fee', 'funding', 'hours'],
    intro: 'Le prix à atteindre pour sortir à zéro une fois les frais et le funding payés. Utile avant de remonter un stop au prix d\'entrée.', calc: be },
  { id: 'dca', name: 'Simulateur DCA', fields: ['asset', 'amount', 'every', 'since', 'spotFee'],
    intro: "Acheter la même somme à intervalle régulier, rejoué sur les vrais prix de clôture d'OKX, comparé à tout acheter d'un coup le premier jour.", calc: dcaTool },
  { id: 'compose', name: 'Intérêts composés', fields: ['capital', 'rate', 'months', 'monthly', 'goal'],
    intro: 'Ce que devient le compte si les gains restent investis chaque mois, et quand un objectif serait atteint.', calc: compose },
  { id: 'series', name: 'Séries de pertes', fields: ['winrate', 'winR', 'risk', 'trades'],
    intro: "2 000 parcours tirés au hasard avec ces chiffres : la plus longue série de pertes et le plus gros creux du compte auxquels s'attendre. Préréglé sur les Setups : 2 trades sur 3 finissent au stop, c'est normal.", calc: series },
];

const state = { tool: 'position', v: { ...DEFAULTS }, data: null };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  if (TOOLS.some(t => t.id === saved.tool)) state.tool = saved.tool;
  for (const [k, v] of Object.entries(saved.v || {})) if ((k in DEFAULTS || k === 'entryAsset') && typeof v === 'string') state.v[k] = v;
} catch { /* stockage indisponible */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ tool: state.tool, v: state.v })); } catch { /* stockage indisponible */ } };

// Mise en forme
const usd = n => (n == null || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}${fmt(Math.abs(n), Math.abs(n) >= 1000 ? 0 : 2)} $`);
const signed = n => `<span class="${n >= 0 ? 'up' : 'down'}">${n >= 0 ? '+' : '−'}${usd(Math.abs(n))}</span>`;
const pc = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : `${fmt(n, d)} %`);
const spc = (n, d = 2) => `<span class="${n >= 0 ? 'up' : 'down'}">${n >= 0 ? '+' : '−'}${fmt(Math.abs(n), d)} %</span>`;
const qty = n => fmt(n, n >= 1000 ? 0 : n >= 10 ? 2 : n >= 1 ? 4 : 6);
const px = n => (n >= 1 ? fmt(n, n >= 1000 ? 0 : n >= 100 ? 2 : 4) : price(n));
const lev = n => (Number.isFinite(n) ? `${fmt(n, n >= 10 ? 0 : 1)}×` : 'illimité');
const rows = list => `<dl>${list.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
const hero = (k, v, sub = '') => `<div class="t-hero"><span class="k">${k}</span><b class="num">${v}</b>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
const note = (txt, cls = '') => `<p class="t-note ${cls}">${txt}</p>`;
const missing = () => '<div class="empty">Remplis les champs avec des nombres pour voir le résultat.</div>';

function vals(keys) {
  const o = {};
  for (const k of keys) o[k] = F[k].choice ? state.v[k] : num(state.v[k]);
  return o;
}

// 1. Taille de position
function position() {
  const v = vals(['capital', 'risk', 'entry', 'stop', 'fee']);
  const r = positionSize({ capital: v.capital, riskPct: v.risk, entry: v.entry, stop: v.stop, feePct: v.fee ?? 0 });
  if (!r) return missing();
  const asset = state.v.entryAsset ? state.v.entryAsset.toUpperCase() : 'unités';
  return [
    hero(r.side === 'long' ? 'Acheter (long)' : 'Vendre à découvert (short)', `${qty(r.qty)} ${esc(asset)}`, `soit ${usd(r.notional)} de position`),
    rows([
      ['Perte si le stop est touché', `<span class="down">−${usd(r.risk)}</span> · ${pc(v.risk)} du compte`],
      ['Distance du stop', pc(r.stopPct)],
      ['dont frais (entrée + sortie)', usd(r.fees)],
      ['Levier minimum', r.leverage > 1 ? lev(r.leverage) : 'aucun (1× suffit)'],
      ['Marge à 5× de levier', usd(r.notional / 5)],
    ]),
    r.leverage > 1
      ? note(`La position vaut ${fmt(r.leverage, 1)} fois ton compte : il faut un levier d'au moins ${lev(Math.ceil(r.leverage * 10) / 10)}. Vérifie le <a href="#outils/liquidation">prix de liquidation</a> : il doit rester au-delà du stop.`, 'warn-inline')
      : note('Le levier ne change pas ta perte au stop : il réduit seulement la marge bloquée. C\'est la taille de position qui fixe le risque.'),
  ].join('');
}

// 2. Risque / rendement
function rr() {
  const v = vals(['entry', 'stop', 'target', 'fee', 'winrate', 'risk']);
  const r = riskReward({ entry: v.entry, stop: v.stop, target: v.target, feePct: v.fee ?? 0, winRatePct: v.winrate });
  if (!r) return missing();
  const wrong = r.rawRR <= 0;
  const out = [
    hero(`Ratio R:R (${r.side === 'long' ? 'long' : 'short'}, frais compris)`, wrong ? '—' : `1 : ${fmt(r.rr, 2)}`, wrong ? '' : `brut 1 : ${fmt(r.rawRR, 2)}`),
  ];
  if (wrong) return out.concat(note("L'objectif est du mauvais côté de l'entrée par rapport au stop.", 'warn-inline')).join('');
  out.push(rows([
    ['Objectif', `${spc(r.targetPct)} du prix`],
    ['Stop', `−${pc(r.stopPct)} du prix`],
    ['Gagnants nécessaires pour être à zéro', r.breakEvenWinRate != null ? pc(r.breakEvenWinRate, 1) : 'impossible : les frais mangent le gain'],
    r.expectancy != null && ['Gain moyen par trade', `${r.expectancy >= 0 ? '+' : '−'}${fmt(Math.abs(r.expectancy), 2)} R${v.risk > 0 ? ` · ${spc(r.expectancy * v.risk)} du compte` : ''}`],
  ]));
  out.push(`<div class="t-sub">Prix des objectifs en R</div><div class="t-levels">${r.levels.map(l => `<span><i>${l.k}R</i>${px(l.price)}</span>`).join('')}</div>`);
  if (r.expectancy != null) {
    out.push(r.expectancy >= 0
      ? note(`Avec ${pc(v.winrate, 0)} de gagnants qui vont tous à l'objectif, chaque trade rapporte en moyenne ${fmt(r.expectancy, 2)} fois la somme risquée.`)
      : note(`Avec ${pc(v.winrate, 0)} de gagnants, ce trade perd de l'argent sur la durée : il faut au moins ${pc(r.breakEvenWinRate, 1)} de gagnants ou un objectif plus loin.`, 'warn-inline'));
  }
  return out.join('');
}

// 3. Prix de liquidation
function liq() {
  const v = vals(['side', 'entry', 'leverage', 'stop', 'mmr']);
  const r = liquidation({ side: v.side, entry: v.entry, leverage: v.leverage, mmrPct: v.mmr ?? 0.4, stop: v.stop });
  if (!r) return missing();
  const out = [
    hero('Prix de liquidation', r.price > 0 ? px(r.price) : 'aucun', `${v.side === 'long' ? '−' : '+'}${pc(r.distPct)} depuis l'entrée`),
    rows([
      ['Marge bloquée pour 1 000 $ de position', usd(1000 / v.leverage)],
      r.maxLeverage != null && ['Levier maximum avec ce stop', lev(Math.floor(r.maxLeverage * 10) / 10)],
      r.maxLeverage != null && ['Levier conseillé (marge de sécurité)', lev(Math.max(1, Math.floor(r.maxLeverage * 0.7)))],
    ]),
  ];
  if (r.stopFirst === true) out.push(note('Ton stop est touché avant la liquidation. Le levier ne change pas ta perte : elle dépend de la taille de position.'));
  else if (r.stopFirst === false) out.push(note(`Attention : la liquidation arrive avant ton stop. Baisse le levier sous ${lev(Math.floor(r.maxLeverage * 10) / 10)}.`, 'warn-inline'));
  else if (v.stop > 0) out.push(note(`Le stop est du mauvais côté de l'entrée pour un ${v.side}.`, 'warn-inline'));
  return out.join('');
}

// 4. PnL
function pnlTool() {
  const v = vals(['side', 'entry', 'exit', 'size', 'leverage', 'fee', 'funding', 'hours', 'capital']);
  const r = pnl({ side: v.side, entry: v.entry, exit: v.exit, size: v.size, leverage: v.leverage ?? 1, feePct: v.fee ?? 0, fundingPct: v.funding ?? 0, hours: v.hours ?? 0, capital: v.capital });
  if (!r) return missing();
  return [
    hero('Résultat net', signed(r.net), r.capitalPct != null ? `${spc(r.capitalPct)} du compte` : ''),
    rows([
      ['Mouvement du prix', spc(r.movePct)],
      ['Résultat brut', signed(r.gross)],
      ['Frais (entrée + sortie)', `−${usd(r.fees)}`],
      ['Funding', r.funding >= 0 ? `−${usd(r.funding)} payé` : `+${usd(-r.funding)} reçu`],
      ['Marge bloquée', usd(r.margin)],
      ['Rendement de la marge', spc(r.roe)],
    ]),
    note("Le rendement de la marge grossit avec le levier, pas le résultat en dollars : c'est la valeur de la position qui compte."),
  ].join('');
}

// 5. Seuil de rentabilité
function be() {
  const v = vals(['side', 'entry', 'fee', 'funding', 'hours']);
  const r = breakEven({ side: v.side, entry: v.entry, feeInPct: v.fee ?? 0, feeOutPct: v.fee ?? 0, fundingPct: v.funding ?? 0, hours: v.hours ?? 0 });
  if (!r) return missing();
  const maker = breakEven({ side: v.side, entry: v.entry, feeInPct: 0.02, feeOutPct: 0.02, fundingPct: v.funding ?? 0, hours: v.hours ?? 0 });
  return [
    hero('Prix pour sortir à zéro', px(r.price), `${spc(r.movePct, 3)} de mouvement nécessaire`),
    rows([
      ['Avec des ordres limites (0,02 %)', `${px(maker.price)} · ${spc(maker.movePct, 3)}`],
      ['Sans frais ni funding', px(v.entry)],
    ]),
    note(`Un stop remonté pile au prix d'entrée fait perdre un peu : place-le plutôt à ${px(r.price)}.`),
  ].join('');
}

// 6. DCA
function dcaTool() {
  const s = state.data?.series?.[state.v.asset];
  if (!s?.points?.length) return '<div class="empty">Les prix historiques ne sont pas encore chargés. Ils viennent de la mise à jour automatique du site.</div>';
  const v = vals(['amount', 'every', 'since', 'spotFee']);
  const last = s.points.at(-1)[0];
  const startDay = Math.max(s.points[0][0], last - Number(v.since));
  const r = dca(s.points, { amount: v.amount, every: Number(v.every), startDay, feePct: v.spotFee ?? 0 });
  if (!r) return missing();
  const sym = state.v.asset.toUpperCase();
  const dy = n => new Date(n * 86_400_000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const better = r.value >= r.lump.value;
  return [
    hero(`Valeur aujourd'hui`, usd(r.value), `${spc(r.returnPct, 1)} pour ${usd(r.invested)} investis en ${r.buys} achats`),
    rows([
      ['Prix moyen payé', `${px(r.avgPrice)} $ · ${sym} vaut ${px(r.lastPrice)} $`],
      ['Quantité accumulée', `${qty(r.units)} ${sym}`],
      ['Tout acheter le premier jour', `${usd(r.lump.value)} · ${spc(r.lump.returnPct, 1)} (à ${px(r.lump.price)} $)`],
      ['Pire moment', r.worst.day != null ? `${spc(r.worst.pct, 1)} le ${dy(r.worst.day)}` : 'jamais en perte'],
    ]),
    chart([
      { name: 'Argent investi', cls: 'c-paid', pts: r.series.map(x => [x[0], x[1]]) },
      { name: 'Achat unique', cls: 'c-alt', pts: r.series.map(x => [x[0], x[3]]) },
      { name: 'DCA', cls: 'c-main', pts: r.series.map(x => [x[0], x[2]]) },
    ], { x: dy, y: n => usd(n) }),
    note(better
      ? `Sur cette période, le DCA a fait mieux qu'un achat unique : les achats réguliers ont profité des baisses.`
      : `Sur cette période, tout acheter le premier jour a fait mieux : le prix a surtout monté. Le DCA sert à lisser le risque d'acheter au mauvais moment, pas à gagner plus.`),
  ].join('');
}

// 7. Intérêts composés
function compose() {
  const v = vals(['capital', 'rate', 'months', 'monthly', 'goal']);
  const r = compound({ capital: v.capital ?? 0, ratePct: v.rate, months: Math.round(v.months ?? 0), monthly: v.monthly ?? 0, target: v.goal });
  if (!r) return missing();
  const dur = m => (m < 12 ? `${m} mois` : `${fmt(Math.floor(m / 12))} an${m >= 24 ? 's' : ''}${m % 12 ? ` et ${m % 12} mois` : ''}`);
  return [
    hero(`Capital après ${dur(Math.round(v.months))}`, usd(r.final), r.multiple ? `×${fmt(r.multiple, 2)} le capital de départ` : ''),
    rows([
      ['Argent versé', usd(r.paid)],
      ['Gains', signed(r.gains)],
      ['Gain sur un an à ce rythme', spc(((1 + v.rate / 100) ** 12 - 1) * 100, 1)],
      v.goal > 0 && ['Objectif de ' + usd(v.goal), r.reach == null ? 'pas atteint en 100 ans' : r.reach === 0 ? 'déjà atteint' : `atteint après ${dur(r.reach)}`],
    ]),
    chart([
      { name: 'Argent versé', cls: 'c-paid', pts: r.series.map(x => [x[0], x[1]]) },
      { name: 'Capital', cls: 'c-main', pts: r.series.map(x => [x[0], x[2]]) },
    ], { x: m => `${m} mois`, y: n => usd(n) }),
    note('Un rythme régulier chaque mois n\'existe pas en trading : certains mois perdent. C\'est un ordre de grandeur, pas une promesse.'),
  ].join('');
}

// 8. Séries de pertes
function series() {
  const v = vals(['winrate', 'winR', 'risk', 'trades']);
  const r = streaks({ winRatePct: v.winrate, winR: v.winR, riskPct: v.risk, trades: Math.round(v.trades ?? 0) });
  if (!r) return missing();
  const n = Math.round(v.trades);
  return [
    hero('Pire série de pertes à prévoir', `${r.losingStreak.p95} d'affilée`, `${r.losingStreak.median} dans un parcours moyen, ${r.losingStreak.max} au pire des 2 000`),
    rows([
      ['Plus gros creux du compte', `−${pc(r.drawdown.median, 1)} en moyenne · −${pc(r.drawdown.p95, 1)} 1 fois sur 20`],
      [`Résultat après ${n} trades`, `${spc(r.final.median, 1)} en moyenne`],
      ['1 fois sur 20', `moins de ${spc(r.final.p5, 1)} · plus de ${spc(r.final.p95, 1)}`],
      ['Chance de finir en perte', pc(r.lossOdds, 0)],
      ['Gain moyen par trade', `${r.expectancyR >= 0 ? '+' : '−'}${fmt(Math.abs(r.expectancyR), 2)} R`],
    ]),
    chart([
      { name: 'Malchanceux (1 sur 20)', cls: 'c-paid', pts: r.curves.p5.map((y, i) => [i, y]) },
      { name: 'Chanceux (1 sur 20)', cls: 'c-alt', pts: r.curves.p95.map((y, i) => [i, y]) },
      { name: 'Parcours moyen', cls: 'c-main', pts: r.curves.median.map((y, i) => [i, y]) },
    ], { x: i => `trade ${i}`, y: y => `${y >= 0 ? '+' : '−'}${fmt(Math.abs(y), 1)} %`, zero: true }),
    note(`Une série de ${r.losingStreak.p95} pertes d'affilée n'est pas un signe que la stratégie est cassée : avec ces chiffres, elle arrive normalement. Le danger, c'est de risquer plus pour se refaire.`),
  ].join('');
}

// Petit graphique en lignes (SVG), axe des x partagé, survol pour lire les valeurs.
let charts = [];
function chart(lines, fmtr) {
  charts.push({ lines, fmtr });
  return `<div class="t-chart" data-chart="${charts.length - 1}"></div><div class="t-keys">${lines.map(l => `<span><i class="key ${l.cls}"></i>${l.name}</span>`).join('')}</div>`;
}

function drawCharts(root) {
  for (const el of root.querySelectorAll('[data-chart]')) {
    const { lines, fmtr } = charts[Number(el.dataset.chart)];
    const W = Math.max(260, el.clientWidth), H = 200, L = 6, R = 6, T = 10, B = 22;
    const all = lines.flatMap(l => l.pts);
    const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = Math.min(...ys, fmtr.zero ? 0 : Infinity), y1 = Math.max(...ys);
    if (y1 === y0) y1 = y0 + 1;
    const pad = (y1 - y0) * 0.06;
    y0 = y0 >= 0 && y0 - pad < 0 ? 0 : y0 - pad;
    y1 += pad;
    const X = x => L + (x - x0) / (x1 - x0 || 1) * (W - L - R);
    const Y = y => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
    const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    const ticks = [y0 + (y1 - y0) * 0.2, y0 + (y1 - y0) * 0.55, y0 + (y1 - y0) * 0.9];
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Graphique">
      ${ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}"/><text class="tick" x="${L}" y="${Y(t) - 4}">${esc(fmtr.y(t))}</text>`).join('')}
      ${fmtr.zero && y0 < 0 ? `<line class="zero" x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}"/>` : ''}
      <text class="tick" x="${L}" y="${H - 6}">${esc(fmtr.x(x0))}</text><text class="tick end" x="${W - R}" y="${H - 6}">${esc(fmtr.x(x1))}</text>
      ${lines.map(l => `<path class="ln ${l.cls}" d="${path(l.pts)}"/>`).join('')}
      <line class="cross" y1="${T}" y2="${H - B}" hidden/>
    </svg><div class="mk-tip" hidden></div>`;
    const svg = el.querySelector('svg'), cross = svg.querySelector('.cross'), tip = el.querySelector('.mk-tip');
    const base = lines[0].pts;
    const move = e => {
      const r = svg.getBoundingClientRect();
      const x = x0 + (e.clientX - r.left - L) / (W - L - R) * (x1 - x0);
      let i = 0;
      for (let k = 0; k < base.length; k++) if (Math.abs(base[k][0] - x) < Math.abs(base[i][0] - x)) i = k;
      const cx = X(base[i][0]);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.hidden = false;
      tip.innerHTML = `<b>${esc(fmtr.x(base[i][0]))}</b>${[...lines].reverse().map(l => `<div><i class="key ${l.cls}"></i>${l.name}<span class="num">${esc(fmtr.y(l.pts[i][1]))}</span></div>`).join('')}`;
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max(0, cx - 100), W - tip.offsetWidth)}px`;
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { cross.hidden = true; tip.hidden = true; });
  }
}

// Page
function field(k) {
  const f = F[k];
  if (f.choice) {
    return `<div class="t-field t-wide"><span class="lb">${f.label}</span><div class="tools" role="group" aria-label="${esc(f.label)}">${f.choice.map(([v, l]) =>
      `<button type="button" class="chip" data-k="${k}" data-v="${v}" aria-pressed="${state.v[k] === v}">${l}</button>`).join('')}</div></div>`;
  }
  const prices = f.prices && state.data?.series ? ['btc', 'eth', 'sol'].map(a => [a, state.data.series[a]?.points?.at(-1)?.[1]]).filter(([, p]) => p) : [];
  return `<label class="t-field"><span class="lb">${f.label}${f.optional ? ' <span class="muted">(facultatif)</span>' : ''}</span>
    <span class="t-in"><input id="t-${k}" data-k="${k}" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(state.v[k])}"><span class="u">${f.unit}</span></span>
    ${f.hint ? `<span class="hint">${f.hint}</span>` : ''}
    ${prices.length ? `<span class="t-quick">${prices.map(([a, p]) => `<button type="button" class="chip" data-price="${a}" data-p="${p}">${a.toUpperCase()} ${px(p)}</button>`).join('')}</span>` : ''}</label>`;
}

function renderResult() {
  const t = TOOLS.find(x => x.id === state.tool);
  charts = [];
  const box = $('outil-res');
  box.innerHTML = `<h2>Résultat</h2><div class="t-out">${t.calc()}</div>`;
  drawCharts(box);
  for (const k of t.fields) {
    const input = $(`t-${k}`);
    if (input) input.classList.toggle('bad', num(state.v[k]) == null && !(F[k].optional && state.v[k].trim() === ''));
  }
}

function render() {
  const t = TOOLS.find(x => x.id === state.tool);
  $('outils-tabs').innerHTML = TOOLS.map(x => `<a class="chip" href="#outils/${x.id}" aria-pressed="${x.id === t.id}">${x.name}</a>`).join('');
  $('outil').innerHTML = `<div class="box t-form"><h2>${t.name}</h2><p class="txt">${t.intro}</p>
    <form class="t-fields" onsubmit="return false">${t.fields.map(field).join('')}</form>
    <div class="links"><button type="button" class="btn" id="t-reset">Valeurs par défaut</button></div></div>
    <div class="box t-res" id="outil-res"></div>`;
  renderResult();
  // Sur mobile, la ligne des outils défile : on centre l'outil choisi sans faire bouger la page.
  const tabs = $('outils-tabs'), on = tabs.querySelector('[aria-pressed="true"]');
  if (on) tabs.scrollLeft = on.offsetLeft - tabs.offsetLeft - (tabs.clientWidth - on.offsetWidth) / 2;
}

export function showTool(id) {
  if (TOOLS.some(t => t.id === id)) state.tool = id;
  save();
  render();
}

export function setOutilsData(marche) {
  state.data = marche;
  if (location.hash.slice(1).split('/')[0] === 'outils') render();
}

const page = $('page-outils');
page.addEventListener('input', e => {
  const k = e.target.dataset?.k;
  if (!k) return;
  state.v[k] = e.target.value;
  if (k === 'entry') delete state.v.entryAsset;
  save();
  renderResult();
});
page.addEventListener('click', e => {
  const c = e.target.closest('button[data-k]');
  if (c) {
    state.v[c.dataset.k] = c.dataset.v;
    c.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === c)));
    save();
    renderResult();
    return;
  }
  const p = e.target.closest('button[data-price]');
  if (p) {
    const v = Number(p.dataset.p);
    state.v.entry = String(Number(v.toPrecision(6)));
    state.v.entryAsset = p.dataset.price;
    $('t-entry').value = state.v.entry;
    save();
    renderResult();
    return;
  }
  if (e.target.id === 't-reset') {
    const t = TOOLS.find(x => x.id === state.tool);
    for (const k of t.fields) state.v[k] = DEFAULTS[k];
    delete state.v.entryAsset;
    save();
    render();
  }
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (page.classList.contains('on')) renderResult(); }, 150);
});
