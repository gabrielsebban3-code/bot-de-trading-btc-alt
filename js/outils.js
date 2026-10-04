// Onglet Outils : deux catégories. Simulateurs (calculs faits dans le navigateur, js/outils-lib.js) et
// données du marché (flux ETF, funding, long / short, préparés chaque heure dans data/outils.json).
// Les champs communs (capital, risque, prix…) passent d'un outil à l'autre et sont gardés sur l'appareil.
import { ago, esc, fmt, price } from './format.js';
import { drawPanes } from './chart.js';
import { averageEntry, compound, convert, dca, dcaProjection, num, riskReward, streaks } from './outils-lib.js';
import { annualFunding, flowSummary } from './outils-data.js';

const $ = id => document.getElementById(id);
const KEY = 'dinexo-outils';

// Gagnants 32 % et gain moyen 5,8R : bilan du backtest des Setups (102 trades, +122 %), 1 % risqué par trade.
const DEFAULTS = {
  capital: '10000', risk: '1', entry: '85000', stop: '83000', target: '95000', fee: '0.05',
  winrate: '32', winR: '5.8', trades: '30',
  asset: 'btc', dcaMode: 'past', amount: '100', every: '7', since: '730', years: '5', drift: '1', spotFee: '0.1',
  rate: '2', months: '36', monthly: '0', goal: '50000',
  buys: JSON.stringify([['100000', '1000'], ['90000', '1000'], ['80000', '1000']]), now: '85000', avgTarget: '87000',
  convAmount: '1', convFrom: 'BTC', convTo: 'EUR',
  etfAsset: 'btc', etfPeriod: '90', lsAsset: 'btc',
};

const F = {
  capital: { label: 'Capital du compte', unit: '$' },
  risk: { label: 'Risque par trade', unit: '% du capital' },
  entry: { label: "Prix d'entrée", unit: '$', prices: true },
  stop: { label: 'Stop', unit: '$' },
  target: { label: 'Objectif', unit: '$' },
  fee: { label: 'Frais par côté', unit: '%', hint: 'OKX perpétuels : 0,05 % (taker), 0,02 % (maker)' },
  spotFee: { label: 'Frais par achat', unit: '%', hint: 'OKX comptant : 0,1 %' },
  winrate: { label: 'Trades gagnants', unit: '%', hint: 'Setups : 32 % (2 trades sur 3 finissent au stop)' },
  winR: { label: "Gain moyen d'un gagnant", unit: 'R', hint: '1R = la somme risquée. Setups : 5,8R' },
  trades: { label: 'Nombre de trades', unit: 'trades', hint: 'Setups : environ 30 par an' },
  asset: { label: 'Actif', choice: [['btc', 'BTC'], ['eth', 'ETH'], ['sol', 'SOL']] },
  dcaMode: { label: 'Mode', choice: [['past', 'Rejouer le passé'], ['future', "Projeter l'avenir"]] },
  amount: { label: 'Montant de chaque achat', unit: '$' },
  every: { label: 'Fréquence', choice: [['1', 'Jour'], ['7', 'Semaine'], ['14', '2 semaines'], ['30', 'Mois']] },
  since: { label: 'Depuis', choice: [['182', '6 mois'], ['365', '1 an'], ['730', '2 ans'], ['1095', '3 ans'], ['1460', '4 ans']] },
  years: { label: 'Pendant', choice: [['1', '1 an'], ['3', '3 ans'], ['5', '5 ans'], ['10', '10 ans'], ['20', '20 ans']] },
  drift: { label: 'Hypothèse', choice: [['1', 'Comme le passé'], ['0.5', 'Moitié moins de hausse'], ['0', 'Aucune hausse']] },
  rate: { label: 'Gain moyen par mois', unit: '%', hint: 'Setups en backtest : environ +1,9 % par mois' },
  months: { label: 'Durée', unit: 'mois' },
  monthly: { label: 'Ajout chaque mois', unit: '$' },
  goal: { label: 'Objectif de capital', unit: '$', optional: true },
  buys: { label: 'Tes achats', buys: true },
  now: { label: 'Prix actuel', unit: '$', prices: true },
  avgTarget: { label: 'Prix moyen visé', unit: '$', optional: true, hint: 'combien racheter maintenant pour y arriver' },
  convAmount: { label: 'Montant', unit: '' },
  convFrom: { label: 'De', choice: [['BTC', 'BTC'], ['ETH', 'ETH'], ['SOL', 'SOL'], ['USD', '$'], ['EUR', '€']] },
  convTo: { label: 'Vers', choice: [['BTC', 'BTC'], ['ETH', 'ETH'], ['SOL', 'SOL'], ['USD', '$'], ['EUR', '€']] },
  etfAsset: { label: 'ETF', choice: [['btc', 'Bitcoin'], ['eth', 'Ether']] },
  etfPeriod: { label: 'Période', choice: [['30', '1 mois'], ['90', '3 mois'], ['365', '1 an'], ['all', 'Tout']] },
  lsAsset: { label: 'Actif', choice: [['btc', 'BTC'], ['eth', 'ETH']] },
};

const CATS = [['sim', 'Simulateurs'], ['data', 'Données du marché']];
const TOOLS = [
  { id: 'dca', cat: 'sim', name: 'Simulateur DCA', calc: dcaTool,
    fields: () => (state.v.dcaMode === 'future' ? ['asset', 'dcaMode', 'amount', 'every', 'years', 'drift', 'spotFee'] : ['asset', 'dcaMode', 'amount', 'every', 'since', 'spotFee']),
    intro: () => (state.v.dcaMode === 'future'
      ? "Et si tu achetais la même somme régulièrement pendant des années ? Le simulateur reprend les vraies variations des 4 dernières années par tranches d'un mois, les remet dans un ordre au hasard et joue 1 000 avenirs possibles."
      : "Acheter la même somme à intervalle régulier, rejoué sur les vrais prix de clôture d'OKX, comparé à tout acheter d'un coup le premier jour.") },
  { id: 'compose', cat: 'sim', name: 'Intérêts composés', calc: compose, fields: () => ['capital', 'rate', 'months', 'monthly', 'goal'],
    intro: () => 'Ce que devient le compte si les gains restent investis chaque mois, et quand un objectif serait atteint.' },
  { id: 'series', cat: 'sim', name: 'Séries de pertes', calc: series, fields: () => ['winrate', 'winR', 'risk', 'trades'],
    intro: () => "Avec une stratégie qui gagne 1 trade sur 3, il y aura forcément des périodes où rien ne marche. Cet outil te dit à l'avance combien de pertes d'affilée et quelle baisse du compte sont normales, pour ne pas paniquer et changer de méthode au mauvais moment.",
    how: [
      'Le simulateur joue 2 000 fois ta série de trades en tirant chaque trade au hasard : gagné 32 fois sur 100, perdu sinon.',
      'Un trade perdu coûte ton risque (1 % du compte). Un trade gagné rapporte le gain moyen (5,8 fois le risque).',
      'Sur ces 2 000 parcours, il regarde la plus longue série de pertes et la plus grosse baisse du compte depuis son plus haut.',
      '« Pire cas normal » : seulement 1 parcours sur 20 fait pire. C\'est le chiffre à garder en tête pour ne pas lâcher la stratégie trop tôt.',
    ] },
  { id: 'moyen', cat: 'sim', name: "Prix moyen d'entrée", calc: moyen, fields: () => ['buys', 'now', 'avgTarget', 'spotFee'],
    intro: () => "Ton prix moyen après plusieurs achats du même actif, ce que vaut la position au prix actuel, et combien racheter maintenant pour faire baisser (ou monter) ce prix moyen." },
  { id: 'rr', cat: 'sim', name: 'Risque / rendement', calc: rr, fields: () => ['entry', 'stop', 'target', 'fee', 'winrate', 'risk'],
    intro: () => "Ce que rapporte l'objectif par rapport à ce que coûte le stop, et le pourcentage de trades gagnants qu'il faut pour ne pas perdre d'argent sur la durée." },
  { id: 'convertir', cat: 'sim', name: 'Convertisseur', calc: convertir, fields: () => ['convAmount', 'convFrom', 'convTo'],
    intro: () => "BTC, ETH, SOL, dollars et euros entre eux, au dernier prix connu : OKX pour les cryptos, Banque centrale européenne pour l'euro." },
  { id: 'etf', cat: 'data', name: 'Flux des ETF', calc: etfTool, fields: () => ['etfAsset', 'etfPeriod'],
    intro: () => "L'argent qui entre ou sort chaque jour des ETF bitcoin et ether au comptant cotés aux États-Unis (BlackRock, Fidelity…). Des entrées fortes plusieurs jours de suite montrent que les gros investisseurs achètent.",
    how: [
      "Barre verte : plus d'argent est entré que sorti ce jour-là. Barre rouge : l'inverse.",
      'Une seule journée ne veut pas dire grand-chose : regarde plutôt les sommes sur 5 et 20 jours, et les séries.',
      'Les chiffres arrivent après la clôture de la bourse américaine : ceux du jour sont là le lendemain matin, heure de Paris.',
    ] },
  { id: 'funding', cat: 'data', name: 'Funding des perpétuels', calc: fundingTool, fields: () => [],
    intro: () => "Le funding, c'est ce que les acheteurs et les vendeurs de contrats perpétuels se versent toutes les 8 heures pour garder le prix collé au comptant. Il montre de quel côté penchent les traders à levier.",
    how: [
      'Positif : les longs paient les shorts, beaucoup de traders parient sur la hausse.',
      'Négatif : les shorts paient les longs, beaucoup parient sur la baisse.',
      "Normal : autour de +0,01 % par 8 h. Au-delà de +0,05 %, le marché est très chargé en longs et une baisse peut les liquider en chaîne. Très négatif : même risque dans l'autre sens (squeeze).",
    ] },
  { id: 'longshort', cat: 'data', name: 'Long / short', calc: longShortTool, fields: () => ['lsAsset'],
    intro: () => 'Le nombre de comptes en position longue pour un compte en short sur les contrats OKX. Les petits traders ont souvent tort aux extrêmes : un ratio très haut est plutôt un signal de prudence.',
    how: [
      'Ratio 2 : deux comptes long pour un short. Ratio 1 : autant des deux côtés.',
      "Le ratio compte des comptes, pas des montants : un gros trader pèse autant qu'un petit.",
      "À lire avec la tendance (onglet Marché) : il sert surtout à repérer un excès d'optimisme ou de pessimisme.",
    ] },
];

const state = { tool: 'dca', v: { ...DEFAULTS }, marche: null, outils: null };
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  if (TOOLS.some(t => t.id === saved.tool)) state.tool = saved.tool;
  for (const [k, v] of Object.entries(saved.v || {})) if (k in DEFAULTS && typeof v === 'string') state.v[k] = v;
} catch { /* stockage indisponible */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ tool: state.tool, v: state.v })); } catch { /* stockage indisponible */ } };
const tool = () => TOOLS.find(x => x.id === state.tool);

// Mise en forme
const usd = n => (n == null || !Number.isFinite(n) ? '—' : `${n < 0 ? '−' : ''}${fmt(Math.abs(n), Math.abs(n) >= 1000 ? 0 : 2)} $`);
const signed = n => `<span class="${n >= 0 ? 'up' : 'down'}">${n >= 0 ? '+' : '−'}${usd(Math.abs(n))}</span>`;
const pc = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : `${fmt(n, d)} %`);
const spc = (n, d = 2) => `<span class="${n >= 0 ? 'up' : 'down'}">${n >= 0 ? '+' : '−'}${fmt(Math.abs(n), d)} %</span>`;
const qty = n => fmt(n, n >= 1000 ? 0 : n >= 10 ? 2 : n >= 1 ? 4 : 6);
const px = price;
const plain = n => n.toLocaleString('fr-FR', { maximumFractionDigits: 8 }); // montant tapé, sans zéros ajoutés
// Axe des graphiques en dollars : les millions en plus court.
const usdAxis = n => {
  const a = Math.abs(n);
  return `${n < 0 ? '−' : ''}${a >= 1e6 ? `${fmt(a / 1e6, a >= 1e7 ? 1 : 2)} M$` : `${fmt(a, a >= 10 || a === 0 ? 0 : 2)} $`}`;
};
const mus = n => `${n < 0 ? '−' : '+'}${fmt(Math.abs(n), Math.abs(n) >= 100 ? 0 : 1)} M$`; // millions de dollars signés
const smus = n => `<span class="${n >= 0 ? 'up' : 'down'}">${mus(n)}</span>`;
const day = n => new Date(n * 86_400_000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dur = m => (m < 12 ? `${m} mois` : `${fmt(Math.floor(m / 12))} an${m >= 24 ? 's' : ''}${m % 12 ? ` et ${m % 12} mois` : ''}`);
const rows = list => `<dl>${list.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
const hero = (k, v, sub = '') => `<div class="t-hero"><span class="k">${k}</span><b class="num">${v}</b>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
const note = (txt, cls = '') => `<p class="t-note ${cls}">${txt}</p>`;
const missing = () => '<div class="empty">Remplis les champs avec des nombres pour voir le résultat.</div>';
const noData = () => '<div class="empty">Ces données ne sont pas encore disponibles : elles sont mises à jour automatiquement toutes les heures.</div>';

function vals(keys) {
  const o = {};
  for (const k of keys) o[k] = F[k].choice ? state.v[k] : num(state.v[k]);
  return o;
}

// Simulateur DCA : rejouer le passé ou projeter l'avenir
function dcaTool() {
  const s = state.marche?.series?.[state.v.asset];
  if (!s?.points?.length) return '<div class="empty">Les prix historiques ne sont pas encore chargés. Ils viennent de la mise à jour automatique du site.</div>';
  const sym = state.v.asset.toUpperCase();
  const v = vals(['amount', 'spotFee']);
  const every = Number(state.v.every);
  if (state.v.dcaMode === 'future') {
    const years = Number(state.v.years);
    const drift = Number(state.v.drift);
    const r = dcaProjection(s.points, { amount: v.amount, every, years, drift, feePct: v.spotFee ?? 0 });
    if (!r) return missing();
    const gain = x => spc((x / r.invested - 1) * 100, 0);
    return [
      hero(`Dans ${years} an${years > 1 ? 's' : ''}, scénario du milieu`, usd(r.final.p50), `pour ${usd(r.invested)} investis en ${r.buys} achats de ${usd(v.amount)}`),
      rows([
        ['Scénario pessimiste (1 fois sur 10 en dessous)', `${usd(r.final.p10)} · ${gain(r.final.p10)}`],
        ['Scénario du milieu', `${usd(r.final.p50)} · ${gain(r.final.p50)}`],
        ['Scénario optimiste (1 fois sur 10 au-dessus)', `${usd(r.final.p90)} · ${gain(r.final.p90)}`],
        ['Chance de finir sous la somme investie', pc(r.lossOdds, 0)],
        [`Hausse moyenne de ${sym} supposée`, `${spc(r.usedCagr, 0)} par an`],
      ]),
      chart([
        { name: 'Milieu', cls: 'c-main', pts: r.checkpoints.map(c => [c[0], c[3]]) },
        { name: 'Optimiste', cls: 'c-high', pts: r.checkpoints.map(c => [c[0], c[4]]) },
        { name: 'Pessimiste', cls: 'c-low', pts: r.checkpoints.map(c => [c[0], c[2]]) },
        { name: 'Argent investi', cls: 'c-paid', pts: r.checkpoints.map(c => [c[0], c[1]]) },
      ], { title: 'Valeur du portefeuille', y: usd, axis: usdAxis, x: m => `après ${dur(m)}`, ticks: yearTicks }),
      note(drift === 1
        ? `Base : les ${fmt(r.histYears, 1)} dernières années de ${sym} sur OKX, où il a pris ${spc(r.histCagr, 0)} par an en moyenne. C'est une période très haussière : rien ne garantit que ${sym} refasse aussi bien sur ${years} ans. Compare avec « Moitié moins de hausse » et « Aucune hausse ».`
        : `Mêmes secousses que les ${fmt(r.histYears, 1)} dernières années, avec ${drift ? 'moitié moins de' : 'aucune'} hausse de fond. Ce n'est pas une prévision : c'est une fourchette de ce qui peut arriver.`, 'warn-inline'),
    ].join('');
  }
  const last = s.points.at(-1)[0];
  const startDay = Math.max(s.points[0][0], last - Number(state.v.since));
  const r = dca(s.points, { amount: v.amount, every, startDay, feePct: v.spotFee ?? 0 });
  if (!r) return missing();
  const better = r.value >= r.lump.value;
  return [
    hero("Valeur aujourd'hui", usd(r.value), `${spc(r.returnPct, 1)} pour ${usd(r.invested)} investis en ${r.buys} achats`),
    rows([
      ['Prix moyen payé', `${px(r.avgPrice)} $ · ${sym} vaut ${px(r.lastPrice)} $`],
      ['Quantité accumulée', `${qty(r.units)} ${sym}`],
      ['Tout acheter le premier jour', `${usd(r.lump.value)} · ${spc(r.lump.returnPct, 1)} (à ${px(r.lump.price)} $)`],
      ['Pire moment', r.worst.day != null ? `${spc(r.worst.pct, 1)} le ${day(r.worst.day)}` : 'jamais en perte'],
    ]),
    chart([
      { name: 'DCA', cls: 'c-main', pts: r.series.map(x => [x[0], x[2]]) },
      { name: 'Achat unique', cls: 'c-alt', pts: r.series.map(x => [x[0], x[3]]) },
      { name: 'Argent investi', cls: 'c-paid', pts: r.series.map(x => [x[0], x[1]]) },
    ], { title: 'Valeur du portefeuille', y: usd, axis: usdAxis, x: day, dates: true }),
    note(better
      ? "Sur cette période, le DCA a fait mieux qu'un achat unique : les achats réguliers ont profité des baisses."
      : "Sur cette période, tout acheter le premier jour a fait mieux : le prix a surtout monté. Le DCA sert à lisser le risque d'acheter au mauvais moment, pas à gagner plus."),
  ].join('');
}

// Intérêts composés
function compose() {
  const v = vals(['capital', 'rate', 'months', 'monthly', 'goal']);
  const r = compound({ capital: v.capital ?? 0, ratePct: v.rate, months: Math.round(v.months ?? 0), monthly: v.monthly ?? 0, target: v.goal });
  if (!r) return missing();
  return [
    hero(`Capital après ${dur(Math.round(v.months))}`, usd(r.final), r.multiple ? `×${fmt(r.multiple, 2)} le capital de départ` : ''),
    rows([
      ['Argent versé', usd(r.paid)],
      ['Gains', signed(r.gains)],
      ['Gain sur un an à ce rythme', spc(((1 + v.rate / 100) ** 12 - 1) * 100, 1)],
      v.goal > 0 && [`Objectif de ${usd(v.goal)}`, r.reach == null ? 'pas atteint en 100 ans' : r.reach === 0 ? 'déjà atteint' : `atteint après ${dur(r.reach)}`],
    ]),
    chart([
      { name: 'Capital', cls: 'c-main', pts: r.series.map(x => [x[0], x[2]]) },
      { name: 'Argent versé', cls: 'c-paid', pts: r.series.map(x => [x[0], x[1]]) },
    ], { title: 'Capital du compte', y: usd, axis: usdAxis, x: m => `après ${dur(m)}`, tick: m => `${m} mois` }),
    note("Un rythme régulier chaque mois n'existe pas en trading : certains mois perdent. C'est un ordre de grandeur, pas une promesse."),
  ].join('');
}

// Séries de pertes
function series() {
  const v = vals(['winrate', 'winR', 'risk', 'trades']);
  const r = streaks({ winRatePct: v.winrate, winR: v.winR, riskPct: v.risk, trades: Math.round(v.trades ?? 0) });
  if (!r) return missing();
  const n = Math.round(v.trades);
  const signedPct = y => `${y >= 0 ? '+' : '−'}${fmt(Math.abs(y), 1)} %`;
  return [
    hero(`Sur ${n} trades, prépare-toi à`, `${r.losingStreak.p95} pertes d'affilée`, `C'est le pire cas normal : 1 parcours sur 20 fait pire. Dans un parcours moyen, ${r.losingStreak.median} d'affilée.`),
    rows([
      ['Baisse du compte à encaisser', `−${pc(r.drawdown.p95, 1)} au pire cas normal · −${pc(r.drawdown.median, 1)} en moyenne`],
      [`Résultat après ${n} trades`, `${spc(r.final.median, 1)} en moyenne`],
      ['Fourchette (9 parcours sur 10)', `de ${spc(r.final.p5, 1)} à ${spc(r.final.p95, 1)}`],
      ['Chance de finir en perte', pc(r.lossOdds, 0)],
      ['Gain moyen par trade', `${r.expectancyR >= 0 ? '+' : '−'}${fmt(Math.abs(r.expectancyR), 2)} fois le risque`],
    ]),
    chart([
      { name: 'Parcours moyen', cls: 'c-main', pts: r.curves.median.map((y, i) => [i, y]) },
      { name: 'Chanceux', cls: 'c-high', pts: r.curves.p95.map((y, i) => [i, y]) },
      { name: 'Malchanceux', cls: 'c-low', pts: r.curves.p5.map((y, i) => [i, y]) },
    ], { title: 'Gain ou perte du compte', y: signedPct, x: i => `après ${i} trade${i > 1 ? 's' : ''}`, tick: i => `trade ${i}`, ref: 0 }),
    note(`Chanceux et malchanceux : 1 parcours sur 20 fait mieux ou pire. En clair : si tu enchaînes ${r.losingStreak.p95} pertes, la stratégie n'est pas cassée, c'est prévu. Le danger, c'est d'augmenter le risque pour se refaire, ou d'arrêter juste avant les gros gagnants qui paient tout.`),
  ].join('');
}

// Prix moyen d'entrée : autant d'achats que tu veux
function buysList() {
  try {
    const a = JSON.parse(state.v.buys);
    if (Array.isArray(a) && a.length) return a.map(b => [String(b?.[0] ?? ''), String(b?.[1] ?? '')]).slice(0, 50);
  } catch { /* liste abîmée : on repart des valeurs de départ */ }
  return JSON.parse(DEFAULTS.buys);
}
function moyen() {
  const v = vals(['now', 'avgTarget', 'spotFee']);
  const buys = buysList().map(([p, a]) => ({ price: num(p), amount: num(a) }));
  const r = averageEntry(buys, { current: v.now, target: v.avgTarget, feePct: v.spotFee ?? 0 });
  if (!r) return missing();
  const out = [hero("Prix moyen d'entrée", `${px(r.avg)} $`, `${r.count} achat${r.count > 1 ? 's' : ''} · ${usd(r.invested)} investis · frais compris`)];
  if (r.value != null) {
    out.push(rows([
      ['Valeur au prix actuel', `${usd(r.value)} · ${signed(r.pnl)} (${spc(r.pnlPct, 1)})`],
      ['Quantité', qty(r.units)],
      ['Hausse nécessaire pour revenir à zéro', r.toBreakEvenPct > 0 ? spc(r.toBreakEvenPct, 1) : 'déjà en gain'],
      v.avgTarget > 0 && [`Pour un prix moyen à ${px(v.avgTarget)} $`, r.toTarget != null ? `acheter ${usd(r.toTarget)} maintenant` : 'impossible : le prix visé doit être entre le prix actuel et ton prix moyen'],
    ]));
    if (r.toTarget != null && r.toTarget > r.invested) out.push(note('Pour y arriver, il faut remettre plus que tout ce que tu as déjà investi. Moyenner à la baisse grossit la position sur un actif qui baisse : à faire avec un plan, pas pour se refaire.', 'warn-inline'));
  }
  return out.join('');
}

// Risque / rendement
function rr() {
  const v = vals(['entry', 'stop', 'target', 'fee', 'winrate', 'risk']);
  const r = riskReward({ entry: v.entry, stop: v.stop, target: v.target, feePct: v.fee ?? 0, winRatePct: v.winrate });
  if (!r) return missing();
  const wrong = r.rawRR <= 0;
  const out = [hero(`Ratio R:R (${r.side}, frais compris)`, wrong ? '—' : `1 : ${fmt(r.rr, 2)}`, wrong ? '' : `brut 1 : ${fmt(r.rawRR, 2)}`)];
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

// Convertisseur. Valeur d'une unité en dollars : clôtures du site, puis OKX en direct ; euro : BCE.
const rates = { USD: 1 };
const rateSrc = {};
let live = null;
function seedRates() {
  for (const s of ['BTC', 'ETH', 'SOL']) {
    const p = state.marche?.series?.[s.toLowerCase()]?.points?.at(-1)?.[1];
    if (p && rateSrc[s] !== 'OKX en direct') { rates[s] = p; rateSrc[s] = 'dernière clôture'; }
  }
  const e = state.outils?.eur;
  if (e?.usd && !rateSrc.EUR?.startsWith('BCE, en direct')) { rates.EUR = e.usd; rateSrc.EUR = `BCE, ${e.date}`; }
}
function liveRates() {
  if (live) return live;
  live = Promise.all([
    ...['BTC', 'ETH', 'SOL'].map(s => fetch(`https://www.okx.com/api/v5/market/ticker?instId=${s}-USDT`).then(r => r.json())
      .then(j => { const p = Number(j.data?.[0]?.last); if (p > 0) { rates[s] = p; rateSrc[s] = 'OKX en direct'; } })),
    fetch('https://api.frankfurter.app/latest?from=EUR&to=USD').then(r => r.json())
      .then(j => { const p = Number(j.rates?.USD); if (p > 0) { rates.EUR = p; rateSrc.EUR = `BCE, en direct (${j.date})`; } }),
  ].map(p => p.catch(() => {}))).then(() => { if (page.classList.contains('on') && state.tool === 'convertir') renderResult(); });
  return live;
}
function convertir() {
  liveRates();
  const v = vals(['convAmount', 'convFrom', 'convTo']);
  const r = convert(v.convAmount, v.convFrom, v.convTo, rates);
  const sym = c => ({ USD: '$', EUR: '€' })[c] || c;
  const shown = (n, c) => (['USD', 'EUR'].includes(c) ? `${fmt(n, n >= 1000 ? 0 : 2)} ${sym(c)}` : `${qty(n)} ${c}`);
  const typed = (n, c) => `${plain(n)} ${sym(c)}`;
  if (r == null) {
    if (v.convAmount == null) return missing();
    const gone = [v.convFrom, v.convTo].filter(c => !rates[c]).map(sym).join(' et ');
    return `<div class="empty">Le cours ${esc(gone)} n'a pas pu être chargé. Réessaie dans un instant.</div>`;
  }
  return [
    hero(`${typed(v.convAmount, v.convFrom)} =`, shown(r, v.convTo)),
    rows(['BTC', 'ETH', 'SOL', 'EUR'].filter(c => rates[c]).map(c => [`1 ${sym(c)}`, `${fmt(rates[c], rates[c] >= 100 ? 0 : 4)} $ <span class="muted">· ${rateSrc[c]}</span>`])),
  ].join('');
}

// Flux des ETF
function etfTool() {
  const etf = state.outils?.etf?.[state.v.etfAsset];
  const s = flowSummary(etf);
  if (!s) return noData();
  const name = state.v.etfAsset === 'btc' ? 'bitcoin' : 'ether';
  const n = state.v.etfPeriod === 'all' ? etf.days.length : Math.round(Number(state.v.etfPeriod) * 5 / 7); // jours de bourse
  const shown = etf.days.slice(-n);
  const streak = s.streak === 0 ? '' : `${Math.abs(s.streak)} jour${Math.abs(s.streak) > 1 ? 's' : ''} ${s.streak > 0 ? "d'entrées" : 'de sorties'} d'affilée`;
  return [
    hero(`ETF ${name}, ${day(s.last.day)}`, smus(s.last.total), streak),
    rows([
      ['5 derniers jours de bourse', smus(s.d5)],
      ['20 derniers jours de bourse', smus(s.d20)],
      [etf.days.length > 300 ? 'Depuis le lancement' : `Depuis le ${day(etf.days[0][0])}`, smus(s.total)],
    ]),
    chart([{ name: 'Flux du jour', bars: true, pts: shown.map(d => [d[0], d[1]]) }], { title: 'Flux quotidiens', y: mus, x: day, dates: true }),
    `<div class="t-sub">Par émetteur, 20 derniers jours de bourse</div><div class="wrap flat"><table class="static"><thead><tr><th class="l">ETF</th><th>Dernier jour</th><th>20 jours</th></tr></thead><tbody>${
      s.byIssuer.slice(0, 8).map(i => `<tr><td class="l">${esc(i.name)}</td><td class="num">${smus(i.last)}</td><td class="num">${smus(i.d20)}</td></tr>`).join('')}</tbody></table></div>`,
    note(`Source : farside.co.uk, en millions de dollars. Mis à jour ${ago(state.outils.generatedAt)}.`),
  ].join('');
}

// Funding des perpétuels
function fundingTool() {
  const list = state.outils?.funding;
  if (!list?.length) return noData();
  const sorted = [...list].sort((a, b) => b.okx - a.okx);
  const btc = list.find(f => f.sym === 'BTC');
  const avg = list.reduce((s, f) => s + f.okx, 0) / list.length;
  const mood = avg > 0.03 ? 'Les traders sont très chargés en longs' : avg > 0.005 ? 'Les traders penchent un peu vers la hausse' : avg < -0.01 ? 'Les traders sont chargés en shorts' : 'Le levier est calme';
  const f4 = v => (v == null ? '<span class="muted">—</span>' : `<span class="${v > 0.03 ? 'down' : v < -0.01 ? 'up' : ''}">${v >= 0 ? '+' : '−'}${fmt(Math.abs(v), 4)} %</span>`);
  return [
    hero('Funding moyen des 20 plus gros perpétuels', `${avg >= 0 ? '+' : '−'}${fmt(Math.abs(avg), 4)} %`, `${mood}. Par 8 h sur OKX${btc ? ` · BTC ${btc.okx >= 0 ? '+' : '−'}${fmt(Math.abs(btc.okx), 4)} %` : ''}.`),
    `<div class="wrap flat"><table class="static"><thead><tr><th class="l">Actif</th><th>OKX / 8 h</th><th>Hyperliquid / 8 h</th><th>Sur un an</th></tr></thead><tbody>${
      sorted.map(f => `<tr><td class="l">${esc(f.sym)}</td><td class="num">${f4(f.okx)}</td><td class="num">${f4(f.hyperliquid)}</td><td class="num">${spc(annualFunding(f.okx), 1)}</td></tr>`).join('')}</tbody></table></div>`,
    note(`En rouge : funding élevé, beaucoup de longs à levier (risque de chute en chaîne). En vert : funding négatif, beaucoup de shorts (risque de squeeze à la hausse). « Sur un an » : ce que toucherait un short gardé un an à ce taux. Mis à jour ${ago(state.outils.generatedAt)}.`),
  ].join('');
}

// Long / short
function longShortTool() {
  const pts = state.outils?.longShort?.[state.v.lsAsset];
  if (!pts?.length) return noData();
  const last = pts.at(-1)[1];
  const longPct = last / (1 + last) * 100;
  const sorted = pts.map(p => p[1]).sort((a, b) => a - b);
  const rank = sorted.filter(v => v <= last).length / sorted.length * 100;
  const read = rank > 85 ? "Très haut par rapport aux derniers mois : beaucoup d'optimisme, prudence sur les achats."
    : rank < 15 ? 'Très bas par rapport aux derniers mois : beaucoup de pessimisme, souvent proche d\'un rebond.' : "Dans sa zone habituelle : pas d'excès.";
  return [
    hero(`Ratio long / short ${state.v.lsAsset.toUpperCase()} sur OKX`, fmt(last, 2), `${fmt(longPct, 0)} % des comptes sont long, ${fmt(100 - longPct, 0)} % short`),
    rows([
      ['Par rapport aux derniers mois', `plus haut que ${fmt(rank, 0)} % des jours`],
      ['Le plus haut / le plus bas', `${fmt(sorted.at(-1), 2)} / ${fmt(sorted[0], 2)}`],
    ]),
    chart([{ name: 'Ratio long / short', cls: 'c-main', pts }], { title: 'Comptes long pour un compte short', y: y => fmt(y, 2), x: day, dates: true, ref: 1 }),
    note(`${read} Mis à jour ${ago(state.outils.generatedAt)}.`),
  ].join('');
}

// Graphiques : même moteur que l'onglet Marché (js/chart.js), valeurs au-dessus et croix qui suit le curseur.
let charts = [];
function chart(lines, o) {
  charts.push({ lines, o });
  return `<div class="mk-chart t-chart" data-chart="${charts.length - 1}"></div>`;
}
// Graduations rondes pour un axe en mois ou en trades.
const numTicks = label => (start, end, width) => {
  const room = Math.max(2, Math.floor(width / 80));
  const raw = (end - start) / room || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw);
  const out = [];
  for (let v = Math.ceil(start / step) * step; v <= end + 1e-9; v += step) out.push([v, label(v)]);
  return out;
};
// Axe en mois gradué en années.
function yearTicks(start, end, width) {
  const room = Math.max(2, Math.floor(width / 70));
  const years = (end - start) / 12;
  const step = [1, 2, 5, 10].find(s => years / s <= room) || 10;
  const out = [];
  for (let y = step; y * 12 <= end + 1e-9; y += step) out.push([y * 12, `${y} an${y > 1 ? 's' : ''}`]);
  return out;
}
function drawCharts(root) {
  for (const box of root.querySelectorAll('[data-chart]')) {
    const { lines, o } = charts[Number(box.dataset.chart)];
    const xs = lines.flatMap(l => l.pts.map(p => p[0]));
    drawPanes(box, [{
      title: o.title, h: 230, fmt: o.y, axis: o.axis, ref: o.ref, bars: lines.some(l => l.bars), reverse: true,
      lines: lines.map(l => ({ key: l.name, label: l.name, pts: l.pts, cls: l.cls || '', keyCls: l.cls || '' })),
    }], Math.min(...xs), Math.max(...xs), { xLabel: o.x, xTicks: o.ticks || (o.dates ? undefined : numTicks(o.tick || o.x)) });
  }
}

// Page
function field(k) {
  const f = F[k];
  if (f.choice) {
    return `<div class="t-field t-wide"><span class="lb">${f.label}</span><div class="tools" role="group" aria-label="${esc(f.label)}">${f.choice.map(([v, l]) =>
      `<button type="button" class="chip" data-k="${k}" data-v="${v}" aria-pressed="${state.v[k] === v}">${l}</button>`).join('')}</div></div>`;
  }
  if (f.buys) {
    const list = buysList();
    return `<div class="t-field t-wide"><span class="lb">${f.label}</span>
      <div class="t-buys"><span class="lb">Prix d'achat</span><span class="lb">Montant investi</span><span></span>
      ${list.map(([p, a], i) => `<span class="t-in"><input id="t-buy-${i}-p" data-buy="${i}" data-part="0" inputmode="decimal" autocomplete="off" aria-label="Achat ${i + 1} : prix" value="${esc(p)}"><span class="u">$</span></span>
        <span class="t-in"><input id="t-buy-${i}-a" data-buy="${i}" data-part="1" inputmode="decimal" autocomplete="off" aria-label="Achat ${i + 1} : montant" value="${esc(a)}"><span class="u">$</span></span>
        <button type="button" class="t-del" data-del="${i}" aria-label="Retirer l'achat ${i + 1}" ${list.length < 2 ? 'disabled' : ''}>×</button>`).join('')}
      </div><button type="button" class="btn t-add" id="t-addbuy">+ Ajouter un achat</button></div>`;
  }
  const prices = f.prices ? ['BTC', 'ETH', 'SOL'].map(s => [s, rates[s]]).filter(([, p]) => p) : [];
  return `<label class="t-field"><span class="lb">${f.label}${f.optional ? ' <span class="muted">(facultatif)</span>' : ''}</span>
    <span class="t-in"><input id="t-${k}" data-k="${k}" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(state.v[k])}"><span class="u">${f.unit}</span></span>
    ${f.hint ? `<span class="hint">${f.hint}</span>` : ''}
    ${prices.length ? `<span class="t-quick">${prices.map(([s, p]) => `<button type="button" class="chip" data-price="${s}" data-for="${k}" data-p="${p}">${s} ${px(p)}</button>`).join('')}</span>` : ''}</label>`;
}

function renderResult() {
  const t = tool();
  charts = [];
  const box = $('outil-res');
  box.innerHTML = `<h2>${t.cat === 'data' ? 'En ce moment' : 'Résultat'}</h2><div class="t-out">${t.calc()}</div>`;
  drawCharts(box);
  for (const k of t.fields()) {
    const input = $(`t-${k}`);
    if (input) input.classList.toggle('bad', num(state.v[k]) == null && !(F[k].optional && state.v[k].trim() === ''));
  }
  for (const input of page.querySelectorAll('[data-buy]')) input.classList.toggle('bad', input.value.trim() !== '' && num(input.value) == null);
}

function render() {
  const t = tool();
  $('outils-tabs').innerHTML = CATS.map(([c, label]) => `<div class="t-cat"><span class="lb">${label}</span><div class="t-chips">${
    TOOLS.filter(x => x.cat === c).map(x => `<a class="chip" href="#outils/${x.id}" aria-pressed="${x.id === t.id}">${x.name}</a>`).join('')}</div></div>`).join('');
  const fields = t.fields();
  $('outil').innerHTML = `<div class="box t-form"><h2>${t.name}</h2><p class="txt">${t.intro()}</p>
    ${fields.length ? `<form class="t-fields" onsubmit="return false">${fields.map(field).join('')}</form>` : ''}
    ${t.how ? `<div class="t-how"><b>Comment lire</b><ul>${t.how.map(h => `<li>${h}</li>`).join('')}</ul></div>` : ''}
    ${t.cat === 'sim' ? '<div class="links"><button type="button" class="btn" id="t-reset">Valeurs par défaut</button></div>' : ''}</div>
    <div class="box t-res" id="outil-res"></div>`;
  renderResult();
  // Sur mobile, chaque ligne d'outils défile : on centre l'outil choisi sans faire bouger la page.
  const on = $('outils-tabs').querySelector('[aria-pressed="true"]');
  if (on) on.parentElement.scrollLeft = on.offsetLeft - on.parentElement.offsetLeft - (on.parentElement.clientWidth - on.offsetWidth) / 2;
}

export function showTool(id) {
  if (TOOLS.some(t => t.id === id)) state.tool = id;
  save();
  render();
}

export function setOutilsData(marche, outils) {
  state.marche = marche;
  state.outils = outils;
  seedRates();
  if (page.classList.contains('on')) render();
}

const page = $('page-outils');
page.addEventListener('input', e => {
  const d = e.target.dataset || {};
  if (d.buy != null) {
    const list = buysList();
    list[Number(d.buy)][Number(d.part)] = e.target.value;
    state.v.buys = JSON.stringify(list);
  } else if (d.k) state.v[d.k] = e.target.value;
  else return;
  save();
  renderResult();
});
page.addEventListener('click', e => {
  const c = e.target.closest('button[data-k]');
  if (c) {
    state.v[c.dataset.k] = c.dataset.v;
    save();
    render(); // un choix peut changer les champs affichés (DCA : passé ou avenir)
    return;
  }
  const p = e.target.closest('button[data-price]');
  if (p) {
    const k = p.dataset.for;
    state.v[k] = String(Number(Number(p.dataset.p).toPrecision(6)));
    $(`t-${k}`).value = state.v[k];
    save();
    renderResult();
    return;
  }
  const del = e.target.closest('button[data-del]');
  if (del || e.target.id === 't-addbuy') {
    const list = buysList();
    if (del) list.splice(Number(del.dataset.del), 1);
    else list.push(['', '']);
    state.v.buys = JSON.stringify(list);
    save();
    render();
    if (!del) $(`t-buy-${list.length - 1}-p`)?.focus();
    return;
  }
  if (e.target.id === 't-reset') {
    for (const k of tool().fields()) state.v[k] = DEFAULTS[k];
    save();
    render();
  }
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (page.classList.contains('on')) renderResult(); }, 150);
});
