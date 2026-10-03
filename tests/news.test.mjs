import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  NEWS, amountUsd, buildFeed, classify, reclassify, cluster, headline, matchProject, parseFeed, parseTelegram, parseWhale, similar,
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
  const abc = 'ABC News - Breaking News, Latest News and Videos';
  assert.deepEqual(splitSource(`Fed holds rates steady as inflation hits 3-year high - ${abc}`, abc), { title: 'Fed holds rates steady as inflation hits 3-year high', source: 'ABC News' });
  assert.deepEqual(splitSource(`Rubio says US struck Iran - ABC News - ${abc}`, abc), { title: 'Rubio says US struck Iran', source: 'ABC News' }, 'source répétée dans le titre');
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
  // Titres vus lors de l'essai sur les vraies sources (2 octobre 2026) : bruit à garder en faible importance.
  ['LIVE MARKETS: FTSE seen rebounding as bond yields steady ahead of jobs report', {}, 'inflation', 'low', []],
  ['US stocks advance as Treasury yields fall ahead of jobs report', {}, 'inflation', 'low', []],
  ['US job growth expected to slow in September; unemployment rate probably steady', {}, 'inflation', 'low', []],
  ['Asian officials address long-end rate volatility as Tokyo CPI jumps', {}, 'inflation', 'low', []],
  ['US mortgage rates climb to 7.28% after Iran war pushed inflation higher', {}, 'inflation', 'low', []],
  ['US employers added 254,000 jobs in September', {}, 'inflation', 'medium', []],
  ['US CPI rises 0.4% in September, hotter than expected', {}, 'inflation', 'medium', [['BTC', -1]]],
  ['Key US inflation data and Fed decision in October', {}, 'taux', 'low', []],
  ['Bitget "doesn\'t expect to recover much" of $388 million hack, CEO tells CNBC', { crypto: true }, 'hack', 'low', []],
  ['NEAR Intents says it identified the hacker, gives 48-hour ultimatum', { crypto: true }, 'hack', 'low', []],
  ['Pentagon announces combat pay raise amid war with Iran', {}, 'conflit', 'low', []],
  ['Trump says it is possible the war with Iran costs him the midterm elections', {}, 'tensions', 'low', []],
  ['Pentagon identifies 6 US troops killed in Kuwait during Iran war', {}, 'conflit', 'low', []],
  ['Third carrier for Iran? USS Theodore Roosevelt deploys from San Diego', {}, 'tensions', 'medium', []],
  ['Natural Gas, WTI Oil, Brent Oil Forecasts – Oil Rebounds as Trump Signals More Strikes on Iran', {}, 'guerre', 'low', []],
  ['Tanker catches fire after first Hormuz attack in October', {}, 'guerre', 'critical', [['Pétrole', 1], ['Or', 1], ['BTC', -1]]],
  ['Hormuz oil exports back to pre-war levels despite Iran attacks', {}, 'guerre', 'medium', [['Pétrole', 1], ['Or', 1], ['BTC', -1]]],
  ['Bitget hack: Where did the stolen $387M go?', { crypto: true }, 'hack', 'low', []],
  ['Bitcoin ETFs are $5 billion away from a new flow record after a brutal 11-month reset', {}, 'etf', 'low', []],
  ['Japan and South Korea seal $900 billion deal that eases tariffs', {}, 'droits-de-douane', 'low', []],
  ['Costco says it used tariff refunds to cut prices', {}, 'droits-de-douane', 'low', []],
  ['US has no timeline for cutting tariffs on $60 billion of Chinese goods', {}, 'droits-de-douane', 'low', []],
  ['Trump imposes additional 50% tariffs on some Canadian products', {}, 'droits-de-douane', 'medium', [['BTC', -1]]],
  ["Trump's 50% tariffs on Canada take effect as Carney vows to retaliate", {}, 'droits-de-douane', 'medium', [['BTC', -1]]],
  ['RESCON: Tariffs will escalate the cost of new home building in both Canada and U.S.', {}, 'droits-de-douane', 'low', []],
  ['Trump, Modi Discuss Trade, Energy Ties as New Tariffs Loom', {}, 'droits-de-douane', 'low', []],
  ['Canadian trailer dealers call for removal of tariffs on specialized US auto-hauling equipment', {}, 'droits-de-douane', 'low', []],
  ['IMF approves $120 million for El Salvador despite bitcoin breach', {}, 'regulation', 'low', []],
  ['Hormuz oil exports recover as blockade eases', {}, 'cessez-le-feu', 'medium', [['Pétrole', -1], ['Or', -1]]],
  ['Crude oil exports from strait of Hormuz largely return to pre-war levels', {}, 'cessez-le-feu', 'medium', [['Pétrole', -1], ['Or', -1]]],
  ['On CNN, Gallego Condemns Trump and Hegseth’s War in Iran, Attacks on the Free Press', {}, 'conflit', 'low', []],
  ["Türkiye condemns Houthis' attack on holy city of Medina", {}, 'conflit', 'low', []],
  ["US sanctions target Iran's auto, rail sectors as blockade chokes ship lanes", {}, 'sanctions', 'low', []],
  ["Treasury sanctions operation targets Iran's auto, rail industries in latest economic attack", {}, 'sanctions', 'low', []],
  ['Evernorth shareholders approve $1 billion XRP treasury deal, clearing path to Nasdaq debut', {}, 'regulation', 'low', []],
  ['Cryptohack Roundup: $387M Bitget Hack', {}, 'hack', 'low', []],
  ['Bitcoin ETF Demand Roars Back With $6.34 Billion in Q3 Inflows', {}, 'etf', 'low', []],
  ['Stablecoins can drain from banks and nations at lightning speed', { crypto: true }, null],
  ['US Regulators Have Changed Bank Crypto Rules With Every New President Since 2017. Why a Law Is Better for Bitcoin', {}, 'regulation', 'low', []],
  ['U.S. unemployment claims dip to the lowest since mid-July', {}, 'inflation', 'medium', [['BTC', -1]]],
  ['U.S. core PCE inflation falls to 3.0%; why do long-term interest rates remain elevated?', {}, 'inflation', 'medium', [['BTC', 1]]],
  ['Teachers strikes in France', {}, null],
  ["Saudi-led coalition says Houthis attacked power station for Prophet's Mosque in Medina", {}, 'guerre', 'critical', [['Pétrole', 1], ['Or', 1], ['BTC', -1]]],
  ['Crypto lost $1.26 billion in hacks while bitcoin bulls enjoyed a monster quarter', {}, 'hack', 'low', []],
  ['Bitget Hacker Turns to Zcash Privacy Pool After Near Rejects $50M in Swaps', { crypto: true }, 'hack', 'low', []],
  ['Aave publishes plan to plug $246m hole left by Kelp DAO attackers', { crypto: true }, 'hack', 'low', []],
  ["Small business owners 'should be worried' after US slaps Canada with new tariffs, expert claims", {}, 'droits-de-douane', 'low', []],
  ['India-US trade deal in ‘short strokes’ but nothing imminent, USTR Greer says', {}, 'droits-de-douane', 'low', []],
  ['NZD/USD holds near $0.5574 support amid Federal Reserve October rate hike probability rise', {}, 'taux', 'low', []],
  ['Fake signals, frozen accounts: SEC sues crypto AI platform over $12.5M', {}, 'regulation', 'low', []],
  ['Bitcoin ETFs’ 9-day, $3 billion inflow streak comes to an end as $149 million exits the funds', {}, 'etf', 'medium', []],
  ['Inflation fell more than expected in June as gas prices eased', {}, 'inflation', 'medium', [['BTC', 1]]],
  ['US producer prices rose less than expected in August', {}, 'inflation', 'medium', [['BTC', 1]]],
  // Essai du 3 octobre 2026 : 83 news moyennes, surtout du bruit. Suites de piratage, commentaires, petits partenaires
  // commerciaux, procès contre un régulateur, produits à levier : faible importance. Publi-rédactionnels : écartés.
  ['Chainalysis Attributes Bitget’s $387M Hack to DPRK Actors, Traces Funds Across Four Chains', { crypto: true }, 'hack', 'low', []],
  ['Bitget $387M Hack Linked to North Korea', { crypto: true }, 'hack', 'low', []],
  ['Bitget has frozen just $1.1 million of $388 million stolen in crypto hack', {}, 'hack', 'low', []],
  ['‘Privacy working as intended’: Zano details 1-month rollback after $250M exploit', { crypto: true }, 'hack', 'low', []],
  ["Microsoft's X Account Hacked, Posts Clippy Crypto Memes", {}, 'hack', 'low', []],
  ['Crypto hackers exploit third-party Aave tool to steal 114 ETH', { crypto: true }, 'hack', 'low', []],
  ['Hackers breach Coinbase hot wallet, withdrawals paused', { crypto: true }, 'hack', 'medium', []],
  ['California Subpoenas OpenAI Over AI Models That Hacked Their Way Out of a Test', { crypto: true }, null],
  ['Oil prices drop as G7 nations pledge to release diesel stocks; Saudis said planning attack on Houthis', {}, 'guerre', 'medium', [['Pétrole', 1], ['Or', 1], ['BTC', -1]]],
  ['Iran Executes Man Detained During January Protests Over Alleged Attack on Police', {}, 'conflit', 'low', []],
  ['US Further Targets Iran-Linked Russian A7 Financial Network', {}, null],
  ['Crude oil tanker struck by unknown projectile off Oman, UKMTO says', {}, 'infra-petrole', 'medium', [['Pétrole', 1]]],
  ['Breaking down Trump’s new ‘drug factories’ claim about Iranian nuclear sites', {}, 'tensions', 'low', []],
  ['Oil prices will plummet once the war ends; Iran will not get nuclear weapons: Donald Trump.', {}, 'tensions', 'low', []],
  ['Putin orders military leaders to target civilians and nuclear facilities, Zelensky warns: ‘No rules now’', {}, 'tensions', 'low', []],
  ['Canada imposes new tariffs on U.S. farm goods, raising uncertainty for Kern farmers', {}, 'droits-de-douane', 'low', []],
  ['Trump threatens to double South Korea tariffs, blasts New York AG Letitia James', {}, 'droits-de-douane', 'low', []],
  ['Trump says South Korea trade deal adds $8.4B oil project', {}, 'droits-de-douane', 'low', []],
  ['Canseco: Canadians look to Europe as 82% call U.S. tariffs a threat, poll finds', {}, 'droits-de-douane', 'low', []],
  ['US leverage, India’s limited options: Why is the trade deal taking so long?', {}, 'droits-de-douane', 'low', []],
  ['China slaps retaliatory tariffs on US farm goods', {}, 'droits-de-douane', 'medium', [['BTC', -1]]],
  ['Community Banks Sue OCC Over Expanding Trust Charters to Crypto', {}, 'regulation', 'low', []],
  ['SEC Approves Listing of 3x Leveraged ETFs on Bitcoin, Ether', {}, 'etf', 'low', []],
  ['VolatilityShares Launches 3x Bitcoin ETP Amid SEC Approval', {}, 'etf', 'low', []],
  ["BlackRock's Bitcoin ETF Has Net Bought $1.57 Billion Worth of Bitcoin in the Past Month.", {}, 'etf', 'low', []],
  ['$BNB Chain becomes the first blockchain to surpass $1,000,000,000 in tokenized stocks and ETFs', {}, 'etf', 'low', []],
  ['Remittix, Solana and XRP: 3 Cryptos to Watch as ETF Money Returns and RTX Launch Nears', {}, null],
  ['Bitcoin vs Remittix: Can BTC’s ETF Rally Match the Attention Around a New PayFi Launch?', {}, null],
  ['Dollar-Yen Forecast at 155.50–159.00 Next Week; Tokyo CPI Upside Surprise Could Reignite BOJ Rate Hike Bets', {}, 'taux', 'low', []],
  ['US Dollar: FOMC minutes to offer limited fresh clues – TD Securities', {}, 'taux', 'low', []],
  ['Jobless Claims Dip in Florida', {}, 'inflation', 'low', []],
  ['Iranian Oil Starts Flowing to Tajikistan Despite U.S. Sanctions Risk', {}, 'sanctions', 'low', []],
  ['Oil Heads for Weekly Decline as Hormuz Supply Concerns Ease', {}, 'cessez-le-feu', 'low', []],
  ['Euro-area Inflation: Headline pressures rise – Nordea', {}, 'inflation', 'low', []],
  ['Labor market faltered in September as jobs increased by just 29,000, unemployment rate rose to 4.2%', {}, 'inflation', 'medium', [['BTC', 1]]],
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

test('reclassify : les news déjà en ligne suivent les nouvelles règles', () => {
  const old = [
    { id: 'a', kind: 'feed', titleEn: 'Bitget $387M Hack Linked to North Korea', importance: 'critical', raw: 'critical', impacts: [['Crypto', -1]], rule: 'hack', theme: 'hack', why: 'x', src: 'theblock' },
    { id: 'b', kind: 'feed', titleEn: 'Remittix, Solana and XRP: 3 Cryptos to Watch as ETF Money Returns', importance: 'medium', raw: 'medium', impacts: [['SOL', 1]], rule: 'etf', theme: 'etf', why: 'x', key: 'k' },
    { id: 'c', kind: 'whale', titleEn: '604 $BTC transferred', importance: 'medium', impacts: [['BTC', 1]] },
  ];
  const [a, b, c] = reclassify(old, i => ({ crypto: i.src === 'theblock' }));
  assert.deepEqual([a.importance, a.raw, a.impacts], ['low', 'low', []]);
  assert.deepEqual([b.importance, b.impacts, b.key], ['low', [], undefined], 'plus aucune règle : faible');
  assert.equal(c, old[2], 'baleine inchangée');
});

test('classify : communiqués officiels et projets du top', () => {
  assert.equal(classify('ECB publishes supervisory banking statistics', { prefix: 'ECB', theme: 'cb', why: 'Communiqué BCE.' }).rule, 'source');
  assert.deepEqual(['rule', 'importance'].map(k => classify('ECB: Monetary policy decisions', { prefix: 'ECB', theme: 'cb' })[k]), ['taux', 'medium'], 'décision officielle du jour');
  assert.equal(classify('TRUMP ANNOUNCES 100% TARIFFS ON CHINA').importance, 'medium', 'titre tout en majuscules');
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
  assert.deepEqual([mint.importance, mint.impacts], ['low', []], 'création de stablecoins courante : faible');
  const bigMint = whaleNews(parseWhale('💵 1,000,000,000 #USDT (1,000,123,456 USD) minted at Tether Treasury'));
  assert.deepEqual([bigMint.importance, bigMint.impacts], ['medium', [['Crypto', 1]]]);
  const small = whaleNews(parseWhale('12,345 #ETH (45,678,901 USD) transferred from #Binance to unknown wallet'));
  assert.equal(small.importance, 'low');
  assert.deepEqual(small.impacts, [], 'pas de flèche sur un petit mouvement');
  assert.equal(whaleNews(parseWhale('120 #ETH (450,000 USD) transferred from unknown wallet to #Binance')), null);
  // Format actuel du canal : « $UNI » et le lien « Details ».
  const cashtag = whaleNews(parseWhale('🚨 2,493,137 $UNI (22,464,516 USD) transferred from #BitGet to unknown wallet\nDetails'));
  assert.equal(sp(cashtag.title), '2,5 M UNI (22 M$) envoyés de BitGet vers un portefeuille inconnu');
  assert.equal(sp(whaleNews(parseWhale('💵 💵 250,000,000 $USDC (250,022,874 USD) minted at USDC Treasury Details')).title), '250 M USDC créés par USDC Treasury');
  const top = whaleNews(parseWhale('9,000,000 #NBL (12,000,000 USD) transferred from unknown wallet to #Bybit'), [{ id: 'nebula-dex', symbol: 'NBL' }]);
  assert.deepEqual([top.importance, top.projectId, top.impacts], ['medium', 'nebula-dex', [['NBL', -1]]]);
  // Sans sens clair, un transfert n'est moyen qu'au-delà de 1 Md$.
  const quiet = whaleNews(parseWhale('🚨 2,044 $BTC (173,800,505 USD) transferred from unknown wallet to unknown wallet Details'));
  assert.deepEqual([quiet.importance, quiet.impacts], ['low', []], 'entre portefeuilles inconnus');
  const internal = whaleNews(parseWhale('🚨 50,000 $ETH (135,336,586 USD) transferred from #Binance to Binance Beacon Deposit Details'));
  assert.deepEqual([internal.importance, internal.impacts], ['low', []], 'interne à un exchange (staking)');
  assert.match(internal.why, /interne/);
  const outflow = whaleNews(parseWhale('🚨 1,487 $BTC (124,581,057 USD) transferred from #Kraken to unknown wallet Details'));
  assert.deepEqual([outflow.importance, outflow.impacts], ['medium', [['BTC', 1]]], 'retrait d\'un exchange');
  assert.equal(whaleNews(parseWhale('1,200,000,000 $USDT (1,200,140,000 USD) transferred from unknown wallet to unknown wallet')).importance, 'medium');
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
  const claims = ['U.S. weekly jobless claims fall to lowest level since mid-July', 'US Initial Jobless Claims Slip to 197,000, Lowest Since July']
    .map((t, k) => ({ ...item(`j${k}`, t, { source: k ? 'Bloomberg' : 'Yahoo Finance' }), ...classify(t) }));
  assert.ok(!similar(...claims), 'peu de mots en commun');
  assert.equal(cluster(claims).length, 1, 'même chiffre (inscriptions au chômage) : une seule news');
  const whales = cluster([item('w1', '1,000 BTC transferred to Binance', { kind: 'whale' }), item('w2', '1,000 BTC transferred to Binance', { kind: 'whale' })]);
  assert.equal(whales.length, 2, 'les baleines ne sont jamais regroupées');
});

test('une news critique d\'un seul petit média reste moyenne jusqu\'à confirmation', () => {
  const rumor = item('r', 'Iran launches missile attack on Israel', { rank: 1, source: 'Blog', importance: 'critical', theme: 'geo', rule: 'guerre' });
  const [alone] = cluster([rumor]);
  assert.deepEqual([alone.importance, alone.raw], ['medium', 'critical']);
  const [confirmed] = cluster([alone, item('s', 'Iran launches missile attack against Israel', { rank: 1, source: 'Autre média', importance: 'critical', theme: 'geo', rule: 'guerre' })]);
  assert.equal(confirmed.importance, 'critical');
  const [mixed] = cluster([item('q', 'Hormuz oil exports return to pre-war levels, Iran says', { importance: 'medium', theme: 'geo', rule: 'cessez-le-feu', source: 'The Guardian' }),
    item('z', 'Iran attacks oil tanker as Hormuz exports return to pre-war levels', { rank: 1, source: 'Blog', importance: 'critical', theme: 'geo', rule: 'guerre' })]);
  assert.deepEqual([mixed.importance, mixed.titleEn, mixed.count], ['critical', 'Iran attacks oil tanker as Hormuz exports return to pre-war levels', 2],
    'le titre affiché explique l\'importance');
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

test('guerre en cours : seule la première frappe d\'une zone en 24 h reste critique', () => {
  const strike = (id, hoursAgo, titleEn) => ({ ...item(id, titleEn, { time: NOW - hoursAgo * HOUR }), ...classify(titleEn) });
  const feed = buildFeed([], [
    strike('a', 10, 'Israel strikes Iran nuclear sites'),
    strike('b', 6, 'US strikes Iranian missile bases'),
    strike('c', 2, 'Iran closes Strait of Hormuz to shipping'),
    strike('d', 1, 'China fires missiles at Taiwan'),
  ], NOW);
  const level = (f, id) => f.find(i => i.id === id).importance;
  assert.deepEqual(['a', 'b', 'c', 'd'].map(id => level(feed, id)), ['critical', 'medium', 'critical', 'critical'],
    'frappe suivante : moyenne ; détroit fermé : toujours critique ; autre zone : critique');
  assert.match(feed.find(i => i.id === 'b').why, /guerre déjà en cours/);
  assert.deepEqual(feed.find(i => i.id === 'b').impacts, [['Pétrole', 1], ['Or', 1], ['BTC', -1]]);
  assert.equal(level(buildFeed(feed, [], NOW + HOUR), 'b'), 'medium', 'reste moyenne aux mises à jour suivantes');
  const threats = buildFeed([], [
    strike('a', 10, 'Israel strikes Iran nuclear sites'),
    strike('t', 8, 'Iran threatens to retaliate against US bases'),
    strike('h', 7, 'Iran threatens to close Strait of Hormuz'),
  ], NOW);
  assert.deepEqual(['t', 'h'].map(id => level(threats, id)), ['low', 'medium'], 'menace pendant la guerre : faible, sauf escalade majeure');
  assert.deepEqual(threats.find(i => i.id === 't').impacts, []);
  const later = buildFeed([], [strike('a', 40, 'Israel strikes Iran nuclear sites'), strike('e', 1, 'US strikes Iranian missile bases')], NOW);
  assert.equal(level(later, 'e'), 'critical', 'plus de 24 h sans frappe : nouvelle escalade');
});

test('buildFeed : les news faibles laissent la place aux importantes un jour chargé', () => {
  const lows = Array.from({ length: NEWS.maxItems + 20 }, (_, k) => item(`l${k}`, `w${k}a w${k}b w${k}c w${k}d`, { importance: 'low', time: NOW - k * 60_000 }));
  const crit = item('c', 'Iran launches missile attack on Israel', { importance: 'critical', theme: 'geo', rule: 'guerre', time: NOW - 30 * HOUR });
  const feed = buildFeed([], [...lows, crit], NOW);
  assert.equal(feed.length, NEWS.maxItems);
  assert.ok(feed.some(i => i.id === 'c'), 'la news critique de la veille est gardée');
  assert.ok(feed.some(i => i.id === 'l0') && !feed.some(i => i.id === `l${NEWS.maxItems + 19}`), 'les news faibles les plus anciennes partent');
});

test('build-news écrit news.json à partir des réponses fictives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dinexo-news-'));
  const now = Date.now();
  await writeFile(join(dir, 'prev.json'), JSON.stringify({
    items: [
      { id: 'vieux', ids: ['vieux'], time: now - 80 * HOUR, titleEn: 'Old news', title: 'Vieille news', lang: 'fr', importance: 'low', theme: 'geo', impacts: [], kind: 'feed', sources: [] },
      { id: 'garde', ids: ['garde'], time: now - 10 * HOUR, titleEn: 'Gold prices climb as dollar weakens', title: 'Le prix de l\'or grimpe', lang: 'fr', importance: 'low', theme: 'energy', impacts: [], kind: 'feed', rank: 1, source: 'Kitco', sources: ['Kitco'], count: 1, rule: 'energie', why: '…' },
    ],
  }));
  await writeFile(join(dir, 'projects.json'), JSON.stringify({ projects: [{ id: 'nebula-dex', name: 'Nebula DEX', symbol: 'NBL', rank: 1, inTop: true }] }));
  await promisify(execFile)('node', ['--import', './tests/mock-fetch.mjs', 'scripts/build-news.mjs', '--out', dir, '--previous', join(dir, 'prev.json'), '--projects', join(dir, 'projects.json'), '--sample']);
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

  assert.equal(find(/NEAR Intents pauses/)?.theme, 'hack', 'un message Whale Alert qui n\'est pas un transfert est lu comme une news');
  const whales = out.items.filter(i => i.kind === 'whale');
  assert.deepEqual(whales.map(w => sp(w.title)).sort(), ['1 500 BTC (150 M$) envoyés d\'un portefeuille inconnu vers Coinbase', '250 M USDT créés par Tether Treasury']);
  for (const i of out.items) {
    assert.ok(i.id && i.time && i.titleEn && i.why !== undefined && Array.isArray(i.impacts) && ['critical', 'medium', 'low'].includes(i.importance));
    assert.ok(Object.keys(out.themes).includes(i.theme));
  }
});
