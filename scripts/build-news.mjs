#!/usr/bin/env node
// Récupère l'actu qui fait bouger les marchés, la classe (thème, importance, impact probable), la traduit en français
// et écrit news.json. Usage : node scripts/build-news.mjs [--out data] [--previous ancien-news.json] [--projects projects.json] [--sample]
// Lancé toutes les 15 minutes par GitHub Actions (.github/workflows/deploy.yml).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attempt, fetchJson, fetchText, mapLimit } from './lib/http.mjs';
import {
  LEVEL, NEWS, THEMES, buildFeed, classify, decode, hashId, headline, isCrypto, parseFeed, parseTelegram, parseWhale,
  splitSource, tidy, whaleNews,
} from './lib/news.mjs';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true]] : [])));
const OUT = args.out || 'data';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; Dinexo/1.0; +https://github.com/gabrielsebban3-code/bot-de-trading-btc-alt)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Google News : une recherche par thème sur les dernières 24 h (Reuters, AP, Bloomberg, CNBC…).
const google = q => `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:1d`)}&hl=en-US&gl=US&ceid=US:en`;

// rank : 3 = source officielle, 2 = agence ou grand média, 1 = autre (sert à choisir le titre d'une news regroupée).
// crypto : média crypto (« protocole vidé de 20 M$ » est un hack crypto même sans le mot crypto).
// prefix / theme / why : émetteur et thème par défaut des communiqués officiels. keep : ne garde que les titres utiles.
const SOURCES = [
  { id: 'fed', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', rank: 3, prefix: 'Fed', label: /\b(fed|federal|fomc|powell)\b/i, theme: 'cb', why: 'Communiqué officiel de la Fed sur sa politique monétaire.' },
  { id: 'ecb', name: 'BCE', url: 'https://www.ecb.europa.eu/rss/press.html', rank: 3, prefix: 'ECB', label: /\b(ecb|european central bank|lagarde)\b/i, theme: 'cb', keep: /monetary policy|interest rates?|key ecb|inflation|press conference/i, why: 'Communiqué officiel de la BCE sur sa politique monétaire.' },
  { id: 'sec', name: 'SEC', url: 'https://www.sec.gov/news/pressreleases.rss', rank: 3, prefix: 'SEC', label: /\b(sec|commission)\b/i, theme: 'reg', cryptoOnly: true, why: 'Communiqué officiel du gendarme américain de la bourse.' },
  { id: 'gn-geo', name: 'Google News · géopolitique', google: true, url: google('(Iran OR Israel OR Russia OR Ukraine OR Taiwan OR China OR Houthis OR Hormuz) (missile OR strike OR attack OR war OR troops OR ceasefire OR sanctions)') },
  { id: 'gn-cb', name: 'Google News · banques centrales', google: true, url: google('("Federal Reserve" OR FOMC OR Powell OR ECB OR "Bank of Japan" OR "Bank of England") (rates OR "rate cut" OR "rate hike" OR decision)') },
  { id: 'gn-data', name: 'Google News · inflation et emploi', google: true, url: google('(CPI OR "consumer prices" OR inflation OR payrolls OR "jobs report" OR "jobless claims" OR PCE) "U.S."') },
  { id: 'gn-energy', name: 'Google News · pétrole et or', google: true, url: google('(OPEC OR "oil prices" OR "crude oil" OR "Brent crude" OR WTI OR "gold prices" OR "natural gas prices")') },
  { id: 'gn-trade', name: 'Google News · commerce', google: true, url: google('(tariffs OR "trade war" OR "trade deal" OR "export controls")') },
  { id: 'gn-crypto', name: 'Google News · crypto', google: true, crypto: true, url: google('(crypto OR bitcoin OR ethereum OR stablecoin) (hack OR exploit OR stolen OR ETF OR SEC OR regulation OR lawsuit OR bill)') },
  { id: 'bbc', name: 'BBC', rank: 2, url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { id: 'aljazeera', name: 'Al Jazeera', rank: 2, url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { id: 'cnbc', name: 'CNBC', rank: 2, url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { id: 'cnbc-world', name: 'CNBC', rank: 2, url: 'https://www.cnbc.com/id/100727362/device/rss/rss.html' },
  { id: 'fxstreet', name: 'FXStreet', url: 'https://www.fxstreet.com/rss/news' },
  { id: 'oilprice', name: 'OilPrice.com', url: 'https://oilprice.com/rss/main' },
  { id: 'coindesk', name: 'CoinDesk', crypto: true, url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { id: 'cointelegraph', name: 'Cointelegraph', crypto: true, url: 'https://cointelegraph.com/rss' },
  { id: 'theblock', name: 'The Block', crypto: true, url: 'https://www.theblock.co/rss.xml' },
  { id: 'decrypt', name: 'Decrypt', crypto: true, url: 'https://decrypt.co/feed' },
  { id: 'dlnews', name: 'DL News', crypto: true, url: 'https://www.dlnews.com/arc/outboundfeeds/rss/' },
  { id: 'blockworks', name: 'Blockworks', crypto: true, url: 'https://blockworks.co/feed' },
  // Canaux Telegram publics (page web t.me/s/…) : news rapides, sans passer par X.
  { id: 'watcherguru', name: 'Watcher.Guru', telegram: 'WatcherGuru' },
  { id: 'wublockchain', name: 'Wu Blockchain', crypto: true, telegram: 'wublockchainenglish' },
  { id: 'whalealert', name: 'Whale Alert', whale: true, telegram: 'whale_alert_io', pages: 2 },
];

// Médias repris par Google News : agences et grands titres d'abord.
const OFFICIAL = /^(federal reserve|federalreserve\.gov|european central bank|sec\.gov|u\.s\. securities and exchange commission|opec|eia|u\.s\. energy information administration|bureau of labor statistics|the white house|white house)\b/i;
const AGENCY = /^(reuters|associated press|the associated press|ap news|bloomberg|afp|agence france-presse|financial times|the wall street journal|wsj|cnbc|bbc|the new york times|the guardian|al jazeera|nikkei|axios|politico)\b/i;
const rankOf = (src, source) => src.rank ?? (OFFICIAL.test(source) ? 3 : AGENCY.test(source) ? 2 : 1);

// Telegram n'affiche que les ~20 derniers messages par page : `pages` remonte plus loin.
async function telegram(channel, pages = 1) {
  const out = [];
  let url = `https://t.me/s/${channel}`;
  for (let p = 0; p < pages; p++) {
    const posts = parseTelegram(await fetchText(url, { headers: UA, retries: 1, timeout: 20_000 }), channel);
    if (!posts.length) break;
    out.push(...posts);
    const oldest = Math.min(...posts.map(x => Number(x.link.split('/').pop())).filter(Number.isFinite));
    if (!Number.isFinite(oldest)) break;
    url = `https://t.me/s/${channel}?before=${oldest}`;
  }
  return out;
}

function entry(src, rawTitle, link, time, source, ctx) {
  let title = tidy(rawTitle);
  if (title.length < 15 || (src.keep && !src.keep.test(title)) || (src.cryptoOnly && !isCrypto(title))) return null;
  // « Monetary policy decisions » seul ne dit pas qui décide : on ajoute l'émetteur officiel.
  if (src.label && !src.label.test(title)) title = `${src.prefix}: ${title}`;
  const hit = classify(title, { crypto: src.crypto, prefix: src.prefix, theme: src.theme, why: src.why, projects: ctx.top });
  if (!hit) {
    ctx.dropped.push(`${src.id} · ${title}`);
    return null;
  }
  return { id: hashId(link || title), time, titleEn: title, title: null, lang: 'en', link, source, rank: rankOf(src, source), kind: 'feed', ...hit };
}

async function collect(src, ctx) {
  const at = t => Math.min(t ?? ctx.now, ctx.now); // date absente ou dans le futur : on prend l'heure de lecture
  if (src.telegram) {
    const posts = await telegram(src.telegram, src.pages);
    const items = posts.map(p => {
      const tx = src.whale && parseWhale(p.text);
      if (!tx) return entry(src.whale ? { ...src, crypto: true } : src, headline(p.text), p.link, at(p.time), src.name, ctx);
      const w = whaleNews(tx, ctx.top);
      return w && { ...w, id: hashId(p.link), time: at(p.time), titleEn: headline(p.text), lang: 'fr', link: p.link, source: src.name, rank: 1, kind: 'whale' };
    });
    // Quelques messages bruts : pour comprendre une source qui ne donne plus rien.
    const samples = posts.slice(-3).map(p => p.text.replace(/\s+/g, ' ').slice(0, 180));
    return { raw: posts.length, first: posts[0] && headline(posts[0].text), samples, items: items.filter(Boolean) };
  }
  const feed = parseFeed(await fetchText(src.url, { headers: UA, retries: 1, timeout: 20_000 }));
  const items = feed.map(it => {
    const { title, source } = src.google ? splitSource(it.title, it.source) : { title: it.title, source: src.name };
    return entry(src, title, it.link, at(it.time), source || src.name, ctx);
  });
  return { raw: feed.length, first: feed[0]?.title, samples: feed.slice(0, 3).map(i => i.title), items: items.filter(Boolean) };
}

// ---------- Traduction gratuite : Google Translate (accès public), sinon MyMemory ----------

function spacer(gap) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + gap;
    if (wait) await sleep(wait);
  };
}

const ENGINES = [
  {
    name: 'Google', fails: 0, pace: spacer(150),
    run: async t => {
      const r = await fetchJson(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fr&dt=t&q=${encodeURIComponent(t)}`, { headers: UA, retries: 1, timeout: 15_000 });
      return (r?.[0] || []).map(s => s?.[0] ?? '').join('');
    },
  },
  {
    name: 'MyMemory', fails: 0, pace: spacer(400),
    run: async t => {
      const r = await fetchJson(`https://api.mymemory.translated.net/get?langpair=en|fr&q=${encodeURIComponent(t)}`, { headers: UA, retries: 1, timeout: 15_000 });
      const out = decode(r?.responseData?.translatedText ?? '');
      if (Number(r?.responseStatus) !== 200 || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) throw new Error(r?.responseDetails || 'quota atteint');
      return out;
    },
  },
];

// Petites retouches de l'anglais avant traduction (le titre anglais d'origine reste la clé du cache).
const forTranslation = t => t
  .replace(/\bcrypto(?![.\w-])/gi, m => (m[0] === 'C' ? 'Cryptocurrency' : 'cryptocurrency'))
  .replace(/\bahead of\b/gi, m => (m[0] === 'A' ? 'Before' : 'before'));

async function translate(english) {
  const text = forTranslation(english);
  for (const e of ENGINES) {
    if (e.fails >= 3) continue; // trois échecs de suite : moteur abandonné pour cette mise à jour
    try {
      await e.pace();
      const out = tidy(await e.run(text));
      if (!out) throw new Error('traduction vide');
      e.fails = 0;
      return out[0].toUpperCase() + out.slice(1);
    } catch (err) {
      if (++e.fails === 3) console.warn(`⚠ Traduction ${e.name} abandonnée : ${err.message}`);
    }
  }
  return null;
}

async function main() {
  const now = Date.now();
  console.log(`Dinexo · actu · ${new Date(now).toISOString()}`);
  const read = path => (path ? readFile(path, 'utf8').then(JSON.parse).catch(() => null) : null);
  const [previous, projects] = await Promise.all([read(args.previous), read(args.projects)]);
  const top = (projects?.projects || []).filter(p => p.inTop ?? p.rank <= 25).map(({ id, name, symbol, rank }) => ({ id, name, symbol, rank }));
  const ctx = { now, top, dropped: [] };

  const sources = {};
  const fresh = (await mapLimit(SOURCES, 6, async src => {
    const r = await attempt(src.name, () => collect(src, ctx));
    sources[src.id] = r.ok ? { name: src.name, status: 'ok', read: r.value.raw, kept: r.value.items.length } : { name: src.name, status: 'erreur' };
    console.log(`${r.ok ? '✓' : '✖'} ${src.id.padEnd(13)} ${r.ok ? `${String(r.value.raw).padStart(3)} lues · ${String(r.value.items.length).padStart(3)} gardées · ${String(r.value.first ?? '—').slice(0, 90)}` : r.error}`);
    if (r.ok && (src.whale || (r.value.raw && !r.value.items.length))) for (const t of r.value.samples) console.log(`    · ${t}`);
    return r.ok ? r.value.items : [];
  })).flat();

  const down = SOURCES.filter(s => sources[s.id].status !== 'ok');
  if (down.length === SOURCES.length) throw new Error('Aucune source d\'actu n\'a répondu. La version déjà en ligne est conservée.');
  const warnings = [];
  if (down.length >= SOURCES.length / 3) warnings.push(`${down.length} sources sur ${SOURCES.length} n'ont pas répondu à cette mise à jour : le fil peut être incomplet.`);

  const items = buildFeed(previous?.items, fresh, now);

  // Traduction : les titres déjà traduits sont repris, les autres sont traduits (les plus importants d'abord).
  const known = new Map((previous?.items || []).filter(i => i.lang === 'fr' && i.title && i.titleEn).map(i => [i.titleEn, i.title]));
  const todo = [];
  for (const i of items) {
    if (i.title) continue;
    if (known.has(i.titleEn)) Object.assign(i, { title: known.get(i.titleEn), lang: 'fr' });
    else todo.push(i);
  }
  todo.sort((a, b) => LEVEL[b.importance] - LEVEL[a.importance] || b.time - a.time);
  const batch = todo.slice(0, NEWS.maxTranslations);
  const done = await mapLimit(batch, 3, i => translate(i.titleEn));
  batch.forEach((i, k) => { if (done[k]) Object.assign(i, { title: done[k], lang: 'fr' }); });

  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'news.json'), JSON.stringify({
    generatedAt: new Date(now).toISOString(), sample: Boolean(args.sample), sources, warnings, themes: THEMES,
    rules: { keepHours: NEWS.keepHours, bannerHours: NEWS.bannerHours, whaleMinUsd: NEWS.whaleMinUsd, whaleMediumUsd: NEWS.whaleMediumUsd, hackCriticalUsd: NEWS.hackCriticalUsd },
    items,
  }));

  const count = (k, v) => items.filter(i => i[k] === v).length;
  console.log(`\n${items.length} news dans le fil (${NEWS.keepHours} h) · ${fresh.length} lues et classées à cette mise à jour · ${batch.length} traductions demandées, ${done.filter(Boolean).length} réussies, ${items.filter(i => !i.title).length} en attente`);
  console.log(`Importance : ${count('importance', 'critical')} critiques · ${count('importance', 'medium')} moyennes · ${count('importance', 'low')} faibles`);
  console.log(`Thèmes : ${Object.entries(THEMES).map(([k, v]) => `${v} ${count('theme', k)}`).join(' · ')}`);
  const arrows = i => i.impacts.map(([a, d]) => `${a} ${d > 0 ? '▲' : '▼'}`).join(' ');
  const show = i => console.log(`[${i.importance === 'critical' ? 'C' : 'M'}] ${i.rule.padEnd(16)} ${i.titleEn.slice(0, 120)} · ${i.source}${i.count > 1 ? ` +${i.count - 1}` : ''} ${arrows(i)}${i.calm ? ' (guerre en cours)' : ''}`);
  console.log('\nCritiques :');
  items.filter(x => x.importance === 'critical').slice(0, 20).forEach(show);
  // Avant regroupement et confirmation : d'où vient chaque critique.
  const rawCritical = fresh.filter(i => i.importance === 'critical');
  if (rawCritical.length) console.log(`Titres classés critiques à cette lecture :\n${rawCritical.slice(0, 15).map(i => `  · ${i.rule} · ${i.titleEn.slice(0, 120)} · ${i.source}`).join('\n')}`);
  console.log('\nMoyennes (les plus récentes) :');
  items.filter(x => x.importance === 'medium').slice(0, process.env.PUBLISH === 'true' ? 40 : 200).forEach(show);
  if (process.env.PUBLISH !== 'true') { console.log('\nFaibles :'); items.filter(x => x.importance === 'low' && x.kind !== 'whale').forEach(i => console.log(`[F] ${i.rule.padEnd(16)} ${i.titleEn.slice(0, 120)} · ${i.source}`)); }
  const missed = ctx.dropped.filter(d => d.startsWith('gn-'));
  if (missed.length) console.log(`\nExemples de titres Google News écartés (aucune règle) :\n${missed.slice(0, 20).join('\n')}`);
  if (warnings.length) console.log('Avertissements :', warnings);
}

main().catch(err => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
