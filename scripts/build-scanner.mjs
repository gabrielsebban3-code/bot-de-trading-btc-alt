#!/usr/bin/env node
// Scanner Dinexo (onglet Scanner, Premium) : la méthode des Setups appliquée aux cryptos les plus échangées sur OKX.
// Pour chaque perpétuel USDT : tendance journalière, prix qui déclencherait le prochain signal, signaux des 3 derniers jours
// et trade encore en jeu. Seules BTC, ETH et SOL ont été testées sur 3 ans : pour les autres, c'est une piste à vérifier.
// Usage : node scripts/build-scanner.mjs [--out data] [--marche data/marche.json,ancien/marche.json] [--top 80]
// Lancé toutes les heures par GitHub Actions (.github/workflows/deploy.yml).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fetchJson, mapLimit } from './lib/http.mjs';
import { BAR, DETECTORS, RULES, radar, scanAsset } from './lib/setups.mjs';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true]] : [])));
const OUT = args.out || 'data';
const TOP = Number(args.top) || 80;
const OKX = 'https://www.okx.com/api/v5';
const DAY = 86_400_000;
export const RECENT_DAYS = 3; // un signal reste dans « Signaux récents » 3 jours
// Paires suivies par l'onglet Setups (méthode testée sur 3 ans) et marchés qui ne sont pas des cryptos.
const TESTED = new Set(['BTC', 'ETH', 'SOL']);
const SKIP = new Set(['USDC', 'USDT', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'PYUSD', 'BZ', 'CL', 'NG', 'XAU', 'XAG', 'XPT', 'PAXG', 'XAUT']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FAST = process.env.DINEXO_FAST === '1';

let next = 0;
async function okx(path) {
  const wait = Math.max(0, next - Date.now());
  next = Math.max(Date.now(), next) + (FAST ? 0 : 120); // OKX : 20 demandes par 2 secondes au plus
  if (wait) await sleep(wait);
  const r = await fetchJson(`${OKX}${path}`, { retries: 2 });
  if (r.code !== '0') throw new Error(`OKX ${path} : ${r.msg || r.code}`);
  return r.data;
}

const toBar = row => ({ t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[7]), closed: row[8] === '1' });
const candles = async (instId, bar) => (await okx(`/market/candles?instId=${instId}&bar=${bar}&limit=300`)).map(toBar).sort((a, b) => a.t - b.t);
const sig = x => (Number.isFinite(x) ? Number(x.toPrecision(6)) : null);

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

// Les perpétuels USDT de cryptos les plus échangés sur 24 h (en dollars).
export function pickUniverse(instruments, tickers, top = TOP) {
  const live = new Set(instruments
    .filter(i => i.state === 'live' && i.settleCcy === 'USDT' && (i.instCategory == null || i.instCategory === '1'))
    .map(i => i.instId));
  return tickers
    .filter(t => live.has(t.instId) && /^[A-Z0-9]+-USDT-SWAP$/.test(t.instId))
    .map(t => ({ symbol: t.instId.replace('-USDT-SWAP', ''), instId: t.instId, last: Number(t.last), open24h: Number(t.open24h), volume: Number(t.volCcy24h) * Number(t.last) }))
    .filter(t => !SKIP.has(t.symbol) && t.last > 0 && Number.isFinite(t.volume))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, top);
}

// Résumé d'une crypto : tendance, prochain déclenchement, dernier signal (3 jours) ou trade encore en jeu.
export function coinView(t, bars, daily, now = Date.now()) {
  const r = radar(bars, daily);
  const signals = scanAsset({ symbol: t.symbol }, { bars, daily }).filter(s => s.status === 'confirmé');
  const last = signals.at(-1);
  const keep = last && (last.outcome === 'open' || last.confirmedAt >= now - RECENT_DAYS * DAY) ? last : null;
  return {
    symbol: t.symbol,
    price: sig(t.last),
    change24h: t.open24h ? sig(t.last / t.open24h - 1) : null,
    volume: Math.round(t.volume),
    tested: TESTED.has(t.symbol),
    trend: r?.trend ?? null,
    dir: r?.dir ?? null,
    trigger: r?.trigger ? { key: r.trigger.key, price: sig(r.trigger.price), distance: sig(r.trigger.distance), stop: sig(r.trigger.stop) } : null,
    macdReady: Boolean(r?.macdReady),
    signal: keep && {
      detector: keep.detector, dir: keep.dir, time: keep.time, confirmedAt: keep.confirmedAt,
      entry: sig(keep.entry), sl: sig(keep.sl), tp1: sig(keep.tp[0]), stop: sig(keep.stop ?? keep.sl),
      outcome: keep.outcome, at: keep.at, r: keep.r, tpHit: keep.tpHit ?? 0,
    },
  };
}

async function main() {
  const now = Date.now();
  console.log(`Dinexo · scanner sur les ${TOP} cryptos les plus échangées · ${new Date(now).toISOString()}`);
  const [instruments, tickers] = await Promise.all([okx('/public/instruments?instType=SWAP'), okx('/market/tickers?instType=SWAP')]);
  const universe = pickUniverse(instruments, tickers);
  console.log(`${universe.length} cryptos : ${universe.map(t => t.symbol).join(' ')}`);

  let marche = null; // noms des cryptos : premier fichier lisible de la liste
  for (const path of String(args.marche || '').split(',').filter(Boolean)) if (!marche) marche = await readJson(path);
  const names = new Map((marche?.top || []).map(c => [String(c.symbol).toUpperCase(), c.name]));

  let failed = 0;
  const coins = (await mapLimit(universe, 4, async t => {
    try {
      const bars = await candles(t.instId, '4H');      // 50 jours
      const daily = await candles(t.instId, '1Dutc');  // 300 jours : tendance journalière
      if (bars.length < RULES.rangeBars + 40 || daily.length < 60) return null; // trop récente
      return { ...coinView(t, bars, daily, now), name: names.get(t.symbol) || null };
    } catch (err) {
      failed++;
      console.warn(`⚠ ${t.symbol} : ${err.message}`);
      return null;
    }
  })).filter(Boolean);
  if (coins.length < universe.length / 2) throw new Error(`seulement ${coins.length} cryptos analysées sur ${universe.length}`);

  const out = {
    generatedAt: new Date(now).toISOString(), sample: Boolean(args.sample),
    rules: { barMs: BAR, recentDays: RECENT_DAYS, stopAtr: RULES.stopAtr, partialR: RULES.partialR, riskPct: RULES.riskPct },
    detectors: DETECTORS, tested: [...TESTED], coins,
  };
  await mkdir(OUT, { recursive: true });
  const text = JSON.stringify(out);
  await writeFile(join(OUT, 'scanner.json'), text);

  const count = k => coins.filter(c => c.trend === k).length;
  const recent = coins.filter(c => c.signal);
  console.log(`${coins.length} cryptos analysées${failed ? `, ${failed} en échec` : ''} · haussières ${count('haussière')} · baissières ${count('baissière')} · neutres ${count('neutre')}`);
  for (const c of recent) console.log(`Signal ${c.symbol} ${c.signal.dir} ${DETECTORS[c.signal.detector]} ${new Date(c.signal.time).toISOString().slice(0, 13)} · ${c.signal.outcome}`);
  const near = coins.filter(c => c.trigger && Math.abs(c.trigger.distance) < 0.03).sort((a, b) => Math.abs(a.trigger.distance) - Math.abs(b.trigger.distance));
  for (const c of near.slice(0, 10)) console.log(`Proche ${c.symbol} ${c.dir} à ${(c.trigger.distance * 100).toFixed(2)} % (${c.trigger.price})`);

  // Sur une branche de test : le fichier compressé en fin de journal, pour construire la bêta.
  if (process.env.PUBLISH === 'false') {
    const gz = gzipSync(text).toString('base64');
    const n = Math.ceil(gz.length / 8000);
    const lines = Array.from({ length: n }, (_, i) => `SCANNER_GZ scanner ${i + 1}/${n} ${gz.slice(i * 8000, (i + 1) * 8000)}`);
    await writeFile('scanner-gz.txt', `${lines.join('\n')}\n`);
  }
}

if (process.argv[1]?.endsWith('build-scanner.mjs')) {
  main().catch(err => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  });
}
