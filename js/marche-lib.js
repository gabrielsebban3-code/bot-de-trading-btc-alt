// Onglet Marché : calculs partagés par le script de données (Node) et la page (navigateur).
// Les séries sont des listes [jour, valeur], le jour étant le nombre de jours depuis le 1er janvier 1970 (UTC).

export const DAY = 86_400_000;
export const dayOf = ms => Math.floor(ms / DAY);

// Une valeur par jour (la dernière du jour, ou la moyenne avec mean = true), triée par jour.
export function toDaily(rows, { mean = false } = {}) {
  const byDay = new Map();
  for (const [ms, v] of rows) {
    if (!Number.isFinite(ms) || !Number.isFinite(v)) continue;
    const d = dayOf(ms);
    const cur = byDay.get(d);
    if (!mean) { if (!cur || ms >= cur.ms) byDay.set(d, { ms, v }); }
    else byDay.set(d, { ms, v: (cur?.v ?? 0) + v, n: (cur?.n ?? 0) + 1 });
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([d, x]) => [d, mean ? x.v / x.n : x.v]);
}

// Fusionne l'historique déjà publié et les nouveaux points (les nouveaux gagnent), sans dépasser maxDays.
export function mergePoints(previous = [], next = [], maxDays = 1500) {
  const m = new Map(previous);
  for (const [d, v] of next) m.set(d, v);
  const out = [...m.entries()].sort((a, b) => a[0] - b[0]);
  return out.slice(-maxDays);
}

// Arrondit à 4 chiffres significatifs pour garder le fichier léger.
export const compact = points => points.map(([d, v]) => [d, Number(v.toPrecision(5))]);

// Moyenne mobile simple sur n points ; null tant qu'il n'y a pas assez d'historique.
export function sma(points, n) {
  let sum = 0;
  return points.map(([d, v], i) => {
    sum += v;
    if (i >= n) sum -= points[i - n][1];
    return [d, i >= n - 1 ? sum / n : null];
  });
}

// Valeur au plus tard `days` jours avant le dernier point.
function back(points, days) {
  if (!points?.length) return null;
  const target = points.at(-1)[0] - days;
  for (let i = points.length - 1; i >= 0; i--) if (points[i][0] <= target) return points[i][1];
  return null;
}
const change = (points, days) => {
  const old = back(points, days);
  return old ? points.at(-1)[1] / old - 1 : null;
};
const abs = (r, d = 1) => `${(Math.abs(r) * 100).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d })} %`;
const pctFr = (r, d = 1) => `${r >= 0 ? '+' : ''}${(r * 100).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d })} %`;
const num = (v, d = 0) => v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

// Seuils de lecture, en un seul endroit.
export const LIMITS = {
  stables: 0.01,      // ±1 % de stablecoins sur 30 jours
  fundingHot: 0.03,   // funding moyen par période de 8 h, en %
  fearLow: 25, greedHigh: 75,
  oiMove: 0.05,       // ±5 % d'open interest sur 7 jours
};

// Les 6 indicateurs du « combo direction », chacun avec un sens : 1 haussier, -1 baissier, 0 neutre.
export function signals(series) {
  const out = [];
  const btc = series.btc?.points;
  if (btc?.length >= 200) {
    const last = btc.at(-1)[1];
    const m50 = sma(btc, 50).at(-1)[1], m200 = sma(btc, 200).at(-1)[1];
    const gap = last / m200 - 1;
    const dir = last > m200 && m50 > m200 ? 1 : last < m200 && m50 < m200 ? -1 : 0;
    out.push({ key: 'trend', label: 'Tendance de fond', dir,
      text: dir === 1 ? `BTC est ${abs(gap)} au-dessus de sa moyenne 200 jours et la moyenne 50 jours est au-dessus : tendance haussière.`
        : dir === -1 ? `BTC est ${abs(gap)} sous sa moyenne 200 jours et la moyenne 50 jours est en dessous : tendance baissière.`
        : `BTC est à ${pctFr(gap)} de sa moyenne 200 jours, mais les moyennes ne sont pas alignées : pas de tendance nette.` });
    const g50 = last / m50 - 1;
    out.push({ key: 'short', label: 'Court terme', dir: g50 > 0 ? 1 : -1,
      text: `BTC est ${abs(g50)} ${g50 > 0 ? 'au-dessus' : 'en dessous'} de sa moyenne 50 jours.` });
  }
  const fng = series.fng?.points;
  if (fng?.length) {
    const v = fng.at(-1)[1], old = back(fng, 7);
    const delta = old != null ? v - old : 0;
    const dir = v <= LIMITS.fearLow ? 1 : v >= LIMITS.greedHigh ? -1 : Math.abs(delta) >= 5 ? Math.sign(delta) : 0;
    out.push({ key: 'fng', label: 'Sentiment', dir,
      text: v <= LIMITS.fearLow ? `Fear & Greed à ${v} : peur extrême, souvent proche d'un creux.`
        : v >= LIMITS.greedHigh ? `Fear & Greed à ${v} : euphorie, souvent proche d'un sommet.`
        : `Fear & Greed à ${v}, ${delta >= 0 ? '+' : ''}${delta} sur 7 jours.` });
  }
  const st = series.stables?.points;
  const c30 = change(st, 30);
  if (c30 != null) {
    const dir = c30 > LIMITS.stables ? 1 : c30 < -LIMITS.stables ? -1 : 0;
    const usd = st.at(-1)[1] - back(st, 30);
    out.push({ key: 'stables', label: 'Argent frais', dir,
      text: `Stablecoins ${pctFr(c30)} sur 30 jours (${usd >= 0 ? '+' : '−'}${num(Math.abs(usd) / 1e9, 1)} Md$) : ${dir === 1 ? "de l'argent entre sur le marché" : dir === -1 ? "de l'argent sort du marché" : 'pas de mouvement net'}.` });
  }
  const fu = series.funding?.points;
  if (fu?.length >= 3) {
    const avg = fu.slice(-3).reduce((s, p) => s + p[1], 0) / 3;
    const dir = avg > LIMITS.fundingHot ? -1 : avg < 0 ? 1 : 0;
    out.push({ key: 'funding', label: 'Levier', dir,
      text: `Funding BTC moyen sur 3 jours : ${num(avg, 4)} % par 8 h. ${dir === -1 ? 'Trop de longs à levier : risque de purge.' : dir === 1 ? 'Les shorts paient les longs : de quoi alimenter une remontée.' : 'Levier calme.'}` });
  }
  const oi = series.oi?.points;
  const oi7 = change(oi, 7), p7 = change(btc, 7);
  if (oi7 != null && p7 != null) {
    const dir = oi7 > LIMITS.oiMove ? (p7 > 0 ? 1 : -1) : 0;
    out.push({ key: 'oi', label: 'Positions ouvertes', dir,
      text: `Open interest BTC ${pctFr(oi7)} sur 7 jours, prix ${pctFr(p7)}. ${dir === 1 ? 'De nouvelles positions suivent la hausse.' : dir === -1 ? 'Les positions s\'empilent pendant la baisse : les vendeurs appuient.' : oi7 < -LIMITS.oiMove ? 'Le levier se vide.' : 'Pas de grosse vague de nouvelles positions.'}` });
  }
  return out;
}

// Verdict global : au moins 2 signaux nets dans un sens.
export function verdict(list) {
  const up = list.filter(s => s.dir === 1).length, down = list.filter(s => s.dir === -1).length;
  const score = up - down;
  return { up, down, total: list.length, dir: score >= 2 ? 1 : score <= -2 ? -1 : 0,
    label: score >= 2 ? 'Plutôt haussier' : score <= -2 ? 'Plutôt baissier' : 'Pas de direction claire' };
}

// Décompte d'un verdict : « 3 signaux haussiers, 1 baissier sur 6 ».
export const tallyText = v => `${v.up} ${v.up > 1 ? 'signaux haussiers' : 'signal haussier'}, ${v.down} baissier${v.down > 1 ? 's' : ''} sur ${v.total}`;

// Stablecoins, versions « wrapped » ou « staked » : dupliquent BTC ou ETH, ou ne bougent pas.
// Actifs du monde réel mis sur la blockchain (prêts immobiliers, bons du Trésor, or…) : pas des cryptos qu'on trade.
const NOT_COINS = /usd|_|^dai$|^wbtc$|^weth$|^steth$|^wsteth$|^weeth$|^wbeth$|^cbbtc$|^lbtc$|^susde$|^bsc-usd$|^buidl$|^xaut$|^paxg$/i;
export const realCoins = list => list.filter(c => !NOT_COINS.test(c.symbol) && !/wrapped|staked|bridged|tokenized|treasury|heloc/i.test(c.name));

// Tri du tableau des cryptos par colonne. Sens de départ : classement croissant, sinon les plus grandes valeurs d'abord
// (pour la tendance : signaux haussiers moins baissiers, d'après la fiche de chaque crypto) ; reverse inverse le sens.
// Les valeurs inconnues restent à la fin ; la liste d'origine n'est pas modifiée.
export function sortTop(list, key, trends = new Map(), reverse = false) {
  const trend = c => (trends.get(c.id) ? trends.get(c.id).up - trends.get(c.id).down : null);
  const value = (c, i) => (key === 'rank' ? -i : key === 'trend' ? trend(c) : c[key] ?? null);
  const sign = reverse ? -1 : 1;
  return list.map((c, i) => [c, value(c, i), i])
    .sort((a, b) => (a[1] == null) - (b[1] == null) || sign * ((b[1] ?? 0) - (a[1] ?? 0)) || a[2] - b[2])
    .map(([c]) => c);
}

// Saison des altcoins : part des n plus grosses cryptos (hors BTC, stablecoins et versions wrapped) qui font mieux
// que BTC sur 30 jours. 75 % ou plus : saison des altcoins ; 25 % ou moins : saison du Bitcoin.
// Liste au format du tableau (symbol en majuscules, change30d en fraction : 0,05 = +5 %).
export function altSeason(list, n = 50) {
  const btc = list.find(c => c.symbol === 'BTC');
  if (btc?.change30d == null) return null;
  const alts = realCoins(list).filter(c => c.symbol !== 'BTC').slice(0, n).filter(c => c.change30d != null);
  if (alts.length < 10) return null;
  const vs = alts.map(c => ({ id: c.id, symbol: c.symbol, name: c.name, vsBtc: (1 + c.change30d) / (1 + btc.change30d) - 1 }));
  const beat = vs.filter(c => c.vsBtc > 0).length;
  const value = Math.round((100 * beat) / vs.length);
  const [dir, label] = value >= 75 ? [1, 'Saison des altcoins'] : value <= 25 ? [-1, 'Saison du Bitcoin'] : [0, 'Pas de saison nette'];
  const ranked = [...vs].sort((a, b) => b.vsBtc - a.vsBtc);
  return { value, beat, total: vs.length, btc30d: btc.change30d, dir, label, best: ranked.slice(0, 5), worst: ranked.slice(-5).reverse() };
}

// Secteurs suivis : identifiant de la catégorie CoinGecko et nom affiché.
export const SECTORS = [
  ['layer-1', 'Layer 1'], ['layer-2', 'Layer 2'], ['decentralized-finance-defi', 'DeFi'], ['meme-token', 'Memecoins'],
  ['artificial-intelligence', 'Intelligence artificielle'], ['ai-agents', 'Agents IA'], ['real-world-assets-rwa', 'Actifs réels (RWA)'],
  ['gaming', 'Jeux vidéo'], ['depin', 'DePIN (réseaux physiques)'], ['exchange-based-tokens', 'Jetons de plateformes'],
  ['privacy-coins', 'Confidentialité'], ['decentralized-exchange', 'Plateformes décentralisées (DEX)'], ['oracle', 'Oracles'],
  ['decentralized-perpetuals', 'Perpétuels décentralisés'], ['lending-borrowing', 'Prêts et emprunts'],
];

// Agenda macro : les annonces américaines à fort impact, plus les décisions de taux de la BCE et de la Banque du Japon,
// avec un nom en français (le titre anglais reste si l'annonce n'est pas dans la liste).
const AGENDA_FR = [
  [/^Core CPI m\/m$/, 'Inflation sous-jacente (CPI) sur un mois'], [/^Core CPI y\/y$/, 'Inflation sous-jacente (CPI) sur un an'],
  [/^CPI m\/m$/, 'Inflation (CPI) sur un mois'], [/^CPI y\/y$/, 'Inflation (CPI) sur un an'],
  [/^Core PPI m\/m$/, 'Prix à la production sous-jacents (PPI)'], [/^PPI m\/m$/, 'Prix à la production (PPI)'],
  [/^Core PCE Price Index m\/m$/, 'Inflation PCE sous-jacente sur un mois'], [/^PCE Price Index m\/m$/, 'Inflation PCE sur un mois'],
  [/^Non-Farm Employment Change$/, "Créations d'emplois (NFP)"], [/^ADP Non-Farm Employment Change$/, 'Emplois privés (ADP)'],
  [/^Unemployment Rate$/, 'Taux de chômage'], [/^Unemployment Claims$/, 'Inscriptions au chômage de la semaine'],
  [/^Average Hourly Earnings m\/m$/, 'Salaire horaire moyen sur un mois'], [/^JOLTS Job Openings$/, "Offres d'emploi (JOLTS)"],
  [/^Federal Funds Rate$/, 'Décision de taux de la Fed'], [/^FOMC Statement$/, 'Communiqué de la Fed'],
  [/^FOMC Press Conference$/, 'Conférence de presse de la Fed'], [/^FOMC Meeting Minutes$/, 'Compte rendu de la réunion de la Fed'],
  [/^FOMC Economic Projections$/, 'Prévisions économiques de la Fed'], [/^Fed Chair (.+) (Speaks|Testifies)$/, 'Discours du président de la Fed ($1)'],
  [/^(Advance|Prelim|Final) GDP q\/q$/, 'Croissance du PIB sur un trimestre'], [/^Core Retail Sales m\/m$/, 'Ventes au détail hors automobile'],
  [/^Retail Sales m\/m$/, 'Ventes au détail sur un mois'], [/^ISM Manufacturing PMI$/, "Activité de l'industrie (ISM)"],
  [/^ISM Services PMI$/, 'Activité des services (ISM)'], [/^(Prelim )?UoM Consumer Sentiment$/, 'Moral des ménages (Michigan)'],
  [/^CB Consumer Confidence$/, 'Confiance des consommateurs'], [/^Main Refinancing Rate$/, 'Décision de taux de la BCE'],
  [/^BOJ Policy Rate$/, 'Décision de taux de la Banque du Japon'],
];
export function agendaFr(title) {
  const hit = AGENDA_FR.find(([re]) => re.test(title));
  return hit ? title.replace(hit[0], hit[1]) : title;
}

// Annonces gardées du calendrier (format ForexFactory : title, country, date avec fuseau, impact, forecast, previous),
// triées par date ; les chiffres prévus et précédents passent à l'écriture française (0.3% → 0,3 %, espace insécable).
const frFigure = s => (s ? String(s).replace(/(\d)\.(\d)/g, '$1,$2').replace(/%/g, '\u00a0%').replace(/(\d)K\b/g, '$1\u00a0k').replace(/(\d)M\b/g, '$1\u00a0M').replace(/(\d)B\b/g, '$1\u00a0Md') : null);
export function agendaEvents(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(r => r?.impact === 'High' && (r.country === 'USD' || /^(Main Refinancing Rate|BOJ Policy Rate)$/.test(r.title)) && Number.isFinite(Date.parse(r.date)))
    .map(r => ({ t: new Date(r.date).toISOString(), title: agendaFr(r.title), en: r.title, cur: r.country, forecast: frFigure(r.forecast), previous: frFigure(r.previous) }))
    .sort((a, b) => a.t.localeCompare(b.t));
}
