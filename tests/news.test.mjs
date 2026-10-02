import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  NEWS, amountUsd, buildFeed, classify, cluster, headline, matchProject, parseFeed, parseTelegram, parseWhale, similar,
  splitSource, tidy, whaleNews,
} from '../scripts/lib/news.mjs';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 2, 12);
const sp = s => String(s).replace(/[\u202f\u00a0]/g, ' '); // séparateur de milliers français

test('parseFeed lit le RSS (CDATA, entités, source Google News) et l\'Atom', () => {
  const rss = `<rss><channel><title>Flux</title>
    <item><title><![CDATA[Fed cuts rates &amp; signals more - Reuters]]></title><link>https://news.google.com/rss/articles/abc?oc=5</link>
      <pubDate>Thu, 01 Oct 2026 18:00:00 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item>
    <item><title>Oil &#8216;jumps&#8217; 5%</title><guid>https://example.com/oil</guid><pubDate>pas une date</pubDate></item>
  </channel></rss>`;
  const items = parseFeed(rss);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { title: 'Fed cuts rates & signals more - Reuters', link: 'https://news.google.com/rss/articles/abc?oc=5', time: Date.UTC(2026, 9, 1, 18), source: 'Reuters' });
  assert.equal(items[1].title, 'Oil ‘jumps’ 5%');
  assert.equal(items[1].link, 'https://example.com/oil');
  assert.equal(items[1].time, null);
  const atom = '<feed><entry><title type="html">ECB holds rates</title><link rel="alternate" href="https://ecb.example/pr"/><updated>2026-10-01T12:45:00Z</updated></entry></feed>';
  assert.deepEqual(parseFeed(atom), [{ title: 'ECB holds rates', link: 'https://ecb.example/pr', time: Date.UTC(2026, 9, 1, 12, 45), source: null }]);
});

test('parseTelegram lit la page publique d\'un canal', () => {
  const html = `<div class="tgme_widget_message" data-post="WatcherGuru/42"><div class="tgme_widget_message_text js-message_text" dir="auto">JUST IN: <b>Fed</b> cuts rates.<br/>More soon</div>
    <a class="tgme_widget_message_date" href="https://t.me/WatcherGuru/42"><time datetime="2026-10-02T09:15:00+00:00" class="time">09:15</time></a></div>
    <div class="tgme_widget_message" data-post="autre_canal/7"><div class="tgme_widget_message_text">pub</div></div>`;
  assert.deepEqual(parseTelegram(html, 'watcherguru'), [{ text: 'JUST IN: Fed cuts rates.\nMore soon', link: 'https://t.me/WatcherGuru/42', time: Date.UTC(2026, 9, 2, 9, 15) }]);
});

test('titres : source Google News, emojis, « BREAKING », titre de message Telegram', () => {
  assert.deepEqual(splitSource('Iran fires missiles at Israel, officials say - Associated Press', null), { title: 'Iran fires missiles at Israel, officials say', source: 'Associated Press' });
  assert.deepEqual(splitSource('A short one - X', 'Y'), { title: 'A short one - X', source: 'Y' });
  assert.equal(tidy('🚨 BREAKING: 🇺🇸 Fed cuts rates'), 'Fed cuts rates');
  assert.equal(tidy('JUST IN - Bitcoin ETF approved'), 'Bitcoin ETF approved');
  assert.equal(headline('🚨 JUST IN:\nSEC approves spot Solana ETFs.\nhttps://t.co/x'), 'SEC approves spot Solana ETFs');
  assert.equal(headline('Fed:\nRates unchanged at 4%'), 'Fed: Rates unchanged at 4%');
  assert.ok(headline('mot '.repeat(80)).length <= 201);
});

test('amountUsd trouve le plus gros montant en dollars', () => {
  assert.equal(amountUsd('Hackers drain $120 million from DeFi protocol'), 120e6);
  assert.equal(amountUsd('Bybit hacked for $1.5 billion'), 1.5e9);
  assert.equal(amountUsd('Exploit nets $3.2M after $500K bounty'), 3.2e6);
  assert.equal(amountUsd('ETFs record $1,234,567 in inflows'), 1234567);
  assert.equal(amountUsd('Fed cuts rates'), null);
});

// [titre, contexte, règle attendue, importance, impacts]
const CASES = [
  ['Fed cuts rates by a quarter point, signals two more cuts this year', {}, 'taux', 'medium', [['BTC', 1], ['Or', 1]]],
  ['Fed holds rates steady, Powell says no rush to cut', {}, 'taux', 'medium', []],
  ['Federal Reserve raises interest rates by 25 basis points', {}, 'taux', 'medium', [['BTC', -1]]],
  ['Fed unexpectedly cuts rates by half a point in emergency move', {}, 'taux-surprise', 'critical', [['BTC', 1], ['Or', 1]]],
  ['Fed officials signal patience on further rate cuts, minutes show', {}, 'taux', 'medium', []],
  ['Traders bet Fed will cut rates in December', {}, 'taux', 'low', []],
  ['Bank of Japan raises rates to highest since 2008', {}, 'taux', 'medium', []],
  ['Powell says Fed is in a good position to wait', {}, 'taux', 'low', []],
  ['US consumer prices rise more than expected in September', {}, 'inflation', 'medium', [['BTC', -1]]],
  ['US inflation cools to 2.6% in August, below forecasts', {}, 'inflation', 'medium', [['BTC', 1]]],
  ['US unemployment rate rises to 4.5%, highest since 2021', {}, 'inflation', 'medium', [['BTC', 1]]],
  ['US weekly jobless claims fall to 215,000', {}, 'inflation', 'medium', [['BTC', -1]]],
  ['UK inflation unexpectedly rises to 4.1%', {}, 'inflation', 'low', []],
  ['Iran launches missile attack on Israel', {}, 'guerre', 'critical', [['Pétrole', 1], ['Or', 1], ['BTC', -1]]],
  ['Israel strikes Iran nuclear sites', {}, 'guerre', 'critical', [['Pétrole', 1], ['Or', 1], ['BTC', -1]]],
  ['Iran threatens to close Strait of Hormuz', {}, 'guerre', 'medium', [['Pétrole', 1], ['Or', 1], ['BTC', -1]]],
  ['Iran closes Strait of Hormuz to shipping', {}, 'guerre', 'critical', [['Pétrole', 1], ['Or', 1], ['BTC', -1]]],
  ['China launches military drills around Taiwan', {}, 'tensions', 'medium', []],
  ['Russia launches massive drone attack on Kyiv', {}, 'conflit', 'low', []],
  ['Ukraine strikes Russian oil refinery with drones', {}, 'infra-petrole', 'medium', [['Pétrole', 1]]],
  ['Hackers attack Iranian crypto exchange Nobitex', {}, 'hack', 'low', []],
  ['US imposes new sanctions on Russian oil exports', {}, 'sanctions', 'medium', [['Pétrole', 1]]],
  ['EU agrees new sanctions package against Russia', {}, 'sanctions', 'low', []],
  ['Trump announces 25% tariffs on imports from Mexico and Canada', {}, 'droits-de-douane', 'medium', [['BTC', -1]]],
  ['US and China agree to extend trade truce by 90 days', {}, 'droits-de-douane', 'medium', [['BTC', 1]]],
  ['OPEC+ agrees to raise oil output by 411,000 bpd in November', {}, 'opep', 'critical', [['Pétrole', -1]]],
  ['OPEC+ extends production cuts to end of 2026', {}, 'opep', 'critical', [['Pétrole', 1]]],
  ['OPEC+ considers larger output hike, sources say', {}, 'opep', 'medium', [['Pétrole', -1]]],
  ['US crude stocks fall sharply, EIA says', {}, 'stocks-petrole', 'low', [['Pétrole', 1]]],
  ['Gold hits record high above $4,000', {}, 'energie', 'low', []],
  ['Hackers drain $120 million from DeFi protocol Balancer', { crypto: true }, 'hack', 'critical', [['DeFi', -1]]],
  ['Crypto exchange Bybit hacked for $1.5 billion in Ethereum', {}, 'hack', 'critical', [['ETH', -1]]],
  ['Crypto hacks top $2.5 billion in first half of 2026, report says', {}, 'hack', 'low', []],
  ['Bitcoin ETFs drain $1 billion in outflows', {}, 'etf', 'medium', [['BTC', -1]]],
  ['Bitcoin ETFs see $1.2 billion inflows, biggest day since July', {}, 'etf', 'medium', [['BTC', 1]]],
  ['SEC approves spot Solana ETFs', {}, 'etf', 'medium', [['SOL', 1]]],
  ['SEC sues crypto exchange for operating unregistered platform', {}, 'regulation', 'medium', [['Crypto', -1]]],
  ['Senate passes stablecoin bill in landmark vote', {}, 'regulation', 'medium', [['Crypto', 1]]],
  ['SEC drops case against Coinbase', {}, 'regulation', 'medium', [['Crypto', 1]]],
  ['Strategy buys another 10,000 bitcoin for $1.1 billion', {}, 'gros-detenteur', 'medium', [['BTC', 1]]],
  ['Bitcoin price analysis: bulls eye resistance', { crypto: true }, null],
  ['Teachers strikes in France', {}, null],
];

test('classify : thème, importance et impact probable sur des titres réels', () => {
  for (const [title, ctx, rule, importance, impacts] of CASES) {
    const hit = classify(title, ctx);
    if (rule === null) {
      assert.equal(hit, null, title);
      continue;
    }
    assert.equal(hit?.rule, rule, title);
    assert.equal(hit.importance, importance, title);
    assert.deepEqual(hit.impacts, impacts, title);
    assert.ok(hit.why.length > 20, title);
  }
});

test('classify : communiqués officiels et projets du top', () => {
  assert.equal(classify('ECB publishes supervisory banking statistics', { prefix: 'ECB', theme: 'cb', why: 'Communiqué BCE.' }).rule, 'source');
  const projects = [{ id: 'nebula-dex', name: 'Nebula DEX', symbol: 'NBL', rank: 1 }, { id: 'lighter', name: 'Lighter', symbol: 'LIT', rank: 2 }];
  const hit = classify('Nebula DEX launches v2 with fee buybacks', { projects });
  assert.deepEqual([hit.theme, hit.importance, hit.projectId], ['project', 'medium', 'nebula-dex']);
  assert.equal(matchProject('$NBL rallies 40%', projects).id, 'nebula-dex');
  assert.equal(matchProject('Lighter raises $50M', projects, true).id, 'lighter');
  assert.equal(matchProject('Lighter raises $50M', projects, false), null, 'un nom d\'un seul mot n\'est cherché que dans les médias crypto');
  assert.equal(matchProject('a lighter week for markets', projects, true), null);
});

test('baleines : dépôts, retraits, création de stablecoins, seuil de 10 M$', () => {
  const deposit = whaleNews(parseWhale('🚨 1,500 #BTC (150,123,456 USD) transferred from unknown wallet to #Coinbase'));
  assert.equal(sp(deposit.title), '1 500 BTC (150 M$) envoyés d\'un portefeuille inconnu vers Coinbase');
  assert.deepEqual([deposit.importance, deposit.impacts], ['medium', [['BTC', -1]]]);
  const mint = whaleNews(parseWhale('💵 250,000,000 #USDT (250,001,234 USD) minted at Tether Treasury'));
  assert.equal(sp(mint.title), '250 M USDT créés par Tether Treasury');
  assert.deepEqual(mint.impacts, [['Crypto', 1]]);
  const small = whaleNews(parseWhale('12,345 #ETH (45,678,901 USD) transferred from #Binance to unknown wallet'));
  assert.equal(small.importance, 'low');
  assert.deepEqual(small.impacts, [], 'pas de flèche sur un petit mouvement');
  assert.equal(whaleNews(parseWhale('120 #ETH (450,000 USD) transferred from unknown wallet to #Binance')), null);
  const top = whaleNews(parseWhale('9,000,000 #NBL (12,000,000 USD) transferred from unknown wallet to #Bybit'), [{ id: 'nebula-dex', symbol: 'NBL' }]);
  assert.deepEqual([top.importance, top.projectId, top.impacts], ['medium', 'nebula-dex', [['NBL', -1]]]);
});

const item = (id, titleEn, extra = {}) => ({ id, titleEn, title: null, time: NOW - HOUR, source: 'Reuters', link: `https://x/${id}`, rank: 2, kind: 'feed', importance: 'medium', theme: 'cb', impacts: [], why: '…', rule: 'taux', ...extra });

test('similar et cluster : une même info de plusieurs médias = une seule news', () => {
  const a = item('a', 'Fed holds interest rates steady as inflation stays sticky');
  const b = item('b', 'Federal Reserve holds interest rates steady, inflation sticky', { source: 'CNBC', time: NOW - 2 * HOUR });
  const c = item('c', 'ECB holds interest rates steady as inflation stays sticky', { source: 'Bloomberg' });
  assert.ok(similar(a, b));
  assert.ok(!similar(a, c), 'Fed et BCE ne se regroupent pas');
  const groups = cluster([a, b, c]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].ids, ['a', 'b']);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].time, NOW - 2 * HOUR, 'heure de la première source');
  const whales = cluster([item('w1', '1,000 BTC transferred to Binance', { kind: 'whale' }), item('w2', '1,000 BTC transferred to Binance', { kind: 'whale' })]);
  assert.equal(whales.length, 2, 'les baleines ne sont jamais regroupées');
});

test('une news critique d\'un seul petit média reste moyenne jusqu\'à confirmation', () => {
  const rumor = item('r', 'Iran launches missile attack on Israel', { rank: 1, source: 'Blog', importance: 'critical', theme: 'geo', rule: 'guerre' });
  const [alone] = cluster([rumor]);
  assert.deepEqual([alone.importance, alone.raw], ['medium', 'critical']);
  const [confirmed] = cluster([alone, item('s', 'Iran launches missile attack against Israel', { rank: 1, source: 'Autre média', importance: 'critical', theme: 'geo', rule: 'guerre' })]);
  assert.equal(confirmed.importance, 'critical');
  const [agency] = cluster([{ ...rumor, rank: 2 }]);
  assert.equal(agency.importance, 'critical', 'une agence suffit');
});

test('buildFeed : garde 72 h, ne rajoute pas une news déjà vue, limite les petites baleines', () => {
  const prev = [
    { ...item('old', 'Old story about OPEC output'), time: NOW - 80 * HOUR },
    { ...item('p1', 'Fed holds interest rates steady as inflation stays sticky'), ids: ['p1', 'p2'], title: 'La Fed maintient ses taux', lang: 'fr' },
  ];
  const fresh = [
    item('p2', 'Federal Reserve holds interest rates steady, inflation sticky'),
    item('n1', 'OPEC+ agrees to cut output by 500,000 bpd', { theme: 'energy', importance: 'critical', rule: 'opep' }),
    item('n1', 'OPEC+ agrees to cut output by 500,000 bpd', { theme: 'energy', importance: 'critical', rule: 'opep' }),
    ...Array.from({ length: NEWS.maxSmallWhales + 5 }, (_, k) => item(`w${k}`, `${k} BTC moved`, { kind: 'whale', theme: 'whale', importance: 'low', time: NOW - k * 60_000 })),
  ];
  const feed = buildFeed(prev, fresh, NOW);
  assert.ok(!feed.some(i => i.id === 'old'), 'plus de 72 h : retirée');
  const fed = feed.find(i => i.id === 'p1');
  assert.equal(fed.title, 'La Fed maintient ses taux', 'traduction gardée');
  assert.equal(fed.count, 1, 'p2 déjà regroupée : pas rajoutée');
  assert.equal(feed.filter(i => i.id === 'n1').length, 1);
  assert.equal(feed.filter(i => i.kind === 'whale').length, NEWS.maxSmallWhales);
  assert.ok(feed.every((x, k) => k === 0 || feed[k - 1].time >= x.time), 'plus récentes en premier');
});

test('build-news écrit news.json à partir des réponses fictives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dinexo-news-'));
  const now = Date.now();
  await writeFile(join(dir, 'prev.json'), JSON.stringify({
    items: [
      { id: 'vieux', ids: ['vieux'], time: now - 80 * HOUR, titleEn: 'Old news', title: 'Vieille news', lang: 'fr', importance: 'low', theme: 'geo', impacts: [], kind: 'feed', sources: [] },
      { id: 'garde', ids: ['garde'], time: now - 10 * HOUR, titleEn: 'Gold prices climb as dollar weakens', title: 'Le prix de l\'or grimpe', lang: 'fr', importance: 'low', theme: 'energy', impacts: [], kind: 'feed', rank: 1, source: 'Kitco', sources: [{ name: 'Kitco', link: 'https://k' }], count: 1, rule: 'energie', why: '…' },
    ],
  }));
  await promisify(execFile)('node', ['--import', './tests/mock-fetch.mjs', 'scripts/build-news.mjs', '--out', dir, '--previous', join(dir, 'prev.json'), '--projects', 'data/projects.json', '--sample']);
  const out = JSON.parse(await readFile(join(dir, 'news.json'), 'utf8'));
  const find = re => out.items.find(i => re.test(i.titleEn));

  assert.equal(out.sources.coindesk.status, 'ok');
  assert.equal(out.sources.bbc.status, 'erreur', 'une source en panne est signalée sans bloquer le reste');
  assert.ok(out.warnings.length);
  assert.ok(!out.items.some(i => i.id === 'vieux'));

  const opec = find(/OPEC\+ agrees to cut/);
  assert.deepEqual([opec.importance, opec.count, opec.source, opec.impacts], ['critical', 2, 'Reuters', [['Pétrole', 1]]]);
  assert.equal(opec.title, `FR ${opec.titleEn}`, 'titre traduit');
  assert.equal(out.items.filter(i => /OPEC\+ agrees/.test(i.titleEn)).length, 1, 'Reuters et Bloomberg regroupés');

  assert.equal(find(/Gold prices climb/).title, 'Le prix de l\'or grimpe', 'traduction déjà faite reprise');
  assert.equal(find(/^ECB: Monetary policy decisions$/).theme, 'cb', 'l\'émetteur est ajouté au titre officiel');
  assert.ok(!find(/supervisory banking/), 'communiqué BCE sans rapport écarté');
  assert.ok(find(/Crypto Platform Founder/) && !find(/Investment Adviser/), 'SEC : seulement les communiqués crypto');
  assert.equal(find(/Hackers drain \$72 million/).importance, 'medium', 'piratage d\'un seul média : en attente de confirmation');
  assert.equal(find(/Nebula DEX launches/).projectId, 'nebula-dex');
  assert.ok(!find(/price analysis/), 'hors des thèmes suivis');
  assert.deepEqual(find(/Trump announces new 100% tariffs/).impacts, [['BTC', -1]]);

  const whales = out.items.filter(i => i.kind === 'whale');
  assert.deepEqual(whales.map(w => sp(w.title)).sort(), ['1 500 BTC (150 M$) envoyés d\'un portefeuille inconnu vers Coinbase', '250 M USDT créés par Tether Treasury']);
  for (const i of out.items) {
    assert.ok(i.id && i.time && i.titleEn && i.why !== undefined && Array.isArray(i.impacts) && ['critical', 'medium', 'low'].includes(i.importance));
    assert.ok(Object.keys(out.themes).includes(i.theme));
  }
});
