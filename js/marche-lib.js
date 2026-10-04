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
// Actifs du monde réel mis sur la blockchain (prêts immobiliers, bons du Trésor…) : pas des cryptos qu'on trade.
const NOT_COINS = /usd|_|^dai$|^wbtc$|^weth$|^steth$|^wsteth$|^weeth$|^wbeth$|^cbbtc$|^lbtc$|^susde$|^bsc-usd$|^buidl$/i;
export const realCoins = list => list.filter(c => !NOT_COINS.test(c.symbol) && !/wrapped|staked|bridged|tokenized|treasury|heloc/i.test(c.name));
