#!/usr/bin/env node
// Onglet Marché : chiffres clés, historique quotidien des courbes du graphique et plus grosses cryptos.
// Sources gratuites sans clé : OKX (prix, funding, open interest), DefiLlama (TVL, stablecoins, volume DEX),
// alternative.me (Fear & Greed), CoinGecko (capitalisation globale, dérivés, top cryptos, secteurs),
// ForexFactory (agenda des annonces économiques de la semaine).
// Le funding et l'open interest n'ont que quelques mois d'historique chez OKX : on garde celui déjà publié.
// Usage : node scripts/build-marche.mjs [--out data] [--previous ancien-marche.json]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attempt, fetchJson } from './lib/http.mjs';
import { liveOpenInterest, withLive } from './lib/cryptos.mjs';
import { agendaEvents, altSeason, compact, mergePoints, realCoins, SECTORS, signals, toDaily, verdict } from '../js/marche-lib.js';
import { changeOver } from '../js/crypto-lib.js';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true]] : [])));
const OUT = args.out || 'data';
const OKX = 'https://www.okx.com/api/v5';
const LLAMA = 'https://api.llama.fi';
const CG = 'https://api.coingecko.com/api/v3';
const FF = 'https://nfs.faireconomy.media';
const cgHeaders = process.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAYS = 1500; // ~4 ans

async function okx(path) {
  const r = await fetchJson(`${OKX}${path}`, { retries: 2 });
  if (r.code !== '0') throw new Error(`OKX ${r.code} ${r.msg || ''}`);
  await sleep(150);
  return r.data;
}

// Clôtures quotidiennes (UTC) d'OKX, de la plus ancienne à la plus récente.
async function closes(instId) {
  const rows = await okx(`/market/candles?instId=${instId}&bar=1Dutc&limit=300`);
  for (let i = 0; i < 12 && rows.length < DAYS; i++) {
    const older = await okx(`/market/history-candles?instId=${instId}&bar=1Dutc&limit=100&after=${rows.at(-1)[0]}`);
    if (!older.length) break;
    rows.push(...older);
  }
  return toDaily(rows.map(r => [Number(r[0]), Number(r[4])]));
}

// Funding BTC : une valeur toutes les 8 h, moyenne par jour, en % par période.
async function funding() {
  const rows = await okx('/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100');
  for (let i = 0; i < 4; i++) {
    const older = (await okx(`/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100&after=${rows.at(-1).fundingTime}`))
      .filter(r => Number(r.fundingTime) < Number(rows.at(-1).fundingTime));
    if (!older.length) break;
    rows.push(...older);
  }
  const unique = new Map(rows.map(r => [r.fundingTime, Number(r.realizedRate || r.fundingRate) * 100]));
  return toDaily([...unique].map(([t, v]) => [Number(t), v]), { mean: true });
}

// Tuile Dérivés : volume sur 24 h et open interest de toutes les plateformes, en dollars au dernier prix BTC.
function derivTile(list, btcPrice) {
  if (!Array.isArray(list) || !btcPrice) return null;
  const rows = list.map(x => ({ name: x.name, vol: Number(x.trade_volume_24h_btc), oi: Number(x.open_interest_btc) }))
    .filter(x => x.vol > 0 || x.oi > 0);
  if (!rows.length) return null;
  const sum = k => rows.reduce((s, x) => s + (x[k] > 0 ? x[k] : 0), 0);
  console.log(`Dérivés : ${rows.length} plateformes · ${rows.slice(0, 6).map(x => `${x.name} ${Math.round(x.oi)} BTC`).join(' · ')}`);
  return { volume24h: sum('vol') * btcPrice, openInterest: sum('oi') * btcPrice, exchanges: rows.length };
}

async function main() {
  const now = new Date();
  console.log(`Dinexo · onglet Marché · ${now.toISOString()}`);
  const previous = args.previous ? await readFile(args.previous, 'utf8').then(JSON.parse).catch(() => null) : null;
  const sources = {};
  const take = (name, res) => { sources[name] = res.ok ? 'ok' : 'erreur'; return res.ok ? res.value : null; };

  const [btc, eth, sol, brent, fu, oi] = [
    take('okx BTC', await attempt('OKX BTC', () => closes('BTC-USDT'))),
    take('okx ETH', await attempt('OKX ETH', () => closes('ETH-USDT'))),
    take('okx SOL', await attempt('OKX SOL', () => closes('SOL-USDT'))),
    take('okx Brent', await attempt('OKX Brent', () => closes('BZ-USDT-SWAP'))),
    take('funding', await attempt('OKX funding', funding)),
    take('open interest', await attempt('OKX open interest', async () => {
      const rows = await okx('/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D');
      // La journée en cours arrive parfois à 0 : on l'ignore.
      const daily = toDaily(rows.map(r => [Number(r[0]), Number(r[1])]).filter(([, v]) => v > 0));
      // Les valeurs quotidiennes ont 2 à 3 jours de retard : le jour en cours prend la valeur en direct, gardée
      // d'un passage à l'autre, ce qui remplit les jours manquants au fil des mises à jour.
      const live = (await attempt('OKX open interest en direct', () => liveOpenInterest(okx))).value?.get('BTC');
      const withToday = withLive(daily, live, Math.floor(now / 86_400_000));
      console.log(`Open interest BTC en direct : ${live ? `${(live / 1e9).toFixed(2)} Md$` : '—'} (dernière valeur quotidienne ${(daily.at(-1)?.[1] / 1e9).toFixed(2)} Md$)${live && !withToday ? ' : écart trop grand, pas utilisée' : ''}`);
      return withToday || daily;
    })),
  ];
  const [fngR, stR, tvlR, dexR, globalR, weekR, nextWeekR] = await Promise.all([
    attempt('Fear & Greed', () => fetchJson('https://api.alternative.me/fng/?limit=0')),
    attempt('DefiLlama stablecoins', () => fetchJson('https://stablecoins.llama.fi/stablecoincharts/all')),
    attempt('DefiLlama TVL', () => fetchJson(`${LLAMA}/v2/historicalChainTvl`)),
    attempt('DefiLlama DEX', () => fetchJson(`${LLAMA}/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`)),
    attempt('CoinGecko global', () => fetchJson(`${CG}/global`, { headers: cgHeaders })),
    attempt('Agenda de la semaine', () => fetchJson(`${FF}/ff_calendar_thisweek.json`)),
    attempt('Agenda de la semaine prochaine', () => fetchJson(`${FF}/ff_calendar_nextweek.json`, { retries: 0 })),
  ]);
  const fng = take('fear & greed', fngR) && toDaily(fngR.value.data.map(x => [Number(x.timestamp) * 1000, Number(x.value)]));
  const stables = take('stablecoins', stR) && toDaily(stR.value.map(x => [Number(x.date) * 1000, Number(x.totalCirculatingUSD?.peggedUSD)]));
  const tvl = take('tvl', tvlR) && toDaily(tvlR.value.map(x => [Number(x.date) * 1000, Number(x.tvl)]));
  const global = take('coingecko global', globalR)?.data;
  await sleep(1500);
  const coinsR = await attempt('CoinGecko top', () => fetchJson(`${CG}/coins/markets?vs_currency=usd&per_page=100&price_change_percentage=24h,7d,30d`, { headers: cgHeaders, retries: 4 }));
  const coins = take('coingecko top', coinsR);
  // Dérivés (perpétuels et contrats à terme) de toutes les plateformes suivies par CoinGecko, en BTC.
  await sleep(1500);
  const derivR = await attempt('CoinGecko dérivés', () => fetchJson(`${CG}/derivatives/exchanges?order=open_interest_btc_desc&per_page=100`, { headers: cgHeaders, retries: 3 }));
  const derivs = take('dérivés', derivR);
  await sleep(1500);
  const catsR = await attempt('CoinGecko secteurs', () => fetchJson(`${CG}/coins/categories`, { headers: cgHeaders, retries: 3 }));
  const cats = take('secteurs', catsR);

  // Chaque courbe garde son historique déjà publié si la source ne répond pas, ou n'a que les derniers mois.
  const old = previous?.series || {};
  const serie = (key, label, unit, points) => ({ label, unit, points: compact(mergePoints(old[key]?.points, points || [], DAYS)) });
  const series = {
    btc: serie('btc', 'Prix BTC', '$', btc),
    eth: serie('eth', 'Prix ETH', '$', eth),
    sol: serie('sol', 'Prix SOL', '$', sol),
    brent: serie('brent', 'Pétrole Brent', '$', brent),
    // CoinGecko ne donne pas l'historique de la dominance gratuitement : on ajoute un point par jour à chaque passage.
    dominance: serie('dominance', 'Dominance BTC', '%', global?.market_cap_percentage?.btc != null ? [[Math.floor(now / 86_400_000), global.market_cap_percentage.btc]] : []),
    tvl: serie('tvl', 'Argent bloqué en DeFi', '$', tvl?.slice(-DAYS)),
    fng: serie('fng', 'Fear & Greed', '', fng?.slice(-DAYS)),
    stables: serie('stables', 'Stablecoins en circulation', '$', stables?.slice(-DAYS)),
    funding: serie('funding', 'Funding BTC', '% / 8 h', fu),
    oi: serie('oi', 'Open interest BTC', '$', oi),
  };
  const list = signals(series);

  const last = pts => pts?.at(-1)?.[1] ?? null;
  const ago = (pts, d) => { const t = pts?.at(-1)?.[0] - d; const p = pts?.findLast(x => x[0] <= t); return p ? p[1] : null; };
  const rel = (a, b) => (a != null && b ? a / b - 1 : null);
  const overview = r => (r.ok ? { total24h: r.value.total24h ?? null, change1d: r.value.change_1d != null ? r.value.change_1d / 100 : null } : null);
  const tiles = {
    marketCap: global ? { value: global.total_market_cap?.usd ?? null, change24h: global.market_cap_change_percentage_24h_usd != null ? global.market_cap_change_percentage_24h_usd / 100 : null } : null,
    volume24h: global?.total_volume?.usd ?? null,
    btcDominance: global?.market_cap_percentage?.btc ?? null,
    ethDominance: global?.market_cap_percentage?.eth ?? null,
    fearGreed: fng ? { value: last(fng), change1d: last(fng) - (ago(fng, 1) ?? last(fng)) } : null,
    tvl: tvl ? { value: last(tvl), change1d: rel(last(tvl), ago(tvl, 1)) } : null,
    stables: stables ? { value: last(stables), change7d: rel(last(stables), ago(stables, 7)) } : null,
    dex: overview(dexR),
    derivs: derivTile(derivs, last(btc)),
  };
  sources.dex = dexR.ok ? 'ok' : 'erreur';

  // Les 100 plus grosses cryptos au format du tableau (variations en fraction : 0,05 = +5 %). Les 20 premières hors
  // stablecoins forment le tableau ; l'identifiant CoinGecko ouvre la fiche de la crypto (#crypto/<id>, scripts/build-cryptos.mjs).
  const ratio = v => (v == null ? null : v / 100);
  const market = coins ? coins.map(c => ({
    id: c.id, symbol: String(c.symbol).toUpperCase(), name: c.name, price: c.current_price, mcap: c.market_cap, volume: c.total_volume,
    change24h: ratio(c.price_change_percentage_24h_in_currency), change7d: ratio(c.price_change_percentage_7d_in_currency),
    change30d: ratio(c.price_change_percentage_30d_in_currency),
  })) : null;
  const top = market ? realCoins(market).slice(0, 20) : previous?.top || [];
  const today = Math.floor(now / 86_400_000);

  // Saison des altcoins, avec un point par jour gardé d'un passage à l'autre.
  const season = market && altSeason(market);
  const altseason = season ? { ...season, history: mergePoints(previous?.altseason?.history, [[today, season.value]], 400) } : previous?.altseason || null;
  if (season) console.log(`Saison des altcoins : ${season.beat}/${season.total} font mieux que BTC sur 30 jours (BTC ${(season.btc30d * 100).toFixed(1)} %) → ${season.label} (${season.value})`);

  // Secteurs : capitalisation et variation sur 24 h des catégories CoinGecko suivies. CoinGecko ne donne pas la
  // variation sur 7 jours : chaque secteur garde un point par jour d'un passage à l'autre pour la calculer.
  const symbolOf = new Map((market || []).map(c => [c.id, c.symbol]));
  const sectors = cats ? { list: SECTORS.map(([id, name]) => {
    const c = cats.find(x => x.id === id);
    if (!(c?.market_cap > 0)) return null;
    const history = compact(mergePoints(previous?.sectors?.list?.find(x => x.id === id)?.history, [[today, c.market_cap]], 60));
    return { id, name, mcap: c.market_cap, change24h: ratio(c.market_cap_change_24h), change7d: changeOver(history, 7), volume24h: c.volume_24h ?? null,
      top: (c.top_3_coins_id || []).map(i => symbolOf.get(i)).filter(Boolean), history };
  }).filter(Boolean) } : previous?.sectors || null;
  if (cats) {
    const missing = SECTORS.filter(([id]) => !sectors.list.some(x => x.id === id)).map(([id]) => id);
    console.log(`Secteurs : ${sectors.list.length}/${SECTORS.length} trouvés${missing.length ? ` · absents : ${missing.join(', ')}` : ''}`);
    console.log(`Catégories CoinGecko les plus grosses : ${cats.slice(0, 40).map(x => x.id).join(', ')}`);
  }

  // Agenda : semaine en cours et semaine suivante quand ForexFactory la publie ; sans réponse, celui déjà publié.
  const arr = r => (r.ok && Array.isArray(r.value) ? r.value : null);
  const [week, nextWeek] = [arr(weekR), arr(nextWeekR)];
  sources.agenda = week ? 'ok' : 'erreur';
  const rows = [...(week || []), ...(nextWeek || [])];
  const agenda = week ? { fetchedAt: now.toISOString(), nextWeek: Boolean(nextWeek), events: agendaEvents(rows) } : previous?.agenda || null;
  if (week) {
    console.log(`Agenda : ${rows.length} annonces, ${agenda.events.length} gardées${nextWeek ? ' (semaine prochaine comprise)' : ''} · ${agenda.events.map(e => `${e.t.slice(5, 16)} ${e.en}`).join(' · ')}`);
    const kept = new Set(agenda.events.map(e => `${e.cur} ${e.en}`));
    const left = rows.filter(r => r?.impact === 'High' && !kept.has(`${r.country} ${r.title}`)).map(r => `${r.country} ${r.title}`);
    console.log(`Agenda, fort impact laissé de côté : ${left.join(' · ') || 'aucune'}`);
  }

  await mkdir(OUT, { recursive: true });
  const out = { generatedAt: now.toISOString(), sample: Boolean(args.sample), sources, tiles, signals: list, verdict: verdict(list), top, altseason, sectors, agenda, series };
  await writeFile(join(OUT, 'marche.json'), JSON.stringify(out));
  console.log('Sources :', sources);
  for (const [k, s] of Object.entries(series)) console.log(`${k} : ${s.points.length} jours, dernier ${s.points.at(-1)?.[1] ?? '—'}`);
  console.log(`Verdict : ${out.verdict.label} (${out.verdict.up} haussiers, ${out.verdict.down} baissiers sur ${out.verdict.total})`);
  for (const s of list) console.log(` ${s.dir > 0 ? '▲' : s.dir < 0 ? '▼' : '•'} ${s.label} : ${s.text}`);
  if (!series.btc.points.length) throw new Error('Aucun prix BTC : la version déjà en ligne est conservée.');
}

main().catch(err => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
