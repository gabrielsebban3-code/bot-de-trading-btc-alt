#!/usr/bin/env node
// Prix journaliers en euros des principales cryptos, pour le calculateur d'impôts (onglet Impôts) :
// valeur du portefeuille le jour de chaque vente, achats du mode DCA, valeur d'aujourd'hui.
// Clôtures OKX (paires USDT au comptant) converties en euros avec le cours de la BCE (frankfurter).
// Usage : node scripts/build-prix.mjs [--out data] [--previous ancien-dossier-prix] [--marche data/marche.json,ancien/marche.json]
// Le premier passage remonte jusqu'en 2018 ; les suivants ne demandent que les derniers jours et complètent l'existant.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fetchJson, mapLimit } from './lib/http.mjs';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true]] : [])));
const OUT = join(args.out || 'data', 'prix');
const OKX = 'https://www.okx.com/api/v5';
const DAY = 86_400_000;
const FROM = Date.UTC(2018, 0, 1);
const STABLES = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDP', 'PYUSD', 'USDE']);
// Les cryptos les plus détenues par des particuliers, plus celles du tableau de l'onglet Marché.
const BASE = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH', 'TON', 'SHIB', 'NEAR',
  'UNI', 'APT', 'SUI', 'PEPE', 'ATOM', 'ARB', 'OP', 'INJ', 'HBAR', 'XLM', 'ETC', 'FIL', 'AAVE', 'RENDER', 'POL', 'ICP', 'TAO', 'WIF'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FAST = process.env.DINEXO_FAST === '1';
let next = 0;
async function okx(path) {
  const wait = Math.max(0, next - Date.now());
  next = Math.max(Date.now(), next) + (FAST ? 0 : 130); // OKX : 20 demandes par 2 secondes au plus
  if (wait) await sleep(wait);
  const r = await fetchJson(`${OKX}${path}`, { retries: 2 });
  if (r.code !== '0') throw new Error(`OKX ${path} : ${r.msg || r.code}`);
  return r.data;
}

const sig = x => Number(x.toPrecision(6));
const dayOf = t => Math.floor(t / DAY) * DAY;

// Série continue (un prix par jour, le précédent recopié les jours sans donnée) à partir de paires [jour, valeur].
export function continuous(pairs) {
  const sorted = [...pairs].filter(([t, v]) => Number.isFinite(t) && v > 0).sort((a, b) => a[0] - b[0]);
  if (!sorted.length) return null;
  const start = dayOf(sorted[0][0]);
  const end = dayOf(sorted.at(-1)[0]);
  const map = new Map(sorted.map(([t, v]) => [dayOf(t), v]));
  const out = [];
  let last = sorted[0][1];
  for (let t = start; t <= end; t += DAY) { if (map.has(t)) last = map.get(t); out.push(last); }
  return { start, values: out };
}

const toPairs = s => (s ? s.values.map((v, k) => [s.start + k * DAY, v]) : []);

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

// Cours du dollar en euros, jour par jour (BCE, jours ouvrés ; les week-ends reprennent le vendredi).
async function usdEur(previous) {
  const since = previous ? new Date(previous.start + (previous.rates.length - 40) * DAY) : new Date(FROM);
  const from = since.toISOString().slice(0, 10);
  let data = null;
  for (const host of ['https://api.frankfurter.dev/v1', 'https://api.frankfurter.app']) {
    try { data = await fetchJson(`${host}/${from}..?base=USD&symbols=EUR`, { retries: 2 }); break; } catch (err) { console.warn(`⚠ ${host} : ${err.message}`); }
  }
  if (!data?.rates) {
    if (previous) return previous;
    throw new Error('cours euro / dollar indisponible');
  }
  const fresh = Object.entries(data.rates).map(([d, r]) => [Date.parse(`${d}T00:00:00Z`), r.EUR]);
  const old = previous ? toPairs({ start: previous.start, values: previous.rates }) : [];
  const keep = old.filter(([t]) => t < Math.min(...fresh.map(([t2]) => t2)));
  const s = continuous([...keep, ...fresh]);
  // Jusqu'à aujourd'hui : le dernier cours connu vaut pour les jours qui suivent.
  const today = dayOf(Date.now());
  while (s.start + s.values.length * DAY <= today) s.values.push(s.values.at(-1));
  return { start: s.start, rates: s.values.map(sig) };
}

// Clôtures journalières en dollars d'une paire OKX au comptant, depuis `since`.
async function closes(instId, since) {
  const rows = await okx(`/market/candles?instId=${instId}&bar=1Dutc&limit=300`);
  while (rows.length && Number(rows.at(-1)[0]) > since) {
    const older = await okx(`/market/history-candles?instId=${instId}&bar=1Dutc&limit=100&after=${rows.at(-1)[0]}`);
    if (!older.length) break;
    rows.push(...older);
  }
  return rows.map(r => [Number(r[0]), Number(r[4])]).filter(([t]) => t >= since);
}

async function main() {
  console.log(`Dinexo · prix en euros pour le calculateur d'impôts · ${new Date().toISOString()}`);
  const prevDir = args.previous;
  const prevIndex = prevDir ? await readJson(join(prevDir, 'index.json')) : null;
  const eur = await usdEur(prevIndex?.usdEur);
  const rateAt = t => eur.rates[Math.max(0, Math.min(eur.rates.length - 1, Math.floor((dayOf(t) - eur.start) / DAY)))];

  let marche = null; // premier fichier lisible de la liste
  for (const path of String(args.marche || '').split(',').filter(Boolean)) if (!marche) marche = await readJson(path);
  const names = new Map((marche?.top || []).map(c => [String(c.symbol).toUpperCase(), c.name]));
  const wanted = [...new Set([...BASE, ...names.keys()])].filter(s => !STABLES.has(s));
  const instruments = await okx('/public/instruments?instType=SPOT');
  const listed = new Set(instruments.filter(i => i.state === 'live' && i.quoteCcy === 'USDT').map(i => i.baseCcy));
  const universe = wanted.filter(s => listed.has(s));
  console.log(`${universe.length} cryptos : ${universe.join(' ')}`);

  await mkdir(OUT, { recursive: true });
  let failed = 0;
  const coins = (await mapLimit(universe, 3, async symbol => {
    const prev = prevDir ? await readJson(join(prevDir, `${symbol}.json`)) : null;
    try {
      // Avec un fichier précédent : seulement les 300 derniers jours, qui remplacent l'ancienne fin.
      const since = prev ? prev.start + (prev.closes.length - 300) * DAY : FROM;
      const usd = await closes(`${symbol}-USDT`, since);
      const fresh = usd.map(([t, c]) => [t, sig(c * rateAt(t))]);
      const freshStart = fresh.length ? Math.min(...fresh.map(([t]) => t)) : Infinity;
      const old = prev ? toPairs({ start: prev.start, values: prev.closes }).filter(([t]) => t < freshStart) : [];
      const s = continuous([...old, ...fresh]);
      if (!s) throw new Error('aucune clôture');
      const file = { symbol, start: s.start, closes: s.values };
      await writeFile(join(OUT, `${symbol}.json`), JSON.stringify(file));
      return { symbol, name: names.get(symbol) || symbol, start: s.start, last: s.values.at(-1), days: s.values.length };
    } catch (err) {
      failed++;
      console.warn(`⚠ ${symbol} : ${err.message}`);
      if (prev) {
        await writeFile(join(OUT, `${symbol}.json`), JSON.stringify(prev));
        return { symbol, name: names.get(symbol) || symbol, start: prev.start, last: prev.closes.at(-1), days: prev.closes.length };
      }
      return null;
    }
  })).filter(Boolean);
  if (coins.length < universe.length / 2) throw new Error(`seulement ${coins.length} cryptos sur ${universe.length}`);

  const index = { generatedAt: new Date().toISOString(), coins, stables: [...STABLES], usdEur: eur };
  await writeFile(join(OUT, 'index.json'), JSON.stringify(index));
  console.log(`${coins.length} fichiers de prix écrits${failed ? `, ${failed} en échec` : ''}. Euro : ${eur.rates.at(-1)} € pour 1 $.`);
  for (const c of coins.slice(0, 6)) console.log(`${c.symbol} depuis le ${new Date(c.start).toISOString().slice(0, 10)} : ${c.last} € (${c.days} jours)`);

  // Sur une branche de test : les fichiers compressés en fin de journal, pour construire la bêta.
  if (process.env.PUBLISH === 'false') {
    const lines = [];
    for (const name of ['index', ...coins.map(c => c.symbol)]) {
      const text = await readFile(join(OUT, `${name}.json`), 'utf8').catch(() => null);
      if (!text) continue;
      const gz = gzipSync(text).toString('base64');
      const n = Math.ceil(gz.length / 8000);
      for (let i = 0; i < n; i++) lines.push(`PRIX_GZ ${name} ${i + 1}/${n} ${gz.slice(i * 8000, (i + 1) * 8000)}`);
    }
    await writeFile('prix-gz.txt', `${lines.join('\n')}\n`);
  }
}

if (process.argv[1]?.endsWith('build-prix.mjs')) {
  main().catch(err => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  });
}
