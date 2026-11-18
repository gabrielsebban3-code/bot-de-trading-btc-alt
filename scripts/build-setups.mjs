#!/usr/bin/env node
// Récupère les bougies 1h, 4h et 1D d'OKX pour 9 cryptos et le Brent, cherche les signaux des 3 indicateurs
// dans le sens de la tendance et calcule leur bilan, pour deux unités de temps :
// Setups (entrée 1h, tendance jour) dans setups.json, Court terme (entrée 1h, tendance 4h) dans setups-court.json.
// Usage : node scripts/build-setups.mjs [--out data] [--previous ancien-setups.json] [--sample]
// Lancé toutes les heures par GitHub Actions (.github/workflows/deploy.yml).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fetchJson, mapLimit } from './lib/http.mjs';
import { DETECTORS, MODES, RULES, dailyContext, detectorStats, indicatorState, legState, mergeHistory, radar, scanAsset, trend1d } from './lib/setups.mjs';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true]] : [])));
const OUT = args.out || 'data';
const OKX = 'https://www.okx.com/api/v5';
// Paires suivies : perpétuels USDT d'OKX. Les 6 ajoutées en novembre 2026 (XRP à ADA) sont choisies sur leur volume,
// pas sur leurs résultats passés (qui ne prédisaient rien d'une période à l'autre).
const UNIVERSE = [
  { symbol: 'BTC', name: 'Bitcoin', kind: 'crypto' },
  { symbol: 'ETH', name: 'Ethereum', kind: 'crypto' },
  { symbol: 'SOL', name: 'Solana', kind: 'crypto' },
  { symbol: 'XRP', name: 'XRP', kind: 'crypto' },
  { symbol: 'DOGE', name: 'Dogecoin', kind: 'crypto' },
  { symbol: 'BNB', name: 'BNB', kind: 'crypto' },
  { symbol: 'LINK', name: 'Chainlink', kind: 'crypto' },
  { symbol: 'AVAX', name: 'Avalanche', kind: 'crypto' },
  { symbol: 'ADA', name: 'Cardano', kind: 'crypto' },
  { symbol: 'BZ', name: 'Pétrole Brent', kind: 'commodity' },
];
const SWING = MODES.swing, COURT = MODES.court;
// Chiffres honnêtes affichés sur l'onglet : scripts/lab/honest.mjs (même moteur que le site, bougies Binance,
// frais et glissement compris), sur les 9 cryptos suivies, en 2025-2026 (période qui n'a pas servi aux réglages).
// Le Brent n'a pas assez d'historique pour ce test.
const EXPECT = {
  // Labo 5 (18 novembre 2026) : taille selon l'agitation du marché, risque de base 0,75 %. perTrade en « R de base ».
  // Capital composé sur 2025-2026 : +36 %/an, pire baisse 33 % (sans ajuster la taille, à 1 % : +23 %/an, pire baisse 39 %).
  swing: { perTrade: 0.48, winRate: 0.24, perMonth: 11, ddR: 46, streak: 30, yearPct: 36, ddPct: 33, years: '2025 : +10 % · 2026 : +60 %', safe: { base: 0.5, yearPct: 27, ddPct: 23 } },
  court: { perTrade: 0.18, winRate: 0.22, perMonth: 48, ddR: 134, streak: 51, years: '2025 : +173 % · 2026 : +13 % · 12 derniers mois : à peu près zéro' },
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// OKX limite le nombre de requêtes par seconde : on espace les appels.
function spacer(gap) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + gap;
    if (wait) await sleep(wait);
  };
}
const pace = args.sample ? { market: async () => {}, public: async () => {} } : { market: spacer(120), public: spacer(250) };

async function okx(path) {
  await (path.startsWith('/public') ? pace.public : pace.market)();
  const r = await fetchJson(`${OKX}${path}`, { retries: 2 });
  if (r.code !== '0') throw new Error(`OKX ${path} : ${r.msg || r.code}`);
  return r.data;
}

const toBar = row => ({ t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[7]), closed: row[8] === '1' });

// Bougies du plus ancien au plus récent : 300 récentes puis des pages de 100 plus anciennes.
async function candles(instId, bar, pages) {
  const rows = await okx(`/market/candles?instId=${instId}&bar=${bar}&limit=300`);
  for (let page = 0; page < pages && rows.length; page++) {
    const older = await okx(`/market/history-candles?instId=${instId}&bar=${bar}&limit=100&after=${rows.at(-1)[0]}`);
    if (!older.length) break;
    rows.push(...older);
  }
  return rows.map(toBar).sort((a, b) => a.t - b.t);
}

async function main() {
  const now = Date.now();
  console.log(`Dinexo · setups dans le sens de la tendance · ${new Date(now).toISOString()}`);
  const sources = {}, warnings = [];

  const [instruments, tickers] = await Promise.all([
    okx('/public/instruments?instType=SWAP'),
    okx('/market/tickers?instType=SWAP'),
  ]);
  sources.okx = 'ok';
  const listed = new Set(instruments.filter(i => i.state === 'live').map(i => i.instId));
  const tick = new Map(tickers.map(t => [t.instId, t]));
  const universe = UNIVERSE.filter(a => listed.has(`${a.symbol}-USDT-SWAP`));
  const missing = UNIVERSE.filter(a => !universe.includes(a)).map(a => a.symbol);
  if (missing.length) warnings.push(`Pas de perpétuel OKX actif pour ${missing.join(', ')} : actif non analysé.`);
  console.log(`Paires suivies : ${universe.map(a => a.symbol).join(' ')}`);

  let failed = 0;
  const results = await mapLimit(universe, 3, async asset => {
    const instId = `${asset.symbol}-USDT-SWAP`;
    try {
      const h1 = await candles(instId, '1H', 90);      // ~13 mois : 1 an de signaux + le temps de chauffe
      const bars = await candles(instId, '4H', 20);    // ~13 mois : indicateurs, fiche paire, tendance du court terme
      const daily = await candles(instId, '1Dutc', 3); // ~20 mois : de quoi calculer la tendance et suivre les trades
      const signals = scanAsset(asset, { bars: h1, daily }, SWING);
      const court = scanAsset(asset, { bars: h1, daily: bars }, COURT);
      const tk = tick.get(instId);
      const last = tk ? Number(tk.last) : h1.at(-1).c;
      const c4 = dailyContext(bars.filter(b => b.closed !== false));
      return {
        asset: {
          ...asset, instId, price: last,
          change24h: tk && Number(tk.open24h) ? last / Number(tk.open24h) - 1 : null,
          trend: trend1d(daily, now),
          radar: radar(h1, daily, SWING),
          ind: indicatorState(bars, daily),
          leg: legState(daily),
        },
        courtAsset: { ...asset, instId, price: last, trend: c4.trend.at(-1) ?? 'neutre', radar: radar(h1, bars, COURT) },
        signals, court, bars, daily,
        start: h1[Math.max(SWING.warmup, h1.length - SWING.backtestBars - 1)]?.t,
        courtStart: h1[Math.max(COURT.warmup, h1.length - COURT.backtestBars - 1)]?.t,
      };
    } catch (err) {
      failed++;
      console.warn(`⚠ ${asset.symbol} : ${err.message}`);
      return null;
    }
  });
  const ok = results.filter(Boolean);
  if (ok.length < Math.ceil(universe.length / 2)) throw new Error(`OKX : seulement ${ok.length} actifs sur ${universe.length} récupérés. La version déjà en ligne est conservée.`);
  if (failed) warnings.push(`${failed} actif(s) n'ont pas pu être analysés à cette mise à jour.`);

  // Historique : les signaux recalculés font foi, l'ancien historique complète la période non couverte.
  const all = ok.flatMap(r => r.signals);
  const confirmed = all.filter(s => s.status === 'confirmé');
  const freshStart = {};
  for (const key of Object.keys(DETECTORS)) {
    const starts = ok.map(r => r.start).filter(Boolean);
    if (starts.length) freshStart[key] = Math.min(...starts);
  }
  let previous = null;
  if (args.previous) previous = await readFile(args.previous, 'utf8').then(JSON.parse).catch(() => null);
  // Changement d'unité de temps (4h → 1h, novembre 2026) : l'ancien historique ne suit pas les mêmes règles, on repart de zéro.
  if (previous?.model !== SWING.key) previous = null;
  const compact = s => ({
    id: s.id, detector: s.detector, symbol: s.symbol, dir: s.dir, status: s.status, time: s.time, confirmedAt: s.confirmedAt,
    entry: s.entry, sl: s.sl, tp1: s.tp?.[0] ?? s.tp1, rr: s.rr, outcome: s.outcome, at: s.at, r: s.r, tpHit: s.tpHit ?? null,
    // Détail pour la fiche explicative du trade (absent des trades gardés d'anciennes versions).
    why: s.why, trend: s.trend, atr: s.atr, atr4h: s.atr4h, ref: s.ref, day: s.day, halfAt: s.halfAt ?? null, exitPx: s.exitPx ?? null, exitLvl: s.exitLvl ?? null,
    sz: s.sz ?? 1,
  });
  const history = mergeHistory(previous?.history, confirmed.map(compact), freshStart, now, UNIVERSE.map(a => a.symbol));
  const stats = detectorStats(history, now);

  // Signaux affichés : bougie en cours, trade encore en jeu, ou trade terminé depuis moins de 24 h.
  const isShown = s => s.status === 'en cours' || s.outcome === 'open' || (s.at !== null && s.at + SWING.E >= now - RULES.showHours * 3600_000);
  const shown = all.filter(isShown).sort((a, b) => b.time - a.time || (a.status === 'en cours' ? -1 : 1));

  // Court terme : même calcul sur l'autre unité de temps, dans son propre fichier.
  const courtAll = ok.flatMap(r => r.court);
  let prevCourt = null;
  if (args['previous-court']) prevCourt = await readFile(args['previous-court'], 'utf8').then(JSON.parse).catch(() => null);
  if (prevCourt?.model !== COURT.key) prevCourt = null;
  const courtStart = {};
  for (const key of Object.keys(DETECTORS)) {
    const starts = ok.map(r => r.courtStart).filter(Boolean);
    if (starts.length) courtStart[key] = Math.min(...starts);
  }
  const courtHistory = mergeHistory(prevCourt?.history, courtAll.filter(s => s.status === 'confirmé').map(compact), courtStart, now, UNIVERSE.map(a => a.symbol));
  const courtShown = courtAll.filter(isShown).sort((a, b) => b.time - a.time || (a.status === 'en cours' ? -1 : 1));
  const charts = {};
  for (const r of ok) {
    if (shown.some(s => s.symbol === r.asset.symbol)) charts[r.asset.symbol] = r.bars.slice(-180).map(b => [b.t, b.o, b.h, b.l, b.c]);
  }

  await mkdir(OUT, { recursive: true });
  const rulesOf = cfg => ({ minRR: RULES.minRR, stopAtr: RULES.stopAtr, partialR: RULES.partialR, exitDays: cfg.exitDays ?? RULES.exitDays, barMs: cfg.E, trendMs: cfg.T, riskPct: RULES.riskPct, sizeMin: RULES.sizeMin, sizeMax: RULES.sizeMax, showHours: RULES.showHours, statsDays: RULES.statsDays });
  await writeFile(join(OUT, 'setups.json'), JSON.stringify({
    generatedAt: new Date(now).toISOString(), sample: Boolean(args.sample), sources, warnings, model: SWING.key,
    rules: rulesOf(SWING), expect: EXPECT.swing,
    detectors: DETECTORS, freshStart,
    assets: ok.map(r => r.asset), live: shown, stats, history, charts,
  }));
  await writeFile(join(OUT, 'setups-court.json'), JSON.stringify({
    generatedAt: new Date(now).toISOString(), sample: Boolean(args.sample), model: COURT.key,
    rules: rulesOf(COURT), expect: EXPECT.court,
    detectors: COURT.detectors, freshStart: courtStart,
    assets: ok.map(r => r.courtAsset), live: courtShown, stats: detectorStats(courtHistory, now), history: courtHistory,
  }));

  // Une fiche par paire (#paire/<symbole>) : 3 mois de bougies 4h et 20 mois de bougies journalières.
  // Le 7e nombre vaut 1 quand la bougie est fermée.
  await mkdir(join(OUT, 'paire'), { recursive: true });
  const row = b => [b.t, b.o, b.h, b.l, b.c, b.v, b.closed === false ? 0 : 1];
  const pairs = ok.map(r => ({ symbol: r.asset.symbol, generatedAt: new Date(now).toISOString(), h4: r.bars.slice(-540).map(row), d1: r.daily.slice(-600).map(row) }));
  for (const p of pairs) await writeFile(join(OUT, 'paire', `${p.symbol}.json`), JSON.stringify(p));
  // Sur une branche de test, les données sont compressées dans paire-gz.txt, recopié à la fin du journal pour les aperçus.
  if (process.env.PUBLISH === 'false') {
    const site = await readFile(join(OUT, 'setups.json'), 'utf8');
    const courtText = await readFile(join(OUT, 'setups-court.json'), 'utf8');
    const lines = [];
    for (const [id, text] of [['_setups', site], ['_court', courtText], ...pairs.map(p => [p.symbol, JSON.stringify(p)])]) {
      const gz = gzipSync(text).toString('base64');
      const n = Math.ceil(gz.length / 8000);
      for (let i = 0; i < n; i++) lines.push(`PAIRE_GZ ${id} ${i + 1}/${n} ${gz.slice(i * 8000, (i + 1) * 8000)}`);
    }
    await writeFile('paire-gz.txt', `${lines.join('\n')}\n`);
  }

  console.log(`Court terme : ${courtShown.length} affichés, ${courtHistory.length} signaux dans l'historique.`);
  console.log(`\n${shown.length} setups affichés (${shown.filter(s => s.outcome === 'open').length} en jeu), ${history.length} signaux dans l'historique.`);
  for (const [key, s] of Object.entries(stats)) {
    console.log(`${DETECTORS[key].padEnd(20)} ${String(s.signals).padStart(4)} signaux · gagnants ${s.winRate === null ? '—' : `${Math.round(s.winRate * 100)} %`} · stops ${s.losses} · moitié prise ${s.tp1} · durée ${s.avgDays ?? '—'} j · R moyen ${s.avgR ?? '—'} · total ${s.totalR}R · meilleur ${s.best?.symbol ?? '—'}`);
  }
  for (const s of history.slice(0, 12)) console.log(`${new Date(s.time).toISOString().slice(0, 13)} ${s.symbol} ${s.dir} ${s.outcome} ${s.r ?? ''}`);
  for (const s of shown.slice(0, 10)) console.log(`${s.symbol} ${DETECTORS[s.detector]} ${s.dir} ${s.status} R:R ${s.rr} · ${s.outcome}`);
  for (const a of ok.map(r => r.asset)) {
    const r = a.radar;
    console.log(`Radar ${a.symbol} ${a.price} · tendance ${r?.trend ?? '—'}${r?.trigger ? ` · ${r.dir} si clôture 1h ${r.dir === 'long' ? '>' : '<'} ${r.trigger.price} (${(r.trigger.distance * 100).toFixed(1)} %, ${r.trigger.key}), stop ${r.trigger.stop.toFixed(4)}` : ''}${r?.macdReady ? ' · MACD prêt' : ''}`);
  }
  if (warnings.length) console.log('Avertissements :', warnings);
}

main().catch(err => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
