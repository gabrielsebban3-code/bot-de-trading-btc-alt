#!/usr/bin/env node
// Onglet Outils, catégorie « Données du marché » : flux des ETF bitcoin et ether, funding des perpétuels,
// ratio long / short des traders, taux de l'euro. Sources gratuites sans clé.
// Usage : node scripts/build-outils.mjs [--out data] [--previous ancien-outils.json] [--sample]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attempt, fetchJson, fetchText, mapLimit } from './lib/http.mjs';
import { mergeFlows, parseFarside } from '../js/outils-data.js';
import { mergePoints } from '../js/marche-lib.js';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true]] : [])));
const OUT = args.out || 'data';
const OKX = 'https://www.okx.com/api/v5';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function okx(path) {
  const r = await fetchJson(`${OKX}${path}`, { retries: 2 });
  if (r.code !== '0') throw new Error(`OKX ${r.code} ${r.msg || ''}`);
  await sleep(120);
  return r.data;
}

// Flux quotidiens des ETF au comptant, en millions de dollars, par émetteur (tableaux de farside.co.uk).
// La page « all data » donne tout l'historique ; la page courte sert de secours.
const BROWSER = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', 'Accept-Language': 'en-GB,en;q=0.9', Accept: 'text/html,application/xhtml+xml' };
const FARSIDE = { btc: ['bitcoin-etf-flow-all-data', 'btc'], eth: ['ethereum-etf-flow-all-data', 'eth'] };
// Farside refuse parfois une demande (403) : deux essais par page, on garde le tableau le plus long.
async function etf(kind) {
  const errors = [];
  let best = null;
  for (const page of FARSIDE[kind]) {
    for (let k = 0; k < 2 && !best?.full; k++) {
      try {
        const html = await fetchText(`https://farside.co.uk/${page}/`, { retries: 1, headers: BROWSER });
        const t = parseFarside(html);
        console.log(`Farside ${page} : ${t.days.length} jours (${html.length} octets)`);
        if (t.days.length > (best?.days.length ?? 0)) best = { ...t, full: page.includes('all-data') };
        break;
      } catch (e) { errors.push(`${page} : ${e.message}`); await sleep(3000); }
    }
    if (best?.full) break;
  }
  if (errors.length) console.log(`Farside ${kind}, essais refusés : ${errors.join(' ; ')}`);
  if (!best?.days.length) throw new Error(errors.join(' ; ') || 'tableau introuvable');
  return { issuers: best.issuers, days: best.days };
}

// Or, argent, actions : pas des cryptos, on les laisse de côté.
const TRADFI = new Set(['XAU', 'XAG', 'XPT', 'XPD', 'CL', 'BZ', 'NG', 'SPX', 'NDX', 'TSLA', 'NVDA', 'AAPL', 'MSTR', 'COIN']);

// Funding des 20 perpétuels USDT les plus échangés sur OKX, et des mêmes actifs sur Hyperliquid.
async function funding() {
  const tickers = await okx('/market/tickers?instType=SWAP');
  const top = tickers.filter(t => t.instId.endsWith('-USDT-SWAP') && !TRADFI.has(t.instId.split('-')[0]))
    .map(t => ({ instId: t.instId, sym: t.instId.split('-')[0], vol: Number(t.volCcy24h) * Number(t.last), last: Number(t.last) }))
    .sort((a, b) => b.vol - a.vol).slice(0, 20);
  const rates = await mapLimit(top, 4, async t => {
    const [f] = await okx(`/public/funding-rate?instId=${t.instId}`);
    return { sym: t.sym, price: t.last, volume: t.vol, okx: Number(f.fundingRate) * 100, next: Number(f.nextFundingTime || f.fundingTime), every: 8 };
  });
  const hl = await attempt('Hyperliquid', () => fetchJson('https://api.hyperliquid.xyz/info', { method: 'POST', body: JSON.stringify({ type: 'metaAndAssetCtxs' }), headers: { 'Content-Type': 'application/json' }, retries: 1 }));
  if (hl.ok) {
    const [meta, ctxs] = hl.value;
    const bySym = new Map(meta.universe.map((u, i) => [u.name, ctxs[i]]));
    // Hyperliquid paie le funding toutes les heures : on le ramène à 8 h pour comparer avec OKX.
    for (const r of rates) { const c = bySym.get(r.sym) ?? bySym.get(`k${r.sym}`); if (c) r.hyperliquid = Number(c.funding) * 100 * 8; }
  }
  return rates;
}

// Part des comptes long et short sur OKX (BTC, ETH), une valeur par jour.
async function longShort(ccy) {
  const rows = await okx(`/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=1D`);
  return rows.map(r => [Math.floor(Number(r[0]) / 86_400_000), Number(r[1])]).filter(([, v]) => v > 0).sort((a, b) => a[0] - b[0]);
}

// Part des montants en long chez les gros traders d'OKX (les 5 % de comptes aux plus grosses positions) :
// longs ÷ shorts en valeur, une valeur par jour. OKX donne 100 jours par demande : on remonte de quelques pages.
async function topTraders(ccy) {
  const rows = [];
  let end = '';
  for (let i = 0; i < 4; i++) {
    const page = await okx(`/rubik/stat/contracts/long-short-position-ratio-contract-top-trader?instId=${ccy}-USDT-SWAP&period=1D&limit=100${end && `&end=${end}`}`);
    if (!page.length) break;
    rows.push(...page);
    const oldest = Math.min(...page.map(r => Number(r[0])));
    if (end && oldest >= Number(end)) break;
    end = String(oldest - 1);
  }
  const m = new Map(rows.map(r => [Math.floor(Number(r[0]) / 86_400_000), Number(r[1])]).filter(([, v]) => v > 0));
  return [...m].sort((a, b) => a[0] - b[0]);
}

// Achats et ventes « au marché » (ordres qui prennent le prix tout de suite) sur les contrats : part des achats en %.
async function taker(ccy) {
  const rows = await okx(`/rubik/stat/taker-volume?ccy=${ccy}&instType=CONTRACTS&period=1D`);
  return rows.map(r => [Math.floor(Number(r[0]) / 86_400_000), Number(r[2]), Number(r[1])])
    .filter(([, b, s]) => b + s > 0).map(([d, b, s]) => [d, b / (b + s) * 100]).sort((a, b) => a[0] - b[0]);
}

async function main() {
  const now = new Date();
  console.log(`Dinexo · Outils (données) · ${now.toISOString()}`);
  const previous = args.previous ? await readFile(args.previous, 'utf8').then(JSON.parse).catch(() => null) : null;
  const sources = {};
  const take = (name, res) => { sources[name] = res.ok ? 'ok' : `erreur : ${res.error?.message || res.error}`; return res.ok ? res.value : null; };

  const btcEtf = take('ETF bitcoin (Farside)', await attempt('Farside BTC', () => etf('btc')));
  const ethEtf = take('ETF ether (Farside)', await attempt('Farside ETH', () => etf('eth')));
  const fund = take('funding (OKX, Hyperliquid)', await attempt('Funding', funding));
  const lsBtc = take('long/short BTC (OKX)', await attempt('Long/short BTC', () => longShort('BTC')));
  const lsEth = take('long/short ETH (OKX)', await attempt('Long/short ETH', () => longShort('ETH')));
  const topBtc = take('gros traders BTC (OKX)', await attempt('Gros traders BTC', () => topTraders('BTC')));
  const topEth = take('gros traders ETH (OKX)', await attempt('Gros traders ETH', () => topTraders('ETH')));
  const tkBtc = take('acheteurs / vendeurs BTC (OKX)', await attempt('Acheteurs BTC', () => taker('BTC')));
  const tkEth = take('acheteurs / vendeurs ETH (OKX)', await attempt('Acheteurs ETH', () => taker('ETH')));
  const eur = take('euro (BCE via frankfurter.app)', await attempt('Euro', () => fetchJson('https://api.frankfurter.app/latest?from=EUR&to=USD', { retries: 2 })));

  const old = previous?.etf || {};
  const keep = (before, next) => mergePoints(before || [], next || [], 1500).map(([d, v]) => [d, Math.round(v * 1000) / 1000]);
  const out = {
    generatedAt: now.toISOString(),
    sample: Boolean(args.sample),
    sources,
    etf: {
      btc: btcEtf ? mergeFlows(old.btc, btcEtf) : old.btc ?? null,
      eth: ethEtf ? mergeFlows(old.eth, ethEtf) : old.eth ?? null,
    },
    funding: fund ?? previous?.funding ?? [],
    longShort: { btc: keep(previous?.longShort?.btc, lsBtc), eth: keep(previous?.longShort?.eth, lsEth) },
    // Ces séries gardent l'historique déjà publié : OKX ne donne que les derniers mois.
    topTraders: { btc: keep(previous?.topTraders?.btc, topBtc), eth: keep(previous?.topTraders?.eth, topEth) },
    taker: { btc: keep(previous?.taker?.btc, tkBtc), eth: keep(previous?.taker?.eth, tkEth) },
    eur: eur?.rates?.USD ? { usd: eur.rates.USD, date: eur.date } : previous?.eur ?? null,
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'outils.json'), JSON.stringify(out));
  for (const [k, v] of Object.entries(sources)) console.log(`${k} : ${v}`);
  for (const k of ['btc', 'eth']) {
    const e = out.etf[k];
    if (e) console.log(`ETF ${k} : ${e.days.length} jours, ${e.issuers.length} émetteurs, dernier ${JSON.stringify(e.days.at(-1))}`);
  }
  console.log(`Funding : ${out.funding.map(f => `${f.sym} ${f.okx?.toFixed(4)}/${f.hyperliquid?.toFixed(4) ?? '—'}`).join(', ')}`);
  console.log(`Long/short : BTC ${out.longShort.btc.length} jours (dernier ${out.longShort.btc.at(-1)?.[1]}), ETH ${out.longShort.eth.length}`);
  for (const k of ['topTraders', 'taker']) console.log(`${k} : BTC ${out[k].btc.length} jours (dernier ${JSON.stringify(out[k].btc.at(-1))}), ETH ${out[k].eth.length}`);
  console.log(`Euro : ${JSON.stringify(out.eur)}`);
  // Sur une branche de test, une copie allégée part dans le journal pour les aperçus (bêta) : le total de chaque jour,
  // le détail par ETF sur les 20 derniers jours seulement, avec des sommes de contrôle pour vérifier la recopie.
  if (process.env.PUBLISH === 'false') {
    const r = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
    const etfLite = e => e && { issuers: e.issuers, days: e.days.map((d, i) => (i >= e.days.length - 20 ? [d[0], r(d[1], 1), d[2].map(v => r(v, 1))] : [d[0], r(d[1], 1)])) };
    const lite = {
      generatedAt: out.generatedAt,
      sources: out.sources,
      etf: { btc: etfLite(out.etf.btc), eth: etfLite(out.etf.eth) },
      funding: out.funding.map(f => ({ sym: f.sym, price: Number(f.price.toPrecision(6)), volume: Math.round(f.volume), okx: r(f.okx, 5), hyperliquid: f.hyperliquid == null ? null : r(f.hyperliquid, 5) })),
      longShort: { btc: out.longShort.btc.map(([d, v]) => [d, r(v, 2)]), eth: out.longShort.eth.map(([d, v]) => [d, r(v, 2)]) },
      topTraders: out.topTraders,
      taker: out.taker,
      eur: out.eur,
    };
    // Courbes de l'onglet Marché (prix, peur et avidité, open interest, funding), si elles sont déjà prêtes à ce passage.
    const marche = await readFile(join(OUT, 'marche.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (marche?.series) lite.series = Object.fromEntries(['btc', 'eth', 'fng', 'oi', 'funding'].map(k => [k, marche.series[k]?.points?.map(([d, v]) => [d, Number(v.toPrecision(5))])]));
    const sum = list => r(list.reduce((s, v) => s + v, 0), 2);
    console.log(`OUTILS_CHECK ${JSON.stringify({
      btc: lite.etf.btc && [lite.etf.btc.days.length, sum(lite.etf.btc.days.map(d => d[1]))],
      eth: lite.etf.eth && [lite.etf.eth.days.length, sum(lite.etf.eth.days.map(d => d[1]))],
      funding: [lite.funding.length, sum(lite.funding.map(f => f.okx))],
      ls: [lite.longShort.btc.length, sum(lite.longShort.btc.map(d => d[1])), lite.longShort.eth.length, sum(lite.longShort.eth.map(d => d[1]))],
    })}`);
    const txt = JSON.stringify(lite);
    const size = 4000;
    const n = Math.ceil(txt.length / size);
    for (let i = 0; i < n; i++) console.log(`OUTILS_JSON ${i + 1}/${n} ${txt.slice(i * size, (i + 1) * size)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
