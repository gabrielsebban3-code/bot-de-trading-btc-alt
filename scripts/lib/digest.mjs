import { similar, words } from './news.mjs';

// Résumé du matin sur Discord : setups en cours, news du jour et point géopolitique, en un seul message.
// Sans IA : tout est tiré des fichiers de données déjà publiés (setups.json, news.json), par règles.

export const DIGEST = {
  hour: 7, // heure de Paris à partir de laquelle le résumé part (au premier passage qui suit)
  zone: 'Europe/Paris',
  windowMs: 24 * 3600e3, // news des dernières 24 h
  news: 3, // news du jour (hors géopolitique)
  geo: 4, // titres géopolitiques
};
const ACCENT = 0xff8a00;
const GEO = 0xf97316;
const NFA = 'Pas un conseil financier.';
const LEVEL = { critical: 3, medium: 2, low: 1 };

// Date (AAAA-MM-JJ) et heure à Paris : le résumé part une fois par jour, après 7 h.
export function parisClock(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: DIGEST.zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function digestDue(state, now = Date.now()) {
  const { day, hour } = parisClock(now);
  return hour >= DIGEST.hour && state?.digest !== day;
}

// Zones suivies, reconnues sur le titre anglais. L'ordre départage les égalités.
const ZONES = [
  ['Moyen-Orient', /\b(iran\w*|tehran|israel\w*|gaza|hamas|lebanon|hezbollah|houthis?|yemen\w*|red sea|hormuz|saudi\w*|riyadh|gulf|syria\w*|iraq\w*|qatar\w*)\b/i],
  ['Russie et Ukraine', /\b(russia\w*|moscow|kremlin|putin|ukrain\w*|kyiv|zelensk\w*|crimea)\b/i],
  ['Chine et Taïwan', /\b(taiwan\w*|south china sea|beijing|xi jinping|pla)\b/i],
  ['Commerce mondial', /\b(tariffs?|trade (war|deal|talks)|sanctions?|embargo|export controls?)\b/i],
  ['OTAN et Europe', /\b(nato|baltic|poland|polish)\b/i],
];
export const zoneOf = item => ZONES.find(([, re]) => re.test(item.titleEn || item.title || ''))?.[0] ?? 'Autres';

export const num = v => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('fr-FR', { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : 4 }).replace(/\u00a0|\u202f/g, ' '));
const hhmm = t => new Intl.DateTimeFormat('fr-FR', { timeZone: DIGEST.zone, hour: '2-digit', minute: '2-digit' }).format(new Date(t));
export const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const arrow = d => (d > 0 ? '▲' : d < 0 ? '▼' : '');
// Lien Markdown de Discord ; les crochets du titre casseraient le lien.
export const line = i => {
  const title = clip(String(i.title || i.titleEn || '').replace(/[[\]]/g, ''), 150);
  const move = i.reaction?.strong ? ` · ${i.reaction.asset} ${i.reaction.pct > 0 ? '+' : ''}${String(i.reaction.pct).replace('.', ',')} % en 1 h` : '';
  return `• ${hhmm(i.time)} · ${i.link ? `[${title}](${i.link})` : title}${move}`;
};
// Même événement raconté par deux médias (« tanker attacked off Oman » / « tanker hit off Oman ») : un seul titre.
function sameStory(a, b) {
  if (!a.titleEn || !b.titleEn) return false;
  if (similar(a, b)) return true;
  const A = words(a.titleEn), B = words(b.titleEn);
  const shared = [...A].filter(w => B.has(w)).length;
  return shared >= 2 && shared / Math.min(A.size, B.size) >= 0.3 && Math.abs(a.time - b.time) < 12 * 3600e3;
}
export const distinct = (items, n) => items.reduce((kept, i) => (kept.length < n && !kept.some(k => sameStory(k, i)) ? [...kept, i] : kept), []);
export const byWeight = (a, b) => LEVEL[b.importance] - LEVEL[a.importance] || (b.count || 1) - (a.count || 1) || b.time - a.time;

// Les news qui comptent des dernières 24 h, sans les baleines (des transferts, pas des nouvelles) ni les non vérifiées.
function recent(news, now) {
  return (news?.items || []).filter(i => i.kind !== 'whale' && !i.unverified && now - i.time <= DIGEST.windowMs && i.time <= now);
}

// Effet probable cumulé des news géopolitiques sur le pétrole, l'or et le BTC : ▲ si la majorité pousse à la hausse.
function netEffect(items) {
  const score = {};
  for (const i of items) for (const [asset, d] of i.impacts || []) score[asset] = (score[asset] || 0) + Math.sign(d);
  return ['Pétrole', 'Or', 'BTC'].filter(a => score[a]).map(a => `${a} ${arrow(score[a])}`).join(' · ');
}

export function geoSummary(news, now = Date.now()) {
  const all = recent(news, now).filter(i => i.theme === 'geo');
  const strong = all.filter(i => i.importance !== 'low');
  if (!all.length) return { zones: [], text: 'Aucune news géopolitique marquante ces dernières 24 h.' };
  const counts = new Map();
  for (const i of all) {
    const z = zoneOf(i);
    const c = counts.get(z) || { zone: z, n: 0, up: 0, down: 0, critical: 0 };
    c.n++;
    if (i.importance === 'critical') c.critical++;
    // Pétrole en hausse ou BTC en baisse : tension ; l'inverse : détente (cessez-le-feu, accord commercial).
    const d = asset => (i.impacts || []).find(([a]) => a === asset)?.[1] ?? 0;
    const tension = d('Pétrole') > 0 || d('BTC') < 0, relief = d('Pétrole') < 0 || d('BTC') > 0;
    if (i.importance !== 'low' && tension && !relief) c.up++;
    if (i.importance !== 'low' && relief && !tension) c.down++;
    counts.set(z, c);
  }
  const zones = [...counts.values()].filter(c => c.zone !== 'Autres' || counts.size === 1)
    .sort((a, b) => b.critical - a.critical || b.up + b.down - (a.up + a.down) || b.n - a.n).slice(0, 3);
  const mood = c => (c.critical ? 'escalade majeure' : c.up > c.down ? 'tensions en hausse' : c.down > c.up ? 'signes de détente' : c.up ? 'situation partagée' : 'calme relatif');
  const text = [
    zones.map(c => `**${c.zone}** : ${mood(c)} (${c.n} news)`).join('\n'),
    netEffect(strong) && `Effet probable : ${netEffect(strong)}`,
    '',
    ...distinct((strong.length ? strong : all).sort(byWeight), DIGEST.geo).sort((a, b) => b.time - a.time).map(line),
  ].filter(s => s != null && s !== false).join('\n').trim();
  return { zones, text };
}

// Le message complet : trois blocs (« embeds ») dans un seul envoi.
export function buildDigest({ setups, news, siteUrl = '', now = Date.now() }) {
  const site = siteUrl ? siteUrl.replace(/\/?$/, '/') : undefined;
  const open = (setups?.live || []).filter(s => s.status === 'confirmé' && s.outcome === 'open').sort((a, b) => b.time - a.time);
  const setupText = open.length
    ? open.slice(0, 8).map(s => `• **${s.symbol}** ${s.dir === 'long' ? 'Long' : 'Short'} · entrée ${num(s.entry)} · stop ${num(s.sl)}`).join('\n')
    : 'Aucun setup en cours : pas de trade à suivre aujourd\'hui.';
  const top = recent(news, now).filter(i => i.theme !== 'geo' && i.importance !== 'low').sort(byWeight);
  const topNews = distinct(top, DIGEST.news);
  const newsText = topNews.length ? topNews.map(i => `${line(i)}${(i.impacts || []).length ? ` · ${i.impacts.map(([a, d]) => `${a} ${arrow(d)}`).join(' ')}` : ''}`).join('\n')
    : 'Rien de marquant ces dernières 24 h.';
  const { day } = parisClock(now);
  const date = new Intl.DateTimeFormat('fr-FR', { timeZone: DIGEST.zone, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now));
  return {
    day,
    embeds: [
      { title: `Résumé du ${date}`, url: site, color: ACCENT, fields: [
        { name: `Setups en cours (${open.length})`, value: clip(setupText, 1024) },
        { name: 'News du jour', value: clip(newsText, 1024) },
      ] },
      { title: 'Situation géopolitique', url: site ? `${site}#actu` : undefined, color: GEO, description: clip(geoSummary(news, now).text, 4000), footer: { text: NFA } },
    ],
  };
}
