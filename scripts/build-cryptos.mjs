#!/usr/bin/env node
// Fiches crypto (#crypto/<id>) : une fiche par crypto du tableau « Les plus grosses cryptos » de l'onglet Marché.
// Bougies OKX (1 jour sur près de 3 ans, 4 h sur 50 jours), levier sur OKX (perpétuel, funding, open interest,
// part des comptes à l'achat), chiffres clés et présentation du projet (CoinGecko). Sources gratuites sans clé.
// La présentation (texte, liens) change peu : celle de la fiche déjà en ligne est gardée 3 jours.
// Usage : node scripts/build-cryptos.mjs [--out data] [--marche data/marche.json[,autre.json]] [--previous dossier]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { attempt, fetchJson } from './lib/http.mjs';
import { candlesFromOkx, cleanLink, excerpt, fundingHistory, liveOpenInterest, sentences, sig, withLive } from './lib/cryptos.mjs';
import { decode } from './lib/news.mjs';
import { DAY, mergePoints, realCoins, toDaily } from '../js/marche-lib.js';
import { coinSignals, per8h } from '../js/crypto-lib.js';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true]] : [])));
const OUT = join(args.out || 'data', 'crypto');
const OKX = 'https://www.okx.com/api/v5';
const CG = 'https://api.coingecko.com/api/v3';
const cgHeaders = process.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } : {};
const HOUR = 3_600_000;
const TOP = 12;
const ABOUT_DAYS = 3;
const ABOUT_PER_RUN = 4; // présentations périmées rafraîchies à chaque passage, au plus
// Au-delà de ce temps, les fiches restantes reprennent la version déjà en ligne (l'étape a 9 minutes en tout).
const BUDGET = Number(args.budget || 6) * 60_000;
const started = Date.now();
const late = () => Date.now() - started > BUDGET;
// Avec les réponses fictives des tests (DINEXO_FAST=1), pas d'attente entre les demandes.
const sleep = ms => new Promise(r => setTimeout(r, process.env.DINEXO_FAST === '1' ? 0 : ms));
const ratio = v => (v == null ? null : v / 100);

async function okx(path) {
  const r = await fetchJson(`${OKX}${path}`, { retries: 2 });
  if (r.code !== '0') throw new Error(`OKX ${r.code} ${r.msg || ''}`);
  await sleep(120);
  return r.data;
}

// CoinGecko gratuit : une demande toutes les 2,5 s avec une clé démo, toutes les 6 s sans.
let cgNext = 0;
async function gecko(path, retries = 3) {
  const wait = cgNext - Date.now();
  cgNext = Math.max(Date.now(), cgNext) + (cgHeaders['x-cg-demo-api-key'] ? 2500 : 6000);
  if (wait > 0) await sleep(wait);
  return fetchJson(`${CG}${path}`, { headers: cgHeaders, retries });
}

// Les cryptos du tableau de l'onglet Marché ; sans fichier Marché utilisable, la même sélection chez CoinGecko.
async function coinList() {
  for (const path of String(args.marche || '').split(',').filter(Boolean)) {
    const m = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
    const top = (m?.top || []).filter(c => c.id);
    if (top.length) {
      console.log(`Liste : ${path} (${top.length} cryptos)`);
      return top.slice(0, TOP).map(c => ({ id: c.id, symbol: c.symbol.toUpperCase(), name: c.name }));
    }
  }
  const coins = await gecko('/coins/markets?vs_currency=usd&per_page=30', 4);
  console.log('Liste : classement CoinGecko');
  return realCoins(coins).slice(0, TOP).map(c => ({ id: c.id, symbol: String(c.symbol).toUpperCase(), name: c.name }));
}

// Chiffres clés de CoinGecko pour toutes les cryptos de la liste, en une demande.
async function markets(ids) {
  const rows = await gecko(`/coins/markets?vs_currency=usd&ids=${ids.join(',')}&price_change_percentage=24h,7d,30d,1y`, 4);
  return new Map(rows.map(c => [c.id, {
    rank: c.market_cap_rank ?? null, price: c.current_price ?? null, mcap: c.market_cap ?? null, fdv: c.fully_diluted_valuation ?? null,
    volume: c.total_volume ?? null, high24h: c.high_24h ?? null, low24h: c.low_24h ?? null,
    change24h: ratio(c.price_change_percentage_24h_in_currency), change7d: ratio(c.price_change_percentage_7d_in_currency),
    change30d: ratio(c.price_change_percentage_30d_in_currency), change1y: ratio(c.price_change_percentage_1y_in_currency),
    ath: c.ath ?? null, athDate: c.ath_date ?? null, athChange: ratio(c.ath_change_percentage), atl: c.atl ?? null, atlDate: c.atl_date ?? null,
    circulating: c.circulating_supply ?? null, total: c.total_supply ?? null, max: c.max_supply ?? null, image: c.image ?? null,
  }]));
}

// Marchés ouverts sur OKX : paires au comptant contre USDT, perpétuels USDT et leur levier maximum.
async function instruments() {
  const spot = await okx('/public/instruments?instType=SPOT');
  const swap = await okx('/public/instruments?instType=SWAP');
  return {
    spot: new Set(spot.filter(i => i.state === 'live' && i.quoteCcy === 'USDT').map(i => i.baseCcy)),
    swap: new Map(swap.filter(i => i.state === 'live' && i.instId.endsWith('-USDT-SWAP')).map(i => [i.instId.split('-')[0], Number(i.lever) || null])),
  };
}

// Bougies OKX de la plus ancienne à la plus récente, avec `pages` pages de 100 bougies plus anciennes.
async function okxCandles(instId, bar, pages, unit) {
  const rows = await okx(`/market/candles?instId=${instId}&bar=${bar}&limit=300`);
  for (let i = 0; i < pages && rows.length; i++) {
    const older = await okx(`/market/history-candles?instId=${instId}&bar=${bar}&limit=100&after=${rows.at(-1)[0]}`);
    if (!older.length) break;
    rows.push(...older);
  }
  return candlesFromOkx(rows, unit);
}

// Crypto absente d'OKX : clôtures quotidiennes et volumes de CoinGecko (courbe au lieu de bougies).
// CoinGecko gratuit ne donne qu'un an d'historique (au-delà, il refuse la demande).
async function geckoLine(id) {
  const r = await gecko(`/coins/${id}/market_chart?vs_currency=usd&days=365`);
  const vol = new Map(toDaily(r.total_volumes));
  return toDaily(r.prices).map(([d, p]) => [d, sig(p), sig(p), sig(p), sig(p), sig(vol.get(d) ?? 0, 4)]);
}

// Levier sur OKX : funding (en cours et moyenne par jour, ramené à 8 h), open interest et part des comptes à l'achat.
async function derivatives(sym, swapId, liveOi, prevOi = []) {
  const out = { funding: null, oi: [], longShort: [] };
  const sources = {};
  const f = await attempt(`${sym} funding`, async () => {
    const [cur] = await okx(`/public/funding-rate?instId=${swapId}`);
    const rows = await okx(`/public/funding-rate-history?instId=${swapId}&limit=100`);
    for (let i = 0; i < 2 && rows.length; i++) {
      const before = Number(rows.at(-1).fundingTime);
      const older = (await okx(`/public/funding-rate-history?instId=${swapId}&limit=100&after=${before}`)).filter(r => Number(r.fundingTime) < before);
      if (!older.length) break;
      rows.push(...older);
    }
    const every = (Number(cur.nextFundingTime) - Number(cur.fundingTime)) / HOUR;
    return {
      rate: sig(per8h(Number(cur.fundingRate) * 100, every > 0 ? every : 8), 4),
      every: every > 0 ? every : 8,
      next: Number(cur.fundingTime) || null,
      history: fundingHistory(rows, every > 0 ? every : 8),
    };
  });
  sources.funding = f.ok ? 'ok' : 'erreur';
  if (f.ok) out.funding = f.value;
  const oi = await attempt(`${sym} open interest`, async () => {
    // Les valeurs à 0 (journée en cours) sont ignorées. Les valeurs quotidiennes d'OKX ont jusqu'à 3 jours de retard :
    // les jours suivants prennent la dernière valeur horaire de chaque jour.
    const pts = rows => toDaily(rows.map(r => [Number(r[0]), Number(r[1])]).filter(([, v]) => v > 0));
    const daily = pts(await okx(`/rubik/stat/contracts/open-interest-volume?ccy=${sym}&period=1D`));
    const hourly = pts(await okx(`/rubik/stat/contracts/open-interest-volume?ccy=${sym}&period=1H`));
    const last = daily.at(-1)?.[0] ?? -Infinity;
    // Jour en cours : la valeur en direct (même périmètre). Les jours déjà publiés que la série n'a plus sont gardés.
    const today = Math.floor(Date.now() / DAY);
    const known = [...daily, ...hourly.filter(([d]) => d > last)];
    const fresh = withLive(known, liveOi, today) || known;
    return mergePoints(prevOi, fresh.map(([d, v]) => [d, sig(v, 4)]), 1000);
  });
  sources.oi = oi.ok ? 'ok' : 'erreur';
  if (oi.ok) out.oi = oi.value;
  const ls = await attempt(`${sym} long/short`, async () => {
    const rows = await okx(`/rubik/stat/contracts/long-short-account-ratio?ccy=${sym}&period=1D`);
    return toDaily(rows.map(r => [Number(r[0]), Number(r[1])]).filter(([, v]) => v > 0)).map(([d, v]) => [d, sig(v, 4)]);
  });
  sources.longShort = ls.ok ? 'ok' : 'erreur';
  if (ls.ok) out.longShort = ls.value;
  return { ...out, sources };
}

// Traduction gratuite : Google (accès public), sinon MyMemory, phrase par phrase (500 caractères au plus par demande).
// Google refuse quand l'Actu vient de lui envoyer tous ses titres : on ne l'attend pas, il est laissé de côté
// jusqu'à la fin du passage.
let googleOff = false;
async function translate(text) {
  if (!googleOff) {
    const r = await attempt('Traduction Google', () => fetchJson(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fr&dt=t&q=${encodeURIComponent(text)}`, { retries: 0, timeout: 15_000 }));
    const out = r.ok ? (r.value?.[0] || []).map(s => s?.[0] ?? '').join('').trim() : '';
    if (out) return out;
    googleOff = true;
  }
  const parts = [];
  for (const s of sentences(text)) {
    const r = await attempt('Traduction MyMemory', () => fetchJson(`https://api.mymemory.translated.net/get?langpair=en|fr&q=${encodeURIComponent(s)}`, { retries: 0, timeout: 15_000 }));
    const out = r.ok ? decode(r.value?.responseData?.translatedText ?? '').trim() : '';
    if (!out || Number(r.value?.responseStatus) !== 200 || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) return null;
    parts.push(out);
  }
  return parts.join(' ') || null;
}

// Présentation du projet : texte en français (traduit de l'anglais au besoin), catégories, date de lancement, liens.
async function about(id) {
  const c = await gecko(`/coins/${id}?localization=true&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`);
  const fr = excerpt(c.description?.fr), en = excerpt(c.description?.en);
  const translated = !fr && en ? await translate(en) : null;
  const l = c.links || {};
  const first = list => cleanLink((Array.isArray(list) ? list.find(u => /^https?:\/\//.test(u || '')) : null) || null);
  return {
    text: fr || translated || en || null,
    lang: fr || translated ? 'fr' : en ? 'en' : null,
    categories: (c.categories || []).filter(Boolean).slice(0, 4),
    genesis: c.genesis_date || null,
    links: {
      site: first(l.homepage),
      whitepaper: cleanLink(l.whitepaper),
      twitter: l.twitter_screen_name ? `https://x.com/${l.twitter_screen_name}` : null,
      reddit: /^https?:\/\/(www\.)?reddit\.com\/r\/\w/.test(l.subreddit_url || '') ? l.subreddit_url : null,
      github: first(l.repos_url?.github),
      explorer: first(l.blockchain_site),
    },
    fetchedAt: new Date().toISOString(),
  };
}

const readPrevious = id => (args.previous ? readFile(join(args.previous, `${id}.json`), 'utf8').then(JSON.parse).catch(() => null) : Promise.resolve(null));
const money = n => (n == null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} Md$` : `${(n / 1e6).toFixed(0)} M$`);

async function main() {
  const now = new Date();
  console.log(`Dinexo · fiches crypto · ${now.toISOString()}`);
  const list = await coinList();
  const previous = new Map(await Promise.all(list.map(async c => [c.id, await readPrevious(c.id)])));
  const mk = await attempt('CoinGecko chiffres clés', () => markets(list.map(c => c.id)));
  const inst = await attempt('OKX marchés', instruments);
  const liveOi = await attempt('OKX open interest en direct', () => liveOpenInterest(okx));
  // Présentations à rafraîchir : celles qui manquent, puis les plus anciennes au-delà de 3 jours.
  const age = id => { const t = previous.get(id)?.about?.fetchedAt; return t ? now - new Date(t) : Infinity; };
  const stale = list.filter(c => age(c.id) > ABOUT_DAYS * DAY).sort((a, b) => age(b.id) - age(a.id));
  const refresh = new Set(stale.filter((c, i) => age(c.id) === Infinity || i < ABOUT_PER_RUN).map(c => c.id));

  await mkdir(OUT, { recursive: true });
  const dumps = [];
  for (const coin of list) {
    const prev = previous.get(coin.id);
    const sym = coin.symbol;
    if (late()) {
      if (prev) await writeFile(join(OUT, `${coin.id}.json`), JSON.stringify(prev));
      console.log(`${sym} : temps écoulé, ${prev ? 'version déjà en ligne gardée' : 'pas de fiche'}.`);
      continue;
    }
    const sources = {};
    const spot = inst.ok && inst.value.spot.has(sym) ? `${sym}-USDT` : null;
    const swap = inst.ok && inst.value.swap.has(sym) ? `${sym}-USDT-SWAP` : null;
    const src = spot || swap;
    const d1R = src ? await attempt(`${sym} bougies 1 j`, () => okxCandles(src, '1Dutc', 7, DAY))
      : inst.ok ? await attempt(`${sym} CoinGecko`, () => geckoLine(coin.id)) : { ok: false };
    const h4R = src ? await attempt(`${sym} bougies 4 h`, () => okxCandles(src, '4H', 0, HOUR)) : { ok: false };
    sources.bougies = d1R.ok ? (src ? 'okx' : 'coingecko') : 'erreur';
    const deriv = swap ? await derivatives(sym, swap, liveOi.ok ? liveOi.value.get(sym) : null, prev?.oi) : null;
    Object.assign(sources, deriv?.sources);
    let info = prev?.about ?? null;
    if (refresh.has(coin.id)) {
      const a = await attempt(`${sym} présentation`, () => about(coin.id));
      if (a.ok) info = a.value;
      sources.presentation = a.ok ? 'ok' : 'erreur';
    } else if (info?.lang === 'en' && info.text) {
      // Présentation restée en anglais (traduction indisponible au passage précédent) : on retente la traduction seule.
      const fr = await translate(info.text);
      if (fr) { info = { ...info, text: fr, lang: 'fr' }; sources.presentation = 'traduite'; }
    }
    // Une source muette : la partie correspondante de la fiche déjà en ligne est gardée.
    const d1 = d1R.ok && d1R.value.length ? d1R.value : prev?.candles?.d1 || [];
    const out = {
      generatedAt: now.toISOString(),
      sample: Boolean(args.sample),
      id: coin.id, symbol: sym, name: coin.name,
      market: (mk.ok && mk.value.get(coin.id)) || prev?.market || null,
      okx: { spot, swap, maxLever: swap ? inst.value.swap.get(sym) : null, candles: d1R.ok ? src : prev?.okx?.candles ?? null },
      candles: {
        line: d1R.ok ? !src : Boolean(prev?.candles?.line),
        d1,
        h4: h4R.ok && h4R.value.length ? h4R.value : d1R.ok && !src ? [] : prev?.candles?.h4 || [],
      },
      funding: deriv ? deriv.funding ?? prev?.funding ?? null : null,
      oi: deriv ? (deriv.oi.length ? deriv.oi : prev?.oi || []) : [],
      longShort: deriv ? (deriv.longShort.length ? deriv.longShort : prev?.longShort || []) : [],
      about: info,
      sources,
    };
    if (!out.candles.d1.length) { console.log(`${sym} : pas de bougies, pas de fiche.`); continue; }
    await writeFile(join(OUT, `${coin.id}.json`), JSON.stringify(out));
    const read = coinSignals({ symbol: sym, d1: out.candles.d1, h4: out.candles.h4, funding: out.funding?.history || [], oi: out.oi });
    console.log([
      `${sym} (${coin.id}) : ${out.candles.d1.length} j + ${out.candles.h4.length} × 4 h · ${src || 'CoinGecko'}`,
      swap ? `levier max ${out.okx.maxLever}× · funding ${out.funding?.rate ?? '—'} %/8 h · OI ${money(out.oi.at(-1)?.[1])} · L/S ${out.longShort.at(-1)?.[1] ?? '—'}` : 'pas de perpétuel OKX',
      `${read.verdict.label} (${read.verdict.up}/${read.verdict.down} sur ${read.verdict.total})`,
      `présentation ${info?.lang ?? '—'}${sources.presentation === 'ok' ? '' : ` (${sources.presentation || 'reprise'})`}`,
      `sources ${JSON.stringify(sources)}`,
    ].join(' · '));
    dumps.push([coin.id, out]);
  }
  // Sur une branche de test, chaque fiche est recopiée dans le journal (compressée) pour les aperçus,
  // avec les données Marché, Actu et Setups du même passage (BTC, dominance, news et setups de la fiche).
  if (process.env.PUBLISH === 'false') {
    const site = await Promise.all(['marche', 'news', 'setups'].map(async n => [`_${n}`, await readFile(join(args.out || 'data', `${n}.json`), 'utf8').then(JSON.parse).catch(() => null)]));
    for (const [id, out] of [...dumps, ...site.filter(([, v]) => v)]) {
      const gz = gzipSync(JSON.stringify(out)).toString('base64');
      const n = Math.ceil(gz.length / 8000);
      for (let i = 0; i < n; i++) console.log(`CRYPTO_GZ ${id} ${i + 1}/${n} ${gz.slice(i * 8000, (i + 1) * 8000)}`);
    }
  }
  if (!dumps.length) throw new Error('Aucune fiche à jour : les versions déjà en ligne sont conservées.');
}

main().catch(err => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});

