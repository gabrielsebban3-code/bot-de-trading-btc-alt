// Fiches crypto : mise en forme des réponses d'OKX et de CoinGecko (fonctions pures, testées dans tests/crypto.test.mjs).
import { toDaily } from '../../js/marche-lib.js';
import { per8h } from '../../js/crypto-lib.js';
import { decode } from './news.mjs';

const HOUR = 3_600_000;
export const sig = (n, d = 6) => (Number.isFinite(n) ? Number(n.toPrecision(d)) : null);

// Bougies OKX (les plus récentes d'abord) → [temps, o, h, l, c, volume en dollars] de la plus ancienne à la plus récente.
// `unit` : durée d'une unité de temps en ms (un jour, une heure). Le volume en dollars est la colonne volCcyQuote.
export function candlesFromOkx(rows, unit) {
  const byTime = new Map();
  for (const r of rows) {
    const c = [Math.floor(Number(r[0]) / unit), ...[1, 2, 3, 4].map(k => sig(Number(r[k]))), sig(Number(r[7] ?? r[6]), 4) ?? 0];
    if (c.slice(1, 5).every(v => v > 0)) byTime.set(c[0], c);
  }
  return [...byTime.values()].sort((a, b) => a[0] - b[0]);
}

// Historique du funding OKX (les plus récents d'abord) → moyenne par jour en % par 8 h.
// Chaque taux est ramené à 8 h d'après l'écart avec le paiement précédent : OKX passe parfois à 4 h ou 1 h.
export function fundingHistory(rows, everyHours = 8) {
  const pts = rows.map((r, i) => {
    const gap = rows[i + 1] ? (Number(r.fundingTime) - Number(rows[i + 1].fundingTime)) / HOUR : everyHours;
    return [Number(r.fundingTime), per8h(Number(r.realizedRate || r.fundingRate) * 100, Math.min(8, Math.max(1, gap || 8)))];
  });
  return toDaily(pts, { mean: true }).map(([d, v]) => [d, sig(v, 4)]);
}

// Phrases d'un texte (un point, un point d'exclamation ou d'interrogation suivi d'une majuscule ou d'un chiffre).
export const sentences = text => String(text || '').split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý0-9])/).filter(Boolean);

// Début de la présentation CoinGecko : texte brut, trois phrases au plus (on s'arrête après 280 caractères).
// Le titre en tête des textes français (« Qu'est-ce que le Bitcoin ? (BTC) ») est retiré.
export function excerpt(html, max = 480) {
  const text = decode(String(html || '').replace(/<\/?(p|br|div|li|ul|ol|h\d)\b[^>]*>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ').trim()
    .replace(/^(?:qu['’]est-ce (?:que |qu['’])|what (?:is|are) )[^?]{1,80}\?\s*(?:\([^)]{1,15}\)\s*)?(?=\S)/i, '');
  if (!text) return null;
  let out = '';
  for (const [i, s] of sentences(text).entries()) {
    if (out && (i >= 3 || out.length > 280 || out.length + s.length > max)) break;
    out += (out ? ' ' : '') + s;
  }
  return out.length > max ? `${out.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : out;
}

// Lien du projet sans les paramètres de parrainage ou de suivi (CoinGecko en garde parfois, « ?ref=… »).
export function cleanLink(url) {
  if (!/^https?:\/\//i.test(url || '')) return null;
  try {
    const u = new URL(url);
    const drop = [...u.searchParams.keys()].filter(k => /^(ref|referral|referrer|utm_\w+)$/i.test(k));
    for (const k of drop) u.searchParams.delete(k);
    return drop.length ? u.href : url;
  } catch { return null; }
}

// Open interest en direct d'OKX, en dollars, par crypto : perpétuels et contrats à terme réunis, comme les séries
// quotidiennes d'OKX (rubik), qui ont 2 à 3 jours de retard. `okx(path)` renvoie le champ data de la réponse.
export async function liveOpenInterest(okx) {
  const out = new Map();
  for (const type of ['SWAP', 'FUTURES']) {
    for (const r of await okx(`/public/open-interest?instType=${type}`)) {
      const usd = Number(r.oiUsd);
      if (!r.oiUsd || !(usd > 0)) continue;
      const sym = String(r.instId).split('-')[0];
      out.set(sym, (out.get(sym) || 0) + usd);
    }
  }
  return out;
}

// Jour en cours d'une série quotidienne en retard : la valeur en direct, sauf si elle s'écarte de plus de 25 % de la
// dernière valeur connue (un tel saut viendrait d'un autre périmètre de contrats, pas du marché).
export function withLive(points, live, today) {
  const before = points.filter(([d]) => d < today);
  const ref = before.at(-1)?.[1];
  if (!(live > 0) || (ref && Math.abs(live / ref - 1) > 0.25)) return null;
  return [...before, [today, live]];
}
