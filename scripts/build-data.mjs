#!/usr/bin/env node
// Récupère les données publiques et écrit les fichiers JSON lus par le dashboard.
// Usage : node scripts/build-data.mjs [--out data] [--previous ancien-projects.json]
// Lancé toutes les heures par GitHub Actions (.github/workflows/deploy.yml).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attempt, fetchJson, mapLimit } from './lib/http.mjs';
import {
  DEFAULTS, buildProject, findToken, groupFees, holdersRevenueByKey, markNew, mergeDaily, preselect, scoreProjects,
} from './lib/projects.mjs';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true]] : [])));
const OUT = args.out || 'data';
const LLAMA = 'https://api.llama.fi';
const CG = 'https://api.coingecko.com/api/v3';
const cgHeaders = process.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const sources = {};
const warnings = [];
const track = (name, res, warning) => {
  sources[name] = res.ok ? 'ok' : 'erreur';
  if (!res.ok && warning) warnings.push(warning);
  return res.ok ? res.value : null;
};

async function main() {
  const now = new Date();
  console.log(`Dinexo · mise à jour des données · ${now.toISOString()}`);

  // 1. DefiLlama : revenus (obligatoire), revenus reversés aux détenteurs, liste des protocoles.
  const feesUrl = type => `${LLAMA}/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=${type}`;
  const [rev, holders, protocols, lite] = await Promise.all([
    attempt('DefiLlama revenus', () => fetchJson(feesUrl('dailyRevenue'))),
    attempt('DefiLlama revenus détenteurs', () => fetchJson(feesUrl('dailyHoldersRevenue'))),
    attempt('DefiLlama protocoles', () => fetchJson(`${LLAMA}/protocols`)),
    attempt('DefiLlama protocoles parents', () => fetchJson(`${LLAMA}/lite/protocols2`)),
  ]);
  if (!rev.ok || !protocols.ok) throw new Error('DefiLlama indisponible : la version déjà en ligne est conservée.');
  sources.defillama = 'ok';
  const holdersData = track('buybacks', holders, 'Buybacks non vérifiés à cette mise à jour.');
  const parentProtocols = lite.ok ? lite.value.parentProtocols || [] : [];

  const groups = groupFees(rev.value.protocols || [], parentProtocols);
  const holdersByKey = holdersData ? holdersRevenueByKey(holdersData.protocols || []) : new Map();
  const tokens = new Map();
  for (const g of groups) {
    const t = findToken(g, protocols.value, parentProtocols);
    if (t) tokens.set(g.key, t);
  }

  // 2. Listings : Binance (exclusion), Binance Alpha, OKX.
  const [binance, alpha, okx] = await Promise.all([
    attempt('Binance', async () => {
      let info;
      try { info = await fetchJson('https://data-api.binance.vision/api/v3/exchangeInfo', { retries: 1 }); }
      catch { info = await fetchJson('https://api.binance.com/api/v3/exchangeInfo', { retries: 1 }); }
      return new Set(info.symbols.filter(s => s.status === 'TRADING').map(s => s.baseAsset.toUpperCase()));
    }),
    attempt('Binance Alpha', async () => {
      const r = await fetchJson('https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list', { retries: 1 });
      return new Set((r.data || []).map(t => String(t.symbol).toUpperCase()));
    }),
    attempt('OKX', async () => {
      const r = await fetchJson('https://www.okx.com/api/v5/public/instruments?instType=SPOT', { retries: 1 });
      return new Set((r.data || []).map(i => String(i.baseCcy).toUpperCase()));
    }),
  ]);
  const binanceSet = track('binance', binance, 'Listings Binance non vérifiés : certains projets affichés sont peut-être déjà sur Binance.');
  const listings = {
    alpha: track('binanceAlpha', alpha, null),
    okx: track('okx', okx, 'Disponibilité sur OKX non vérifiée à cette mise à jour.'),
  };

  // 3. CoinGecko : market cap et offre en circulation, uniquement pour les candidats.
  const geckoIds = [...new Set(groups
    .filter(g => tokens.has(g.key) && g.revenue30d >= DEFAULTS.minRevenue30d)
    .map(g => tokens.get(g.key).geckoId))];
  const markets = new Map();
  const cg = await attempt('CoinGecko marchés', async () => {
    for (let i = 0; i < geckoIds.length; i += 200) {
      const ids = geckoIds.slice(i, i + 200).join(',');
      const page = await fetchJson(`${CG}/coins/markets?vs_currency=usd&per_page=250&price_change_percentage=24h,7d&ids=${ids}`, { headers: cgHeaders, retries: 4 });
      page.forEach(m => markets.set(m.id, m));
      if (i + 200 < geckoIds.length) await sleep(2500);
    }
    return true;
  });
  if (!track('coingecko', cg, 'Market caps CoinGecko indisponibles : valeurs DefiLlama utilisées, flottant non calculé.')) markets.clear();
  const trending = await attempt('CoinGecko tendances', () => fetchJson(`${CG}/search/trending`, { headers: cgHeaders }));
  listings.trending = track('tendances', trending, null) ? new Set((trending.value.coins || []).map(c => c.item?.id)) : null;

  // 4. Pré-sélection puis analyse détaillée (série de revenus, TVL, levées de fonds).
  const { kept, counts } = preselect(groups, { tokens, markets, binance: binanceSet });
  console.log('Pré-sélection :', counts);

  const detailed = await mapLimit(kept, 4, async ({ group, token, market }) => {
    const charts = await mapLimit(group.children, 2, c =>
      fetchJson(`${LLAMA}/summary/fees/${c.slug}?dataType=dailyRevenue`, { retries: 2 }).then(r => r.totalDataChart).catch(() => null));
    const daily = mergeDaily(charts.filter(Boolean));
    let detail = await fetchJson(`${LLAMA}/protocol/${group.detailSlug}`, { retries: 2 }).catch(() => null);
    if (!detail && group.children[0]?.slug !== group.detailSlug) {
      detail = await fetchJson(`${LLAMA}/protocol/${group.children[0].slug}`, { retries: 1 }).catch(() => null);
    }
    return buildProject({ group, token, market, holdersRevenue30d: holdersByKey.get(group.key) ?? 0, daily, detail, listings });
  });

  // 5. Score, nouveaux entrants, écriture.
  let previous = null;
  if (args.previous) previous = await readFile(args.previous, 'utf8').then(JSON.parse).catch(() => null);
  const projects = markNew(scoreProjects(detailed), previous, now);

  const market = await buildMarket();

  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, 'projects.json'), JSON.stringify({ generatedAt: now.toISOString(), sample: Boolean(args.sample), sources, warnings, counts, projects }));
  await writeFile(join(OUT, 'market.json'), JSON.stringify({ generatedAt: now.toISOString(), sample: Boolean(args.sample), ...market }));

  console.log(`\n${projects.length} projets écrits dans ${OUT}/projects.json. Sources :`, sources);
  for (const p of projects.slice(0, 10)) {
    console.log(`#${p.rank} ${p.name} (${p.symbol}) score ${p.score} · MC ${(p.mcap / 1e6).toFixed(0)} M$ · rev 30j ${(p.revenue30d / 1e3).toFixed(0)} k$ · ${Object.entries(p.badges).filter(([, v]) => v).map(([k]) => k).join(' ')}`);
  }
  const missing = k => projects.filter(p => p[k] === null || (Array.isArray(p[k]) && !p[k].length)).length;
  console.log(`Données manquantes sur ${projects.length} projets : série de revenus ${missing('series')}, croissance des revenus ${missing('revenueGrowth')}, `
    + `TVL ${missing('tvlGrowth')}, flottant ${missing('float')}, investisseurs ${missing('investors')}, site ${projects.filter(p => !p.links.site).length}`);
  if (warnings.length) console.log('Avertissements :', warnings);
}

const FNG_FR = { 'Extreme Fear': 'Peur extrême', Fear: 'Peur', Neutral: 'Neutre', Greed: 'Avidité', 'Extreme Greed': 'Avidité extrême' };

async function buildMarket() {
  const [global, fng] = await Promise.all([
    attempt('CoinGecko global', () => fetchJson(`${CG}/global`, { headers: cgHeaders })),
    attempt('Fear & Greed', () => fetchJson('https://api.alternative.me/fng/?limit=1')),
  ]);
  const f = fng.ok ? fng.value.data?.[0] : null;
  return {
    btcDominance: global.ok ? global.value.data?.market_cap_percentage?.btc ?? null : null,
    fearGreed: f ? { value: Number(f.value), label: FNG_FR[f.value_classification] || f.value_classification } : null,
  };
}

main().catch(err => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
