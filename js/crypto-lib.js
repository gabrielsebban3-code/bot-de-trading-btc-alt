// Fiche d'une crypto (#crypto/<id>) : calculs partagés par le script de données (Node) et la page (navigateur).
// Une bougie : [temps, ouverture, plus haut, plus bas, clôture, volume en dollars]. Le temps est un numéro de jour
// (jours depuis le 1er janvier 1970, UTC) pour les bougies d'un jour, un numéro d'heure pour celles de 4 h.
import { LIMITS, verdict } from './marche-lib.js';

export { verdict };

// Moyenne mobile simple : une valeur par bougie, null tant qu'il n'y a pas assez d'historique.
export function smaOf(values, n) {
  let sum = 0;
  return values.map((v, i) => {
    sum += v;
    if (i >= n) sum -= values[i - n];
    return i >= n - 1 ? sum / n : null;
  });
}

// Moyenne mobile exponentielle, amorcée par la moyenne simple des n premières valeurs.
export function emaOf(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((s, v) => s + v, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < values.length; i++) out[i] = e = values[i] * k + e * (1 - k);
  return out;
}

// RSI de Wilder sur n bougies, de 0 à 100.
export function rsiOf(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  const rsi = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = rsi();
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = rsi();
  }
  return out;
}

// MACD 12 / 26 / 9 : ligne, signal et histogramme (ligne moins signal).
export function macdOf(closes, fast = 12, slow = 26, signal = 9) {
  const f = emaOf(closes, fast), s = emaOf(closes, slow);
  const line = closes.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const sig = new Array(closes.length).fill(null);
  const start = line.findIndex(v => v != null);
  if (start >= 0) emaOf(line.slice(start), signal).forEach((v, i) => { sig[start + i] = v; });
  return { line, signal: sig, hist: line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null)) };
}

// ATR de Wilder : l'amplitude moyenne d'une bougie, écarts d'ouverture compris.
export function atrOf(candles, n = 14) {
  const out = new Array(candles.length).fill(null);
  let atr = 0;
  for (let i = 1; i < candles.length; i++) {
    const [, , h, l] = candles[i], pc = candles[i - 1][4];
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (i < n) atr += tr;
    else out[i] = atr = i === n ? (atr + tr) / n : (atr * (n - 1) + tr) / n;
  }
  return out;
}

// Paquets de bougies pour les longues périodes : 3 jours, une semaine (du lundi), 8 h, 12 h…
// Chaque paquet garde l'indice de sa dernière bougie d'origine, pour y lire les moyennes et indicateurs.
export const GROUPS = {
  day: [[1, 'Bougies 1 jour', d => d], [3, 'Bougies 3 jours', d => Math.floor(d / 3)], [7, 'Bougies 1 semaine', d => Math.floor((d - 4) / 7)]],
  hour: [[1, 'Bougies 4 h', h => Math.floor(h / 4)], [2, 'Bougies 8 h', h => Math.floor(h / 8)], [3, 'Bougies 12 h', h => Math.floor(h / 12)], [6, 'Bougies 1 jour', h => Math.floor(h / 24)]],
};

export function groupCandles(candles, key) {
  const out = [];
  let k0 = null;
  candles.forEach((c, i) => {
    const k = key(c[0]);
    const g = out.at(-1);
    if (g && k === k0) {
      g[2] = Math.max(g[2], c[2]); g[3] = Math.min(g[3], c[3]); g[4] = c[4]; g[5] += c[5]; g[6] = i;
    } else out.push([c[0], c[1], c[2], c[3], c[4], c[5], i]);
    k0 = k;
  });
  return out;
}

// Le plus petit paquet qui laisse au moins `minPx` pixels par bougie.
export function pickGroup(unit, count, width, minPx = 4) {
  const list = GROUPS[unit];
  return list.find(([k]) => count / k <= width / minPx) || list.at(-1);
}

// Variation sur `days` jours d'une série [jour, valeur] : dernier point comparé au point d'il y a `days` jours.
export function changeOver(points, days) {
  if (!points?.length) return null;
  const target = points.at(-1)[0] - days;
  for (let i = points.length - 1; i >= 0; i--) if (points[i][0] <= target) return points[i][1] ? points.at(-1)[1] / points[i][1] - 1 : null;
  return null;
}

// Prix de la crypto rapporté à celui de BTC, les jours où les deux existent.
export function ratioToBtc(d1, btcPoints) {
  const btc = new Map(btcPoints || []);
  return d1.filter(c => btc.get(c[0])).map(c => [c[0], c[4] / btc.get(c[0])]);
}

// Performance de la crypto et de BTC sur plusieurs durées.
export function perfVsBtc(d1, btcPoints, periods = [7, 30, 90, 365]) {
  const coin = d1.map(c => [c[0], c[4]]);
  return periods.map(days => ({ days, coin: changeOver(coin, days), btc: changeOver(btcPoints, days) }));
}

// Repères de prix : zone des 20 derniers jours (sans la bougie du jour), plus haut et plus bas sur un an,
// amplitude moyenne d'une journée (ATR 14 jours) en % du prix.
export function keyLevels(d1) {
  if (d1.length < 2) return null;
  const last = d1.at(-1)[4];
  const prev = d1.slice(-21, -1), year = d1.slice(-365);
  const atr = atrOf(d1, 14).at(-1);
  return {
    hi20: Math.max(...prev.map(c => c[2])), lo20: Math.min(...prev.map(c => c[3])),
    hi1y: Math.max(...year.map(c => c[2])), lo1y: Math.min(...year.map(c => c[3])),
    atrPct: atr != null && last ? atr / last : null,
  };
}

// Prix de liquidation approximatif d'une position en marge isolée (USDT), frais et funding non compris.
// mmr : marge de maintenance, autour de 0,5 % pour les grosses cryptos sur OKX.
export const LEVERS = [2, 3, 5, 10, 20, 50, 100];
export function liquidation(entry, lev, mmr = 0.005) {
  const move = Math.max(0, 1 / lev - mmr);
  return { move, long: entry * (1 - move), short: entry * (1 + move) };
}

// Funding : taux par période ramené à 8 h (OKX paie toutes les 8 h, parfois toutes les 4 h ou chaque heure).
export const per8h = (rate, everyHours) => rate * (8 / (everyHours || 8));
// Ce que le funding coûte (ou rapporte) sur un an, en % : trois périodes de 8 h par jour.
export const fundingYear = pct8h => pct8h * 3 * 365;

// Une news parle de cette crypto : son symbole dans les impacts, son nom ou son symbole (en majuscules) dans le titre.
// Les noms qui sont aussi des mots courants (Avalanche, Stellar, Optimism…) ne comptent pas seuls.
const COMMON_NAMES = /^(stellar|avalanche|mantle|optimism|cosmos( hub)?|flare|sky|sonic|story|render|near( protocol)?|sei|pi network|official trump|sun|polygon|gas)$/i;
const COMMON_SYMBOLS = new Set(['TRUMP', 'SKY', 'ONE', 'SUN', 'NEAR', 'GAS', 'POL', 'IP', 'PI', 'S', 'ME', 'AI']);
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function mentions(item, symbol, name) {
  if ((item.impacts || []).some(([a]) => a === symbol)) return true;
  const text = `${item.title || ''} ${item.titleEn || ''}`;
  if (symbol.length >= 3 && !COMMON_SYMBOLS.has(symbol) && new RegExp(`(^|[^A-Za-z0-9])\\$?${reEsc(symbol)}(?![A-Za-z0-9])`).test(text)) return true;
  return Boolean(name && name.length >= 4 && !COMMON_NAMES.test(name) && new RegExp(`(^|[^\\p{L}\\p{N}])${reEsc(name)}(?![\\p{L}\\p{N}])`, 'iu').test(text));
}

const num = (v, d = 0) => v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
// « de BTC » mais « d'ETH » : élision devant une voyelle.
export const deSym = s => (/^[AEIOUY]/i.test(s) ? `d'${s}` : `de ${s}`);
// Écart face à BTC à partir duquel une crypto fait mieux ou moins bien que lui (signal et encadré de la fiche).
export const BTC_EDGE = 0.05;
const abs = r => `${num(Math.abs(r) * 100, 1)} %`;
const pctFr = r => `${r >= 0 ? '+' : ''}${num(r * 100, 1)} %`;
// Prix lisible, même pour les cryptos à quelques millionièmes de dollar : 4 chiffres utiles sous 10 $ (1,489 pour XRP).
export function priceText(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const d = a >= 1000 ? 0 : a >= 10 ? 2 : a > 0 ? Math.min(10, 3 - Math.floor(Math.log10(a))) : 2;
  return num(n, d);
}

// Lecture de la tendance d'une crypto : chaque signal a un sens (1 haussier, -1 baissier, 0 neutre).
// d1 et h4 : bougies 1 jour et 4 h ; ratio : prix face à BTC ; funding et oi : séries [jour, valeur] d'OKX.
export function coinSignals({ symbol, d1 = [], h4 = [], ratio = [], funding = [], oi = [] }) {
  const out = [];
  const closes = d1.map(c => c[4]);
  const last = closes.at(-1);
  if (closes.length >= 200) {
    const m50 = smaOf(closes, 50).at(-1), m200 = smaOf(closes, 200).at(-1);
    const gap = last / m200 - 1;
    const dir = last > m200 && m50 > m200 ? 1 : last < m200 && m50 < m200 ? -1 : 0;
    out.push({ key: 'trend', label: 'Tendance de fond', dir,
      text: dir === 1 ? `${symbol} est ${abs(gap)} au-dessus de sa moyenne 200 jours et la moyenne 50 jours est au-dessus : tendance haussière.`
        : dir === -1 ? `${symbol} est ${abs(gap)} sous sa moyenne 200 jours et la moyenne 50 jours est en dessous : tendance baissière.`
          : `${symbol} est à ${pctFr(gap)} de sa moyenne 200 jours, mais les moyennes ne sont pas alignées : pas de tendance nette.` });
  }
  if (closes.length >= 21) {
    const g = last / smaOf(closes, 20).at(-1) - 1;
    out.push({ key: 'short', label: 'Court terme', dir: g > 0 ? 1 : -1,
      text: `${symbol} est ${abs(g)} ${g > 0 ? 'au-dessus' : 'en dessous'} de sa moyenne 20 jours.` });
    // Même repère que les setups : sortie de la zone des 20 derniers jours.
    const { hi20, lo20 } = keyLevels(d1);
    const dir = last > hi20 ? 1 : last < lo20 ? -1 : 0;
    const pos = (last - lo20) / (hi20 - lo20 || 1);
    out.push({ key: 'range', label: 'Zone du mois', dir,
      text: dir === 1 ? `Le prix est au-dessus du plus haut des 20 derniers jours (${priceText(hi20)} $) : cassure par le haut.`
        : dir === -1 ? `Le prix est sous le plus bas des 20 derniers jours (${priceText(lo20)} $) : cassure par le bas.`
          : `Le prix est ${pos > 2 / 3 ? 'près du haut' : pos < 1 / 3 ? 'près du bas' : 'au milieu'} de sa zone des 20 derniers jours (de ${priceText(lo20)} à ${priceText(hi20)} $).` });
  }
  const r = rsiOf(closes, 14).at(-1);
  if (r != null) {
    const v = Math.round(r);
    const dir = r >= 70 || r <= 30 ? 0 : r >= 55 ? 1 : r <= 45 ? -1 : 0;
    out.push({ key: 'rsi', label: 'Élan (RSI)', dir,
      text: r >= 70 ? `RSI 14 jours à ${v} : surachat. La hausse est forte mais tendue, un repli est fréquent.`
        : r <= 30 ? `RSI 14 jours à ${v} : survente. La baisse est forte mais tendue, un rebond est fréquent.`
          : `RSI 14 jours à ${v} : ${dir === 1 ? 'les acheteurs ont l\'élan' : dir === -1 ? 'les vendeurs ont l\'élan' : 'élan neutre'}.` });
  }
  if (h4.length >= 40) {
    const { hist } = macdOf(h4.map(c => c[4]));
    const h = hist.at(-1), hp = hist.at(-2);
    if (h != null) {
      out.push({ key: 'macd', label: 'MACD 4 h', dir: Math.sign(h),
        text: h >= 0 ? `Le MACD 4 h est au-dessus de son signal${hp != null && h > hp ? ' et monte' : ''} : les acheteurs ont la main sur les derniers jours.`
          : `Le MACD 4 h est sous son signal${hp != null && h < hp ? ' et baisse' : ''} : les vendeurs ont la main sur les derniers jours.` });
    }
  }
  const c30 = symbol === 'BTC' ? null : changeOver(ratio, 30);
  if (c30 != null) {
    const dir = c30 > BTC_EDGE ? 1 : c30 < -BTC_EDGE ? -1 : 0;
    out.push({ key: 'btc', label: 'Face à BTC', dir,
      text: `${symbol} ${pctFr(c30)} face à BTC sur 30 jours : ${dir === 1 ? 'il fait mieux que BTC' : dir === -1 ? 'il fait moins bien que BTC' : 'il suit BTC'}.` });
  }
  if (funding.length >= 3) {
    const avg = funding.slice(-3).reduce((s, p) => s + p[1], 0) / 3;
    const dir = avg > LIMITS.fundingHot ? -1 : avg < 0 ? 1 : 0;
    out.push({ key: 'funding', label: 'Levier', dir,
      text: `Funding moyen sur 3 jours : ${num(avg, 4)} % par 8 h. ${dir === -1 ? 'Trop de longs à levier : risque de purge.' : dir === 1 ? 'Les shorts paient les longs : de quoi alimenter une remontée.' : 'Levier calme.'}` });
  }
  const oi7 = changeOver(oi, 7), p7 = changeOver(d1.map(c => [c[0], c[4]]), 7);
  if (oi7 != null && p7 != null) {
    const dir = oi7 > LIMITS.oiMove ? (p7 > 0 ? 1 : -1) : 0;
    out.push({ key: 'oi', label: 'Positions ouvertes', dir,
      text: `Open interest ${pctFr(oi7)} sur 7 jours, prix ${pctFr(p7)}. ${dir === 1 ? 'De nouvelles positions suivent la hausse.' : dir === -1 ? 'Les positions s\'empilent pendant la baisse : les vendeurs appuient.' : oi7 < -LIMITS.oiMove ? 'Le levier se vide.' : 'Pas de grosse vague de nouvelles positions.'}` });
  }
  return { signals: out, verdict: verdict(out) };
}
