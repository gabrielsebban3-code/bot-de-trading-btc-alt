// Fiche crypto : indicateurs (moyennes, RSI, MACD, ATR), paquets de bougies, force face à BTC, levier,
// lecture de la tendance, news liées et script des données avec les réponses fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atrOf, changeOver, coinSignals, emaOf, fundingYear, GROUPS, groupCandles, keyLevels, liquidation, macdOf, mentions,
  per8h, perfVsBtc, pickGroup, priceText, ratioToBtc, rsiOf, smaOf,
} from '../js/crypto-lib.js';
import { candlesFromOkx, cleanLink, excerpt, fundingHistory } from '../scripts/lib/cryptos.mjs';
import { realCoins } from '../js/marche-lib.js';

const D0 = 20_003; // un lundi (7 octobre 2024)
// Bougies quotidiennes : clôture f(i), ouverture à la clôture précédente, 1 % de mèche de chaque côté.
const days = (n, f, start = D0) => Array.from({ length: n }, (_, i) => {
  const c = f(i), o = i ? f(i - 1) : c;
  return [start + i, o, Math.max(o, c) * 1.01, Math.min(o, c) * 0.99, c, 1e6];
});

test('smaOf et emaOf : null tant que l\'historique est trop court', () => {
  assert.deepEqual(smaOf([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const e = emaOf([1, 2, 3, 4, 5], 3);
  assert.deepEqual(e.slice(0, 3), [null, null, 2]);
  assert.equal(e[3], 3); // 4 × 0,5 + 2 × 0,5
  assert.deepEqual(emaOf([1, 2], 3), [null, null]);
});

test('rsiOf : 100 en hausse continue, 0 en baisse continue, 50 sans mouvement', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsiOf(up).at(-1), 100);
  assert.equal(rsiOf(up)[13], null);
  assert.equal(rsiOf(up.map(v => 300 - v)).at(-1), 0);
  assert.equal(rsiOf(Array(20).fill(5)).at(-1), 50);
  const zigzag = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 1 : -1));
  assert.ok(Math.abs(rsiOf(zigzag).at(-1) - 50) < 5);
});

test('macdOf : histogramme positif quand la hausse accélère, valeurs alignées sur les bougies', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + (i > 50 ? (i - 50) ** 1.5 : 0));
  const m = macdOf(closes);
  assert.equal(m.line.length, 80);
  assert.equal(m.line[24], null);
  assert.ok(m.line[25] != null);
  assert.equal(m.signal[32], null);
  assert.ok(m.signal[33] != null);
  assert.ok(m.hist.at(-1) > 0);
});

test('atrOf : amplitude moyenne, écarts d\'ouverture compris', () => {
  const flat = Array.from({ length: 20 }, (_, i) => [i, 100, 101, 99, 100, 0]);
  assert.equal(atrOf(flat, 14)[14], 2);
  assert.equal(atrOf(flat, 14)[13], null);
  const gap = [...flat, [20, 110, 111, 109, 110, 0]]; // ouverture 10 au-dessus de la clôture précédente
  assert.ok(atrOf(gap, 14).at(-1) > 2);
});

test('groupCandles : semaines du lundi au dimanche, ouverture du lundi, clôture du dimanche', () => {
  const c = days(14, i => 100 + i); // du lundi D0 au dimanche D0 + 13
  const weeks = groupCandles(c, GROUPS.day[2][2]);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0][0], D0);
  assert.equal(weeks[0][1], c[0][1]);
  assert.equal(weeks[0][4], c[6][4]);
  assert.equal(weeks[0][2], Math.max(...c.slice(0, 7).map(x => x[2])));
  assert.equal(weeks[0][5], 7e6);
  assert.equal(weeks[0][6], 6); // indice de la dernière bougie d'origine
  assert.equal(weeks[1][6], 13);
  assert.equal(groupCandles(c, GROUPS.day[0][2]).length, 14);
});

test('pickGroup : bougies regroupées seulement si l\'écran est trop étroit', () => {
  assert.equal(pickGroup('day', 91, 900)[1], 'Bougies 1 jour');
  assert.equal(pickGroup('day', 365, 900)[1], 'Bougies 3 jours');
  assert.equal(pickGroup('day', 730, 260)[1], 'Bougies 1 semaine');
  assert.equal(pickGroup('hour', 180, 900)[1], 'Bougies 4 h');
  assert.equal(pickGroup('hour', 180, 260)[1], 'Bougies 12 h');
});

test('changeOver, ratioToBtc et perfVsBtc : la crypto face à BTC', () => {
  const coin = days(40, i => 10 * 1.01 ** i);
  const btc = days(40, i => 100 + i).map(c => [c[0], c[4]]);
  assert.ok(Math.abs(changeOver(coin.map(c => [c[0], c[4]]), 30) - (1.01 ** 30 - 1)) < 1e-9);
  assert.equal(changeOver([[1, 5]], 30), null);
  const ratio = ratioToBtc(coin, btc.slice(5)); // BTC manque les 5 premiers jours
  assert.equal(ratio.length, 35);
  assert.equal(ratio[0][0], D0 + 5);
  assert.ok(Math.abs(ratio[0][1] - (10 * 1.01 ** 5) / 105) < 1e-12);
  const perf = perfVsBtc(coin, btc, [7, 30, 90]);
  assert.equal(perf[2].coin, null);
  assert.ok(perf[1].coin > perf[1].btc);
});

test('keyLevels : zone des 20 jours sans la bougie du jour, plus haut sur un an, amplitude en %', () => {
  const c = days(30, i => 100 + i);
  const lv = keyLevels(c);
  assert.equal(lv.hi20, c[28][2]);
  assert.equal(lv.lo20, c[9][3]);
  assert.equal(lv.hi1y, c[29][2]);
  assert.ok(lv.atrPct > 0.02 && lv.atrPct < 0.04);
});

test('liquidation et funding : repères du levier', () => {
  const q = liquidation(100, 10);
  assert.ok(Math.abs(q.long - 90.5) < 1e-9);
  assert.ok(Math.abs(q.short - 109.5) < 1e-9);
  assert.equal(liquidation(100, 500).move, 0); // levier extrême : liquidé au moindre mouvement
  assert.equal(per8h(0.005, 4), 0.01);
  assert.equal(per8h(0.01, 8), 0.01);
  assert.ok(Math.abs(fundingYear(0.01) - 10.95) < 1e-9);
});

test('mentions : news liée par l\'impact, le nom ou le symbole en majuscules', () => {
  const n = (title, impacts = []) => ({ title, titleEn: '', impacts });
  assert.ok(mentions(n('Les ETF achètent', [['SOL', 1]]), 'SOL', 'Solana'));
  assert.ok(mentions(n('Solana : un nouveau record de transactions'), 'SOL', 'Solana'));
  assert.ok(mentions(n('Les baleines achètent du $SOL'), 'SOL', 'Solana'));
  assert.ok(!mentions(n('Le sol tremble au Japon'), 'SOL', 'Solana'));
  assert.ok(!mentions(n('Une avalanche de liquidations'), 'AVAX', 'Avalanche'));
  assert.ok(!mentions(n('TRUMP annonce des droits de douane'), 'TRUMP', 'Official Trump'));
  assert.ok(mentions(n('Ripple : la SEC abandonne, XRP bondit'), 'XRP', 'XRP'));
  assert.ok(!mentions(n('Ethereum Classic'), 'BTC', 'Bitcoin'));
});

test('priceText : lisible du bitcoin aux cryptos à quelques millionièmes de dollar', () => {
  assert.equal(priceText(84000).replace(/\s/g, ' '), '84 000');
  assert.equal(priceText(1.5), '1,50');
  assert.equal(priceText(0.0912), '0,09120');
  assert.equal(priceText(0.00001234), '0,00001234');
  assert.equal(priceText(null), '—');
});

test('coinSignals : tendance haussière, cassure, MACD 4 h et force face à BTC', () => {
  const d1 = days(260, i => 100 + i + (i === 259 ? 20 : 0)); // la dernière bougie sort de la zone du mois
  const h4 = days(60, i => 100 * 1.02 ** i).map(c => [c[0] * 6, ...c.slice(1)]);
  const ratio = d1.map(c => [c[0], 0.001 * (1 + (c[0] - D0) * 0.01)]);
  const r = coinSignals({ symbol: 'XRP', d1, h4, ratio, funding: [[1, 0.05], [2, 0.05], [3, 0.05]] });
  const dir = Object.fromEntries(r.signals.map(s => [s.key, s.dir]));
  assert.deepEqual(dir, { trend: 1, short: 1, range: 1, rsi: 0, macd: 1, btc: 1, funding: -1 });
  assert.match(r.signals.find(s => s.key === 'rsi').text, /surachat/);
  assert.match(r.signals.find(s => s.key === 'range').text, /cassure par le haut/);
  assert.equal(r.verdict.label, 'Plutôt haussier');
  // BTC n'est pas comparé à lui-même ; sans perpétuel, pas de signal de levier.
  const b = coinSignals({ symbol: 'BTC', d1, ratio });
  assert.ok(!b.signals.some(s => s.key === 'btc' || s.key === 'funding'));
  // Historique trop court : pas de tendance de fond, pas de verdict.
  assert.deepEqual(coinSignals({ symbol: 'NEW', d1: days(5, i => 1 + i) }).signals, []);
});

test('coinSignals : tendance baissière sous la zone du mois', () => {
  const d1 = days(260, i => 400 - i - (i === 259 ? 20 : 0));
  const r = coinSignals({ symbol: 'SOL', d1 });
  const dir = Object.fromEntries(r.signals.map(s => [s.key, s.dir]));
  assert.equal(dir.trend, -1);
  assert.equal(dir.short, -1);
  assert.equal(dir.range, -1);
  assert.equal(r.verdict.label, 'Plutôt baissier');
  assert.doesNotMatch(r.signals[0].text, /-\d/);
});

test('candlesFromOkx : du plus ancien au plus récent, sans doublon ni bougie vide, volume en dollars', () => {
  const row = (t, c, q = '0') => [String(t * 86_400_000), String(c), String(c * 1.01), String(c * 0.99), String(c), '5', '6', String(c * 10), q];
  const out = candlesFromOkx([row(D0 + 2, 12), row(D0 + 1, 11), row(D0 + 1, 11), ['0', '0', '0', '0', '0', '0', '0', '0', '1'], row(D0, 10)], 86_400_000);
  assert.deepEqual(out.map(c => c[0]), [D0, D0 + 1, D0 + 2]);
  assert.deepEqual(out[2], [D0 + 2, 12, 12.12, 11.88, 12, 120]);
});

test('fundingHistory : taux toutes les 4 h ramenés à 8 h, moyenne par jour', () => {
  const t = D0 * 86_400_000;
  const rows = [3, 2, 1, 0].map(k => ({ fundingTime: String(t + k * 4 * 3_600_000), realizedRate: '0.00005' })); // plus récent d'abord
  assert.deepEqual(fundingHistory(rows, 4), [[D0, 0.01]]);
  const eight = [1, 0].map(k => ({ fundingTime: String(t + k * 8 * 3_600_000), fundingRate: '0.0001' }));
  assert.deepEqual(fundingHistory(eight, 8), [[D0, 0.01]]);
});

test('excerpt : texte brut, trois phrases au plus', () => {
  assert.equal(excerpt('<p>Le <a href="x">Bitcoin</a> est né en 2009.</p><p>Offre limitée. Réserve de valeur. Quatrième phrase.</p>'),
    'Le Bitcoin est né en 2009. Offre limitée. Réserve de valeur.');
  assert.equal(excerpt(''), null);
  assert.ok(excerpt('Mot '.repeat(200)).length <= 480);
  // Titre en tête des textes CoinGecko et caractères codés
  assert.equal(excerpt('<p>Qu&#39;est-ce que le Bitcoin ? (BTC) Le Bitcoin est né en 2009.</p>'), 'Le Bitcoin est né en 2009.');
  assert.equal(excerpt('What is Chainlink (LINK)? Chainlink connects smart contracts to real-world data.'), 'Chainlink connects smart contracts to real-world data.');
  assert.equal(excerpt('Le &quot;BNB&quot; paie les frais &amp; plus encore.'), 'Le "BNB" paie les frais & plus encore.');
});

test('cleanLink : sans parrainage ni suivi', () => {
  assert.equal(cleanLink('https://www.binance.com?ref=37754157'), 'https://www.binance.com/');
  assert.equal(cleanLink('https://site.org/a?utm_source=cg&id=3'), 'https://site.org/a?id=3');
  assert.equal(cleanLink('https://bitcoin.org/bitcoin.pdf'), 'https://bitcoin.org/bitcoin.pdf');
  assert.equal(cleanLink('javascript:alert(1)'), null);
  assert.equal(cleanLink(''), null);
});

test('realCoins : retire aussi les actifs du monde réel mis sur la blockchain', () => {
  const list = [['BTC', 'Bitcoin'], ['FIGR_HELOC', 'Figure Heloc'], ['OUSG', 'OUSG Tokenized Treasury'], ['XRP', 'XRP']].map(([symbol, name]) => ({ symbol, name }));
  assert.deepEqual(realCoins(list).map(c => c.symbol), ['BTC', 'XRP']);
});

test('script des fiches : bougies OKX, perpétuel seul, crypto absente d\'OKX, traduction, présentation gardée 3 jours', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dinexo-crypto-'));
  const top = [['bitcoin', 'BTC', 'Bitcoin'], ['ethereum', 'ETH', 'Ethereum'], ['ripple', 'XRP', 'XRP'], ['dogecoin', 'DOGE', 'Dogecoin'], ['leo-token', 'LEO', 'LEO Token']]
    .map(([id, symbol, name]) => ({ id, symbol, name }));
  await writeFile(join(dir, 'marche.json'), JSON.stringify({ top }));
  const run = (...extra) => promisify(execFile)(process.execPath, ['--import', './tests/mock-fetch.mjs', 'scripts/build-cryptos.mjs', '--out', dir, '--marche', `${join(dir, 'absent.json')},${join(dir, 'marche.json')}`, ...extra], { env: { ...process.env, PUBLISH: 'false' } });
  const first = await run();
  const read = async id => JSON.parse(await readFile(join(dir, 'crypto', `${id}.json`), 'utf8'));

  const btc = await read('bitcoin');
  assert.equal(btc.okx.spot, 'BTC-USDT');
  assert.equal(btc.okx.swap, 'BTC-USDT-SWAP');
  assert.equal(btc.okx.maxLever, 100);
  assert.equal(btc.candles.line, false);
  assert.equal(btc.candles.d1.length, 1000);
  assert.equal(btc.candles.h4.length, 300);
  assert.ok(btc.candles.d1.every((c, i) => !i || c[0] === btc.candles.d1[i - 1][0] + 1));
  assert.equal(btc.market.rank, 1);
  assert.equal(btc.funding.rate, 0.01);
  assert.ok(btc.funding.history.length > 30);
  assert.ok(btc.oi.length > 30 && btc.longShort.length > 30);
  assert.deepEqual(btc.oi.at(-1), [Math.floor(Date.now() / 86_400_000), 8.4e9]); // jour en cours : valeur horaire
  assert.match(btc.about.text, /^Le Bitcoin est la première cryptomonnaie/);
  assert.deepEqual(btc.about.categories, ['Cryptocurrency', 'Layer 1 (L1)', 'Proof of Work (PoW)', 'Smart Contract Platform']);
  assert.equal(btc.about.links.explorer, 'https://explorer.bitcoin.org');
  assert.equal((await read('ethereum')).about.text, 'FR Ethereum is a decentralized platform for smart contracts. Ether is its native currency.');

  const xrp = await read('ripple');
  assert.deepEqual(xrp.funding.history.at(-1)[1], 0.01); // payé toutes les 4 h, ramené à 8 h
  assert.equal(xrp.about.links.reddit, null); // lien Reddit sans sous-forum

  const doge = await read('dogecoin');
  assert.equal(doge.okx.spot, null);
  assert.equal(doge.okx.candles, 'DOGE-USDT-SWAP');
  assert.ok(doge.candles.d1.length > 500 && doge.candles.h4.length === 300);

  // Google refuse : MyMemory traduit, et Google est laissé de côté pour la suite du passage.
  assert.equal(doge.about.text, "MM Dogecoin is a cryptocurrency.");
  assert.equal(doge.about.lang, 'fr');

  const leo = await read('leo-token');
  assert.equal(leo.candles.line, true);
  assert.equal(leo.okx.swap, null);
  assert.equal(leo.funding, null);
  assert.ok(leo.candles.d1.length >= 365); // un an d'historique CoinGecko
  assert.deepEqual(leo.sources, { bougies: 'coingecko', presentation: 'ok' });
  assert.deepEqual([leo.about.text, leo.about.lang], ['LEO Token is a cryptocurrency.', 'en']); // aucune traduction possible

  // Journal : une ligne par fiche, et les fiches compressées pour les aperçus hors branche principale.
  assert.match(first.stdout, /BTC \(bitcoin\) : 1000 j \+ 300 × 4 h · BTC-USDT · levier max 100×/);
  assert.match(first.stdout, /CRYPTO_GZ leo-token 1\/\d+ /);

  // Deuxième passage avec les fiches déjà en ligne : présentation reprise, le reste à jour.
  const second = await run('--previous', join(dir, 'crypto'));
  assert.equal((await read('bitcoin')).sources.presentation, undefined);
  assert.match(second.stdout, /présentation fr \(reprise\)/);
  // La présentation restée en anglais est traduite au passage suivant, sans redemander CoinGecko.
  assert.deepEqual((await read('leo-token')).about.text, 'FR LEO Token is a cryptocurrency.');
  assert.match(second.stdout, /LEO \(leo-token\).*présentation fr \(traduite\)/);

  // Plus de temps : les fiches déjà en ligne sont gardées telles quelles.
  const before = await read('ripple');
  await assert.rejects(run('--previous', join(dir, 'crypto'), '--budget', '0'), /Aucune fiche à jour/);
  assert.deepEqual(await read('ripple'), before);
});
