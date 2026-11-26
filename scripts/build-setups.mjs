#!/usr/bin/env node
// Récupère les bougies 1h, 4h et 1D d'OKX pour 9 cryptos et le Brent, cherche les signaux des 3 indicateurs
// dans le sens de la tendance et calcule leur bilan, pour deux unités de temps :
// Setups (entrée 1h, tendance jour) dans setups.json, Court terme (entrée 1h, tendance 4h) dans setups-court.json.
// Usage : node scripts/build-setups.mjs [--out data] [--previous ancien-setups.json] [--sample]
// Lancé toutes les heures par GitHub Actions (.github/workflows/deploy.yml).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync, inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { fetchJson, mapLimit } from './lib/http.mjs';
import { updateJournal } from '../js/journal-lib.js';
import { DETECTORS, MODES, RULES, dailyContext, detectorStats, indicatorState, grosAt, legState, marketOf, volumeZones, mergeHistory, radar, scanAsset, trend1d } from './lib/setups.mjs';

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
// Règles gelées : plus aucun réglage des Setups pendant 3 mois, le temps d'avoir de vrais résultats dans le journal.
// Changer une règle avant cette date rendrait le journal impossible à juger.
const RULES_FROZEN = { since: '2026-11-24', until: '2027-02-24' };
// Estimation prudente (test le plus sévère, 20 paires Binance, 2025-2026) : environ +0,4 fois le risque par trade.
// La période 2025-2026 a été regardée dans 6 labos avant de choisir les réglages : les chiffres d'EXPECT sont trop beaux.
const PRUDENT = { perTrade: 0.4, yearPct: 20 };
// Chiffres honnêtes affichés sur l'onglet : scripts/lab/honest.mjs (même moteur que le site, bougies Binance,
// frais et glissement compris), sur les 9 cryptos suivies, en 2025-2026 (période qui n'a pas servi aux réglages).
// Le Brent n'a pas assez d'historique pour ce test.
const EXPECT = {
  // Labo 5 (18 novembre 2026) : taille selon l'agitation du marché, risque de base 1 % (choix de Gabriel). perTrade en « R de base ».
  // Capital composé sur 2025-2026 : +42 %/an, pire baisse 42 % (sans ajuster la taille, à 1 % : +23 %/an, pire baisse 39 %).
  // Avec la note des signaux (labo 8, 19 novembre 2026), vrai code du site rejoué sur Binance 2025-2026, 9 cryptos.
  // Avec la règle des gros traders (labo 9, 23 novembre 2026, mode 'half') : vrai code du site rejoué sur Binance 2025-2026.
  swing: { prudent: PRUDENT, perTrade: 1.52, winRate: 0.38, perMonth: 4, ddR: 14, streak: 11, yearPct: 80, ddPct: 14, years: '2025 : +33 % · 2026 : +134 %', safe: { base: 0.5, yearPct: 39, ddPct: 7 },
    gros: { without: { yearPct: 86, ddPct: 19 } },
    score: { trades: 91, fixedPct: 51, without: { yearPct: 47, ddPct: 40, perMonth: 11 }, dev: { yearPct: 87, ddPct: 27 } } },
  court: { perTrade: 0.18, winRate: 0.22, perMonth: 48, ddR: 134, streak: 51, years: '2025 : +173 % · 2026 : +13 % · 12 derniers mois : à peu près zéro' },
};
// Labo 9 (23 novembre 2026) : chaque donnée testée comme tri des signaux Setups, vrai code du site, 9 cryptos Binance,
// réglage sur 2020-2024 (ou depuis que la donnée existe), vérification sur 2025-2026 et face au hasard.
// helps = la donnée a amélioré les résultats sur les deux périodes et mieux que le hasard. Texte affiché tel quel.
const CONTEXT_TEST = {
  gros: { helps: true, text: 'Testé : utile. Quand les gros traders sont déjà très acheteurs (1,65 achat pour 1 vente ou plus), les achats ont très peu rapporté : le bot les prend avec moitié moins de risque. En 2025-2026 : pire recul −14 % au lieu de −19 %, pour un gain un peu plus faible (+80 % par an au lieu de +86 %).' },
  oi: { helps: false, text: 'Testé : n\'améliore pas les signaux (2025-2026 : pas mieux que d\'écarter des signaux au hasard).' },
  crowd: { helps: false, text: 'Testé : n\'améliore pas les signaux. Le réglage trouvé sur 2021-2024 a fait pire en 2025-2026.' },
  taker: { helps: false, text: 'Testé : n\'améliore pas les signaux.' },
  funding: { helps: false, text: 'Testé : n\'améliore pas les signaux (le réglage de 2020-2024 perdait en 2025-2026).' },
  fng: { helps: false, text: 'Testé : n\'améliore pas les signaux (le réglage de 2020-2024 a fait bien pire en 2025-2026).' },
  dvol: { helps: false, text: 'Testé : n\'améliore pas les signaux de façon sûre (rien de mieux sur 2021-2024, mieux en 2025-2026 seulement).' },
  zones: { helps: false, text: 'Testé : ne sert pas à trier ces signaux. Une cassure sort par définition de la zone du mois : il n\'y a jamais de zone devant.' },
  season: { helps: false, text: 'Jour de la semaine, week-end, jour du mois, trimestre : testés, aucun n\'aide.' },
  liq: { helps: null, text: 'Pas encore testable : les prix de liquidation ne sont enregistrés que depuis quelques jours. On pourra tester dans quelques mois.' },
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

// Contexte du marché pour chaque paire (OKX, gratuit) : open interest, gros traders, foule, achats/ventes pressés, funding.
// Montré sur les cartes et la fiche paire. Labo 9 (23 novembre 2026) : voir CONTEXT_TEST pour ce que ces données valent.
async function pairContext(sym) {
  const num = (rows, k) => rows.map(r => [Number(r[0]), Number(r[k])]).filter(([, v]) => v > 0).sort((a, b) => a[0] - b[0]);
  const valAt = (pts, t) => { let v = null; for (const [ts, x] of pts) if (ts <= t) v = x; return v; };
  const out = {};
  const tryIt = async (name, fn) => { try { await fn(); } catch (err) { console.warn(`Contexte ${sym} ${name} : ${err.message}`); } };
  await tryIt('open interest', async () => {
    const oi = num(await okx(`/rubik/stat/contracts/open-interest-volume?ccy=${sym}&period=1H`), 1);
    const last = oi.at(-1);
    if (!last) return;
    const d1 = valAt(oi, last[0] - 86_400_000), d7 = valAt(oi, last[0] - 7 * 86_400_000);
    out.oi = { usd: last[1], ch1: d1 ? last[1] / d1 - 1 : null, ch7: d7 ? last[1] / d7 - 1 : null };
  });
  await tryIt('gros traders', async () => {
    const r = num(await okx(`/rubik/stat/contracts/long-short-position-ratio-contract-top-trader?instId=${sym}-USDT-SWAP&period=1H&limit=24`), 1);
    if (r.length) out.top = r.at(-1)[1];
  });
  await tryIt('foule', async () => {
    const r = num(await okx(`/rubik/stat/contracts/long-short-account-ratio?ccy=${sym}&period=1H`), 1);
    if (r.length) out.crowd = r.at(-1)[1];
  });
  await tryIt('acheteurs pressés', async () => {
    const rows = (await okx(`/rubik/stat/taker-volume?ccy=${sym}&instType=CONTRACTS&period=1H`)).map(r => [Number(r[0]), Number(r[1]), Number(r[2])]).sort((a, b) => a[0] - b[0]).slice(-24);
    const sell = rows.reduce((a, r) => a + r[1], 0), buy = rows.reduce((a, r) => a + r[2], 0);
    if (buy + sell > 0) out.taker = buy / (buy + sell);
  });
  await tryIt('funding', async () => {
    const rows = await okx(`/public/funding-rate-history?instId=${sym}-USDT-SWAP&limit=21`);
    if (rows.length) out.funding = rows.reduce((a, r) => a + Number(r.fundingRate), 0) / rows.length;
  });
  return out;
}

// Gros traders de Binance : ratio positions acheteuses / vendeuses des 20 % de comptes aux plus grosses marges,
// lu dans le fichier quotidien gratuit de data.binance.vision (publié le lendemain). On garde la valeur de 23 h UTC.
// L'historique déjà publié est repris : à chaque passage, seuls les jours manquants sont téléchargés.
function unzipFirst(buf) {
  // Fin du répertoire central, puis la première entrée (taille compressée et position de l'en-tête local).
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('zip illisible');
  const cd = buf.readUInt32LE(e + 16);
  const method = buf.readUInt16LE(cd + 10), size = buf.readUInt32LE(cd + 20), off = buf.readUInt32LE(cd + 42);
  const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
  const data = buf.subarray(start, start + size);
  return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
}
async function grosDay(sym, dayStart) {
  const d = new Date(dayStart).toISOString().slice(0, 10);
  const res = await fetch(`https://data.binance.vision/data/futures/um/daily/metrics/${sym}USDT/${sym}USDT-metrics-${d}.zip`, { headers: { 'User-Agent': 'Dinexo/1.0' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  const rows = unzipFirst(Buffer.from(await res.arrayBuffer())).split('\n').map(l => l.split(',')).filter(p => p[0]?.includes(' 23:00:00'));
  const v = rows.length ? Number(rows[0][5]) : NaN;
  return v > 0 ? Math.round(v * 1e4) / 1e4 : null;
}
async function grosHistory(symbols, previous, now) {
  const today = Math.floor(now / 86_400_000) * 86_400_000;
  const known = new Map(symbols.map(sym => [sym, new Map((previous?.[sym] ?? []).filter(([t]) => t >= today - 420 * 86_400_000))]));
  const want = [];
  for (const sym of symbols) for (let t = today - 400 * 86_400_000; t < today; t += 86_400_000) if (!known.get(sym).has(t)) want.push([sym, t]);
  const got = await mapLimit(want, 32, ([sym, t]) => grosDay(sym, t).catch(() => null));
  want.forEach(([sym, t], k) => { if (got[k] !== null) known.get(sym).set(t, got[k]); });
  const out = Object.fromEntries(symbols.map(sym => [sym, [...known.get(sym)].sort((x, y) => x[0] - y[0])]));
  console.log(`Gros traders (Binance) : ${got.filter(x => x !== null).length}/${want.length} jours ajoutés · ${symbols.map(sym => `${sym} ${out[sym].at(-1)?.[1] ?? '—'}`).join(' · ')}`);
  return out;
}

// Contexte commun à toutes les paires : peur et avidité (alternative.me) et volatilité attendue des options (Deribit DVOL).
async function globalContext(now) {
  const out = {};
  try {
    const f = await fetchJson('https://api.alternative.me/fng/?limit=8', { retries: 1 });
    const d = f.data ?? [];
    if (d.length) out.fng = { value: Number(d[0].value), label: d[0].value_classification, week: d[7] ? Number(d[7].value) : null };
  } catch (err) { console.warn(`Peur et avidité : ${err.message}`); }
  for (const c of ['BTC', 'ETH']) {
    try {
      const r = await fetchJson(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${c}&start_timestamp=${now - 10 * 86_400_000}&end_timestamp=${now}&resolution=1D`, { retries: 1 });
      const pts = (r.result?.data ?? []).map(x => [x[0], x[4]]).sort((a, b) => a[0] - b[0]);
      if (pts.length) (out.dvol ??= {})[c] = { value: pts.at(-1)[1], week: pts.length >= 8 ? pts.at(-8)[1] : null };
    } catch (err) { console.warn(`DVOL ${c} : ${err.message}`); }
  }
  return out;
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
  const fetched = await mapLimit(universe, 3, async asset => {
    const instId = `${asset.symbol}-USDT-SWAP`;
    try {
      const h1 = await candles(instId, '1H', 90);      // ~13 mois : 1 an de signaux + le temps de chauffe
      const bars = await candles(instId, '4H', 20);    // ~13 mois : indicateurs, fiche paire, tendance du court terme
      const daily = await candles(instId, '1Dutc', 3); // ~20 mois : de quoi calculer la tendance et suivre les trades
      return { asset, instId, h1, bars, daily };
    } catch (err) {
      failed++;
      console.warn(`⚠ ${asset.symbol} : ${err.message}`);
      return null;
    }
  });
  const prevText = args.previous ? await readFile(args.previous, 'utf8').catch(() => null) : null;
  const prevRaw = prevText ? (() => { try { return JSON.parse(prevText); } catch { return null; } })() : null;
  // Version en ligne récupérée mais abîmée : on s'arrête plutôt que de perdre le journal figé, le site garde l'ancienne version.
  // Version en ligne absente (site vide, première mise en ligne) : on continue, sinon l'onglet Setups resterait vide.
  if (process.env.PUBLISH === 'true' && !args.sample && prevText && !prevRaw && process.env.JOURNAL_RESET !== '1') {
    throw new Error('setups.json en ligne illisible : le journal des vrais signaux serait perdu. Version en ligne conservée.');
  }
  if (process.env.PUBLISH === 'true' && !args.sample && !prevText) console.warn('⚠ setups.json en ligne introuvable : le journal des vrais signaux repart de zéro.');
  const cryptoSyms = fetched.filter(x => x && x.asset.kind === 'crypto').map(x => x.asset.symbol);
  const gros = args.sample ? {} : await grosHistory(cryptoSyms, prevRaw?.gros, now).catch(err => { console.warn(`Gros traders : ${err.message}`); return prevRaw?.gros ?? {}; });
  // Contexte du marché (OKX, alternative.me, Deribit) : une donnée qui manque n'empêche pas le reste.
  const ctxBySym = new Map();
  if (!args.sample) {
    const list = fetched.filter(x => x && x.asset.kind === 'crypto');
    const ctxs = await mapLimit(list, 3, x => pairContext(x.asset.symbol).catch(() => ({})));
    list.forEach((x, k) => ctxBySym.set(x.asset.symbol, ctxs[k]));
  }
  const globalCtx = args.sample ? {} : await globalContext(now);
  // Tendance de chaque crypto jour par jour : sert à la note des signaux (BTC et « tout le marché dans le même sens »).
  const market = { ...marketOf(Object.fromEntries(fetched.filter(x => x && x.asset.kind === 'crypto').map(x => [x.asset.symbol, x.daily]))), gros };
  const results = fetched.map(x => {
    if (!x) return null;
    const { asset, instId, h1, bars, daily } = x;
    try {
      const signals = scanAsset(asset, { bars: h1, daily, market }, SWING);
      const court = scanAsset(asset, { bars: h1, daily: bars }, COURT);
      const tk = tick.get(instId);
      const last = tk ? Number(tk.last) : h1.at(-1).c;
      const c4 = dailyContext(bars.filter(b => b.closed !== false));
      const grosNow = asset.kind === 'crypto' ? grosAt(gros[asset.symbol], now) ?? grosAt(gros[asset.symbol], now - 86_400_000) : null;
      const rd = radar(h1, daily, SWING, asset.kind === 'crypto' ? market : null, grosNow);
      const liveSig = signals.find(s => s.outcome === 'open');
      const ctx = { ...(ctxBySym.get(asset.symbol) ?? {}), zones: volumeZones(h1, liveSig?.dir ?? rd?.dir ?? null), gros: grosNow };
      return {
        asset: {
          ...asset, instId, price: last,
          change24h: tk && Number(tk.open24h) ? last / Number(tk.open24h) - 1 : null,
          trend: trend1d(daily, now),
          radar: rd, ctx,
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
  previous = prevRaw;
  // Changement d'unité de temps (4h → 1h, novembre 2026) : l'ancien historique ne suit pas les mêmes règles, on repart de zéro.
  if (previous?.model !== SWING.key) previous = null;
  const compact = s => ({
    id: s.id, detector: s.detector, symbol: s.symbol, dir: s.dir, status: s.status, time: s.time, confirmedAt: s.confirmedAt,
    entry: s.entry, sl: s.sl, tp1: s.tp?.[0] ?? s.tp1, rr: s.rr, outcome: s.outcome, at: s.at, r: s.r, tpHit: s.tpHit ?? null,
    // Détail pour la fiche explicative du trade (absent des trades gardés d'anciennes versions).
    why: s.why, trend: s.trend, atr: s.atr, atr4h: s.atr4h, ref: s.ref, day: s.day, halfAt: s.halfAt ?? null, exitPx: s.exitPx ?? null, exitLvl: s.exitLvl ?? null,
    sz: s.sz ?? 1, score: s.score ?? null, gros: s.gros ?? null, grosCut: s.grosCut ?? null,
  });
  const history = mergeHistory(previous?.history, confirmed.map(compact), freshStart, now, UNIVERSE.map(a => a.symbol));
  const stats = detectorStats(history, now);
  // Journal figé : jamais remis à zéro, même quand les règles changent (contrairement à l'historique ci-dessus).
  const prices = Object.fromEntries(ok.map(r => [r.asset.symbol, r.asset.price]));
  const journal = updateJournal(prevRaw?.journal ?? null, all, prices, now, SWING.key);

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
  const rulesOf = cfg => ({ minRR: RULES.minRR, stopAtr: RULES.stopAtr, partialR: RULES.partialR, exitDays: cfg.exitDays ?? RULES.exitDays, barMs: cfg.E, trendMs: cfg.T, riskPct: RULES.riskPct, grosMax: RULES.grosMax, grosMode: RULES.grosMode, sizeMin: RULES.sizeMin, sizeMax: RULES.sizeMax, showHours: RULES.showHours, statsDays: RULES.statsDays });
  await writeFile(join(OUT, 'setups.json'), JSON.stringify({
    generatedAt: new Date(now).toISOString(), sample: Boolean(args.sample), sources, warnings, model: SWING.key,
    rules: { ...rulesOf(SWING), frozenSince: RULES_FROZEN.since, frozenUntil: RULES_FROZEN.until }, expect: EXPECT.swing,
    detectors: DETECTORS, freshStart, journal,
    assets: ok.map(r => r.asset), live: shown, stats, history, charts, context: { ...globalCtx, test: CONTEXT_TEST }, gros,
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

  console.log(`Journal des vrais signaux : ${journal.entries.length} depuis le ${new Date(journal.start).toISOString().slice(0, 10)}.`);
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
