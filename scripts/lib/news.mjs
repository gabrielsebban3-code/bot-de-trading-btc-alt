// Logique de l'onglet Actu : lecture des flux, classement par mots-clés, impact probable, regroupement des doublons.
// Fonctions pures, sans accès réseau, testées dans tests/news.test.mjs.

export const THEMES = {
  geo: 'Géopolitique',
  cb: 'Banques centrales',
  energy: 'Énergie et or',
  reg: 'Régulation',
  hack: 'Hacks',
  etf: 'ETF',
  whale: 'Baleines',
  project: 'Projets du top',
};

export const LEVEL = { critical: 3, medium: 2, low: 1 };
// À changer quand les règles de classement changent : les news déjà dans le fil sont alors reclassées.
export const RULES_VERSION = 2;

export const NEWS = {
  keepHours: 72,          // une news reste 3 jours dans le fil
  bannerHours: 6,         // bandeau rouge pendant 6 h après une news critique
  maxItems: 250,
  maxSmallWhales: 40,     // baleines de faible importance gardées dans le fil (les plus récentes)
  maxTranslations: 150,   // titres traduits par mise à jour au maximum
  whaleMinUsd: 10e6,      // baleines : transferts de plus de 10 M$
  whaleMediumUsd: 100e6,
  whaleStableMediumUsd: 500e6, // créations de stablecoins : routinières en dessous
  whaleQuietMediumUsd: 1e9,    // transfert sans sens clair (entre portefeuilles inconnus, interne à un exchange)
  hackCriticalUsd: 50e6,  // hack de plus de 50 M$ = critique
  hackMediumUsd: 5e6,
  etfMediumUsd: 500e6,
  regCaseMediumUsd: 100e6, // poursuite ou amende plus petite : affaire isolée, sans effet sur le marché
};

const HOUR = 3600_000;

// ---------- Lecture des flux ----------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', euro: '€',
};

export function decode(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

const stripTags = s => String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
const oneLine = s => s.replace(/\s+/g, ' ').trim();
// Le contenu des flux est souvent encodé deux fois : on décode, on retire les balises, puis on décode encore.
const clean = s => oneLine(decode(stripTags(decode(s))));

// Flux RSS 2.0 ou Atom → [{ title, link, time, source }]
export function parseFeed(xml) {
  const blocks = String(xml).match(/<item[\s>][\s\S]*?<\/item>/gi) || String(xml).match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    const tag = name => b.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] ?? '';
    let link = clean(tag('link'));
    if (!/^https?:\/\//i.test(link)) link = decode(b.match(/<link[^>]*?href="([^"]+)"/i)?.[1] ?? '');
    if (!/^https?:\/\//i.test(link)) link = clean(tag('guid'));
    const t = Date.parse(clean(tag('pubDate') || tag('published') || tag('updated') || tag('dc:date')));
    return { title: clean(tag('title')), link: /^https?:\/\//i.test(link) ? link : null, time: Number.isFinite(t) ? t : null, source: clean(tag('source')) || null };
  }).filter(i => i.title);
}

// Page publique d'un canal Telegram (t.me/s/<canal>) → [{ text, link, time }]
export function parseTelegram(html, channel) {
  const out = [];
  for (const part of String(html).split('data-post="').slice(1)) {
    const post = part.slice(0, part.indexOf('"'));
    const body = part.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    if (!body || !post.toLowerCase().startsWith(`${channel.toLowerCase()}/`)) continue;
    const t = Date.parse(part.match(/<time[^>]*datetime="([^"]+)"/)?.[1] ?? '');
    const text = decode(stripTags(body)).split('\n').map(l => oneLine(l)).filter(Boolean).join('\n');
    out.push({ text, link: `https://t.me/${post}`, time: Number.isFinite(t) ? t : null });
  }
  return out;
}

// Titre propre : sans emojis, drapeaux ni « BREAKING: », « JUST IN: »… (le site n'affiche pas d'emojis).
export function tidy(title) {
  return oneLine(String(title ?? '')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, ' ')
    .replace(/^\s*(?:[-–—:|•*]\s*)*(?:(?:breaking|just in|update|live|watch|video|exclusive|developing|alert|flash|news)\s*(?:news)?\s*[:|–—-]\s*)+/i, ''))
    .replace(/^[-–—:|•*\s]+/, '');
}

// Titre d'un message Telegram : la première ligne utile, coupée proprement si elle est trop longue.
export function headline(text, max = 200) {
  const lines = String(text).split('\n').map(tidy).filter(l => l.length > 3 && !/^https?:\/\//i.test(l));
  let t = lines[0] ?? '';
  if (t.length < 25 && lines[1]) t = `${t.replace(/[:.]$/, '')}: ${lines[1]}`;
  t = t.replace(/(?<!\.[A-Za-z])\.$/, ''); // pas de point final dans un titre (mais « U.S. » reste entier)
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[\s,;:.-]+$/, '')}…`;
}

// Google News ajoute « - Source » à la fin du titre, parfois avec le slogan du site, parfois deux fois.
export function splitSource(title, source) {
  let t = title, src = source;
  if (src && t.endsWith(` - ${src}`)) t = t.slice(0, -(src.length + 3)).trim();
  else {
    const i = t.lastIndexOf(' - ');
    if (i > 20 && t.length - i < 45) { src ||= t.slice(i + 3).trim(); t = t.slice(0, i).trim(); }
  }
  // « ABC News - Breaking News, Latest News and Videos » → « ABC News »
  const name = src ? src.split(/\s+[-|–—]\s+/)[0].trim() || src : src;
  if (name && t.endsWith(` - ${name}`)) t = t.slice(0, -(name.length + 3)).trim();
  return { title: t, source: name };
}

// ---------- Mise en forme (français) ----------

const nf = (n, d = 0) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

export function fmtUsd(n) {
  if (n >= 1e9) return `${nf(n / 1e9, n >= 1e10 ? 0 : 1)} Md$`;
  if (n >= 1e6) return `${nf(n / 1e6, 0)} M$`;
  return `${nf(n / 1e3, 0)} k$`;
}

const fmtQty = n => (n >= 1e6 ? `${(n / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: n >= 1e8 ? 0 : 1 })} M` : nf(n, n >= 100 ? 0 : 2));

// Plus gros montant en dollars cité dans le texte (« $1.5 billion », « $70M », « 120 million USD »).
export function amountUsd(text) {
  const unit = u => ({ b: 1e9, bn: 1e9, billion: 1e9, m: 1e6, mn: 1e6, mln: 1e6, million: 1e6, k: 1e3, thousand: 1e3 })[String(u || '').toLowerCase()] ?? 1;
  const num = s => Number(s.replace(/,/g, ''));
  let best = null;
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(billion|bn|b|million|mln|mn|m|thousand|k)?\b/gi)) {
    const v = num(m[1]) * unit(m[2]);
    if (best === null || v > best) best = v;
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?(billion|million)\s?(?:dollars|usd|usdt|in crypto)\b/gi)) {
    const v = num(m[1]) * unit(m[2]);
    if (best === null || v > best) best = v;
  }
  return best;
}

// ---------- Actifs cités ----------

const TOKENS = [
  ['BTC', /\b(bitcoins?|btc)\b/i], ['ETH', /\b(ether|ethereum|eth)\b/i], ['SOL', /\b(solana|sol)\b/i],
  ['XRP', /\b(xrp|ripple)\b/i], ['BNB', /\bbnb\b/i], ['DOGE', /\b(dogecoin|doge)\b/i], ['ADA', /\b(cardano|ada)\b/i],
  ['AVAX', /\b(avalanche|avax)\b/i], ['LINK', /\bchainlink\b/i], ['SUI', /\bsui\b/i], ['TRX', /\b(tron|trx)\b/i],
  ['HYPE', /\bhyperliquid\b/i], ['LTC', /\b(litecoin|ltc)\b/i], ['TON', /\btoncoin\b/i],
];
export const STABLES = new Set(['USDT', 'USDC', 'DAI', 'USDE', 'FDUSD', 'PYUSD', 'TUSD', 'USDS', 'USD1', 'RLUSD', 'BUSD', 'EURC']);

export const isCrypto = text => CRYPTO.test(text);

export function tokensIn(text) {
  return TOKENS.filter(([, re]) => re.test(text)).map(([sym]) => sym);
}

// ---------- Règles de classement ----------

const CRYPTO = /\b(crypto\w*|bitcoins?|btc|ether(eum)?|eth|solana|xrp|stablecoins?|tokens?|defi|blockchain|coinbase|binance|tether|usdt|usdc|web3|altcoins?|memecoins?|digital assets?)\b/i;
const FED = /\b(fed|fomc|federal reserve|federal open market committee|powell)\b/i;
const MAJOR_CB = /\b(fed|fomc|federal reserve|federal open market committee|powell|ecb|lagarde|bank of england|boe|bank of japan|boj|ueda)\b/i;
const CBANK = /\b(fed|fomc|federal reserve|federal open market committee|powell|ecb|lagarde|bank of england|boe|bank of japan|boj|ueda|pboc|people's bank of china|snb|swiss national bank|bank of canada|rba|central banks?)\b/i;
const RATEWORD = /\b(rates?|cut|cuts|cutting|hike|hikes|hiking|raises?|raised|lowers?|lowered|holds?|keeps?|leaves|basis points?|bps|easing|tightening|hawkish|dovish|interest)\b/i;
const SURPRISE = /\b(surprise|surprises|surprising(ly)?|unexpected(ly)?|emergency|shock)\b/i;
const DECISION = /\b(cuts|hikes|hiked|raises|raised|lowers|lowered|holds|keeps|leaves|statement|minutes|announces)\b/i;
const RATE_CUT = /\b(cut|cuts|cutting|lowers?|lowered|easing|reduc\w*)\b/i;
const RATE_HIKE = /\b(hike|hikes|hiking|raises?|raised|tightening)\b/i;
const RATE_HOLD = /\b(holds?|keeps?|leaves|unchanged|steady|on hold|pauses?|paused)\b/i;
// « further rate cuts », « two more cuts » : des baisses évoquées, pas la décision du jour.
const RATE_NOUNS = /\b(rate|further|more|future|additional|deeper|faster|slower|two|three|several|fewer|aggressive|bigger|larger|jumbo|possible|next)\s+(?:rate\s+)?(cuts|hikes|increases|reductions)\b/gi;
const UNCERTAIN = /\b(may|might|could|planning|preparing|prepares|considers?|considering|weighs?|weighing|mulls?|likely|expected to|sources say|sources|reportedly|plans? to|talks|eyes|seeks?|would|ahead of|bets?|odds|probabilit\w*|chances?|traders)\b/i;
// Avant-première : le chiffre ou la décision n'est pas encore tombé.
const PREVIEW = /\b(ahead of|before|awaits?|awaited|awaiting|eyes|eyeing|braces? for|bracing for|in focus|on tap|preview\w*|what to (expect|watch|know)|expected to|seen (rising|falling|slowing|cooling|easing|at)|forecast to|set to|week ahead|looms?|looming)\b/i;
// Prévisions, analyses, avis d'experts, fils en direct des marchés, commentaires de change (« NZD/USD holds… ») :
// utiles à lire, mais pas une nouvelle en soi.
const ANALYSIS = /\b(price predictions?|predictions? for|forecasts? for (today|tomorrow|next)|(price|oil|gas|gold|bitcoin|btc|crypto|weekly|daily) forecasts?|outlook:|technical analysis|price analysis|week ahead|what to (watch|expect|know)|explainer|explained|opinion|podcast|live markets?|markets? live|market wrap|stocks? to (watch|buy)|here[’']?s (why|what|how)|what comes next|away from|what (it|this|that) means|means for (you|your)|should (you )?(be )?worr(y|ied)|experts? (says?|claims?|warns?)|(eur|usd|gbp|jpy|aud|nzd|cad|chf|cny|xau|xag)\/(usd|jpy|chf|cad|eur|gbp|aud|nzd|cny))\b|\bforecasts?\s+[–—:-]|^why\b|\.\s+why\b/i;
// Autres formes de commentaire : titre-question (« Can BTC's ETF rally match… ? »), sondage, bilan de la semaine
// (« Oil heads for weekly decline »), note de banque reprise par FXStreet (« … – TD Securities »), décryptage.
const COMMENTARY = /(?:^|:\s*)(?:can|will|is|are|does|do|did|should|could|would|why|what|how|where|who|when)\b[^:;]*\?\s*$|\b(polls?|survey|breaking down|fact[- ]check\w*|(heads?|set|poised|on track|headed|on course) for (a |its )?(\w+ )?(weekly|monthly|daily|quarterly|annual|yearly)|[\d,.]+[- ](day|week|month) (high|low|streak)|forecast at)\b|\s[–—-]\s(td securities|ing|commerzbank|mufg|uob|rabobank|scotiabank|danske bank|socgen|soci[ée]t[ée] g[ée]n[ée]rale|bbh|wells fargo|nomura|citi|hsbc|barclays|goldman sachs|morgan stanley|jp ?morgan|ubs|bofa|natwest|ocbc|standard chartered|maybank|credit agricole|cba|westpac|anz|nordea|deutsche bank|bnp paribas|lloyds|rbc|td|bmo|cibc|swissquote)\s*$/i;
// Publi-rédactionnels et listes de « cryptos à surveiller » : écartés du fil.
const PROMO = /\b(remittix|presales?|pre-sales?|\d{2,4}x (gains?|potential|returns?)|next (big|100x|1000x)|best (crypto|cryptos|altcoins?|coins?|tokens?) to (buy|watch)|(cryptos?|altcoins?|coins?|tokens?|memecoins?) to (watch|buy)|\d+ (cryptos|cryptocurrencies|altcoins|coins|tokens) (to|that|for|under|with))\b/i;
const commentary = t => ANALYSIS.test(t) || COMMENTARY.test(t);
const REQUEST = /\b(calls? for|call to|urges?|urging|asks?|asking|seeks?|seeking|lobb\w*|petition\w*|push(es)? for|wants?)\b/i;
const NEGATED = /\b(no|not|nothing|won't|will not|never|rules? out|ruled out|refuses?|refused|rejects?|rejected|denies|denied)\b/i;
const THREAT = /\b(threat\w*|warns?|warned|warning|vows?|vowed|if|ready to|prepared to|fears?|risk|risks|possible|potential|calls? for|urges?|denies|denied|rules? out)\b/i;

const INFLATION = /\b(cpi|inflation|pce|consumer prices|producer prices|ppi|nonfarm|non-farm|nfp|payrolls|jobs report|unemployment (rate|claims)|jobless claims)\b/i;
// Le chiffre lui-même (« CPI jumps 0.6% », « jobless claims fall »), pas une simple mention : l'indicateur, puis le verbe.
const INDICATOR = '(cpi|inflation|pce|consumer prices|producer prices|ppi|payrolls|nfp|jobs report|job growth|job gains|unemployment(?: rate| claims)?|jobless (?:claims|rate)|wage growth)';
const MOVE = '(rises?|rose|falls?|fell|climbs?|climbed|jumps?|jumped|slows?|slowed|cools?|cooled|eases?|eased|accelerat\\w*|heats? up|hotter|cooler|beats?|beat|misses?|missed|surges?|surged|drops?|dropped|dips?|dipped|slips?|slipped|sinks?|sank|declines?|declined|ticks? (?:up|down)|edges? (?:up|down|higher|lower)|steady|unchanged|tops?|topped|exceeds?|exceeded|comes? in|came in|hits?|reaches?|reached|soars?|soared|tumbles?|tumbled|plunges?|plunged|spikes?|spiked|increases?|increased|grows?|grew|rebounds?|rebounded)';
const RELEASE = new RegExp(`\\b${INDICATOR}\\b(?:\\W+[\\w.%,-]+){0,4}?\\W+${MOVE}\\b`, 'i');
const JOBS_ADDED = /\b(economy|employers|payrolls)\s+(adds?|added|creates?|created|sheds?|shed|loses?|lost)\s+[\d,.]+\s*(k|thousand|million)?\s+jobs\b/i;
// Sens du chiffre : la comparaison avec les attentes si le titre la donne, sinon le verbe qui suit l'indicateur
// (« rises » seul ne compte pas pour les prix : une hausse mensuelle est la norme).
const HOT_WORDS = /\b(hotter|stronger|higher than expected|above (expectations|forecasts?|estimates?)|beats?|beat)\b/i;
const COOL_WORDS = /\b(cooler|weaker|lower than expected|below (expectations|forecasts?|estimates?)|misses?|missed)\b/i;
// « fell more than expected » est plus froid que prévu, « rose less than expected » aussi : le sens vient du verbe.
const VS_EXPECTED = /\b(more|less) than (expected|forecast|anticipated|estimated)\b/i;
const UP_STRONG = /^(jumps?|jumped|surges?|surged|accelerat\w*|heats? up|hotter|spikes?|spiked|soars?|soared|tops?|topped|exceeds?|exceeded)$/i;
const UP_ANY = /^(jumps?|jumped|surges?|surged|accelerat\w*|heats? up|spikes?|spiked|soars?|soared|tops?|topped|exceeds?|exceeded|rises?|rose|climbs?|climbed|increases?|increased|ticks? up|edges? (up|higher)|rebounds?|rebounded|grows?|grew|hits?|reaches?|reached)$/i;
const DOWN = /^(falls?|fell|drops?|dropped|dips?|dipped|slips?|slipped|sinks?|sank|declines?|declined|cools?|cooled|cooler|eases?|eased|slows?|slowed|tumbles?|tumbled|plunges?|plunged|ticks? down|edges? (down|lower))$/i;

// « jobless claims fall » et « initial claims slip to 197,000 » : le même chiffre, une seule news.
function dataKey(what, t) {
  if (/claims/.test(what)) return 'data-claims';
  if (/\bpce\b/i.test(t)) return 'data-pce';
  if (/ppi|producer/.test(what)) return 'data-ppi';
  if (/payrolls|nfp|jobs|job |unemployment|wage/.test(what)) return 'data-jobs';
  return 'data-cpi';
}

function dataRelease(t) {
  const m = t.match(RELEASE);
  if (m) return { what: m[1].toLowerCase(), verb: m[2] };
  return JOBS_ADDED.test(t) ? { what: 'payrolls', verb: '' } : null;
}
const FOREIGN = /\b(uk|britain|british|euro[ -]?zone|euro[ -]area|europe\w*|eu|german\w*|france|french|japan\w*|tokyo|asia\w*|china|chinese|canada|canadian|australia\w*|india\w*|turkey|turkish|brazil\w*|argentin\w*|russia\w*|mexic\w*|swiss|korea\w*|ftse|dax|nikkei)\b/i;
// Chiffre d'un seul État ou d'une ville américaine (« Jobless claims dip in Florida ») : pas le chiffre national.
const US_LOCAL = /\b(in|for) (alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york state|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington state|west virginia|wisconsin|wyoming|the state|[a-z]+ county)\b|\bstate(wide)? (jobless|unemployment)\b/i;
const USA = /(?<![\w.])(us|u\.s\.|usa|american|united states|fed)(?!\w)/i;
// Droits de douane : ceux des États-Unis font bouger les cryptos, pas un accord Japon-Corée. « US » en majuscules
// seulement (« us » est aussi un pronom).
const US_ACTOR = /\b(trump|white house|washington|lutnick|bessent|greer|united states|america|american)\b|(?<![\w.])(US|U\.S\.|USA)(?!\w)/;
const firstAt = (t, re) => { const m = t.match(re); return m ? m.index : Infinity; };
// Les États-Unis doivent être cités avant l'autre pays (« Canada imposes tariffs on U.S. farm goods » : c'est le Canada
// qui agit), sauf la Chine, dont la riposte pèse aussi sur les marchés. « us » minuscule est un pronom.
const TRADE_PARTNER = /\b(canad\w*|mexic\w*|japan\w*|south kore\w*|kore\w*|india\w*|eu|european|europe|brazil\w*|vietnam\w*|taiwan\w*|swiss|switzerland|uk|britain|british|australia\w*)\b/i;
const usActor = t => {
  const us = Math.min(firstAt(t, US_ACTOR), firstAt(t, /\b(trump|white house)\b/i));
  return us < Infinity && (us < firstAt(t, TRADE_PARTNER) || /\b(china|chinese|beijing)\b/i.test(t));
};
// Un accord ou des droits de douane avec un petit partenaire (Corée du Sud, Inde…) ne font pas bouger les cryptos :
// seuls la Chine, l'Europe, le Canada, le Mexique, le Japon ou des droits de douane sur tout le monde comptent.
const MAJOR_TRADE = /\b(china|chinese|beijing|eu|european union|europe|canad\w*|mexic\w*|japan\w*|global|worldwide|universal|reciprocal|all (imports|countries|trading partners|nations)|every country|trading partners|semiconductors?|chips)\b/i;

const OPEC = /\bopec\+?/i;
const OUTPUT = /\b(output|production|supply|quotas?|bpd|barrels per day)\b/i;
const DECIDED = /\b(agrees?|agreed|decides?|decided|announces?|announced|approves?|approved|will|to (raise|cut|boost|increase|lift|hike|reduce|unwind)|raises|cuts|boosts|lifts|hikes|reduces|unwinds)\b/i;
const OUT_CUT = /\b(cut|cuts|cutting|reduce|reduces|reduction|curbs?|curbing|extends? cuts?)\b/i;
const OUT_RAISE = /\b(raise|raises|raising|increase|increases|increasing|boost|boosts|boosting|hike|hikes|lift|lifts|unwind\w*|add|adds|adding)\b/i;
const PAUSE = /\b(pause|pauses|paused|halt|halts|halted|freeze|freezes|delay|delays|delayed|postpone\w*)\b/i;

const OIL = /\b(oil|crude|brent|wti|barrels?|gasoline|natural gas|lng|gold|bullion)\b/i;
const MARKET_MOVE = /\b(prices?|futures|market|output|production|supply|exports?|imports?|demand|record|rall\w*|jumps?|falls?|fell|slump\w*|surges?|soars?|tumbles?|plunges?|climbs?|drops?|gains?|loses?|highs?|lows?)\b/i;
const INVENTORY = /\b(inventor(y|ies)|stockpiles?|stocks)\b/i;
const INV_DRAW = /\b(draws?|fall|falls|fell|drop|drops|dropped|decline\w*|plunge\w*)\b/i;
const INV_BUILD = /\b(builds?|rise|rises|rose|climb\w*|jump\w*|increase\w*|swell\w*)\b/i;

const WAR = /\b(air ?strikes?|missiles?|rockets?|drones?|bomb\w*|invad\w*|invasion|war|wars|military|troops|shelling|attacks?|attacked|strikes? (on|against|in)|struck|retaliat\w*|escalat\w*)\b/i;
const WAR_ACT = /\b(air ?strikes?|missile (strike|attack)s?|missiles? (hit|hits|fired|launched|strike|strikes)|fires? missiles|launch(es|ed)? missiles|rockets? (hit|hits|fired)|drone (strike|attack)s?|bomb(s|ing|ed|ings)?|invad\w*|invasion|attacks?|attacked|strikes? (on|against|in)|struck|shelling|retaliat\w*|seiz(es|ed) (a )?(tanker|ship|vessel)|war breaks out|go(es)? to war|went to war)\b/i;
const STRAIT = /\b(hormuz|red sea|strait)\b/i;
const CLOSE = /\b(close|closes|closed|closure|block\w*|blockade)\b/i;
const REOPEN = /\b(reopen\w*|lift\w*|ends?|ended|eases?|eased|easing|returns?|returned|resum\w*|recover\w*|normal\w*|pre-war)\b/i;
const REACTION = /\b(condemns?|condemned|criticiz\w*|slams?|blasts?|denounc\w*|blames?|accus\w*)\b/i;
const NOT_MILITARY = /\b(economic|financial|trade|tariff|cyber|verbal|political|legal|rhetorical|media)\s+(attacks?|war|warfare|strikes?)\b|\battacks? on (the )?(free )?(press|media|democracy|journalists)\b/gi;
const OIL_SITE = /\b(refiner\w*|oil (facility|facilities|terminal|port|depot|field|infrastructure)|pipelines?|tankers?|oilfields?|aramco|export terminal)\b/i;
// « Israel strikes Iran », « US hits Houthi targets » : un verbe d'attaque suivi d'un lieu (« strikes » seul = grèves).
const HITS_PLACE = /\b(strikes?|struck|hits?|targets?|targeted|pounds?|pounded|bombs?|bombed)\s+(?:on\s+)?(?:the\s+)?(iran\w*|tehran|israel\w*|saudi\w*|houthis?|yemen\w*|taiwan\w*|syria\w*|lebanon|hezbollah|gaza|riyadh|gulf|ukrain\w*|kyiv|russia\w*|moscow)\b(?!-)/i;
// Justice, police, manifestations, réseaux financiers visés : pas une frappe militaire.
const NOT_STRIKE = /\b(execut(es|ed|ion)|protest\w*|police|court|trial|sentenc\w*|financial network|money laundering|smuggling (ring|network))\b/i;
const HOT_ZONE = /\b(iran\w*|hormuz|saudi\w*|houthis?|red sea|taiwan\w*|nato|nuclear|tehran|riyadh|gulf)\b/i;
const NEW_WAR = /\b(declares? war|invades|invaded|invasion of|launch(es|ed)? (a )?(military|ground) (operation|offensive)|nuclear (strike|attack|test))\b/i;
const ONGOING = /\b(ukrain\w*|russia\w*|kyiv|moscow|gaza|israel\w*|lebanon|hezbollah|hamas|syria\w*|yemen|sudan|kashmir|pakistan|india|north korea\w*|pyongyang)\b/i;
// Démonstrations de force sans attaque : exercices, déploiements, programme nucléaire.
const POSTURE = /\b(military drills?|drills|war ?games|exercises|mobiliz\w*|deploys?|deployed|warships?|aircraft carriers?|carrier strike group|(sends?|sending|sent|mass(es|ing)?|amass\w*) (\w+ )?([\d,]+ )?(troops|marines|soldiers)|ballistic missiles?|missile tests?|nuclear (program|programme|enrichment|site|sites|weapons?|facility|facilities)|uranium|enrichment|intercept\w*|shoots? down|shot down|airspace)\b/i;
const DIPLOMACY = /\b(talks|negotiations?|deal|tensions?|envoy|summit|diplomat\w*)\b/i;
const ATTACK_ANY = /\b(attacks?|attacked|struck|hits?|hit by|targets?|targeted|targeting|drones?|missiles?|rockets?|explosions?|blasts?|strikes? on|air ?strikes?|sabotage\w*|ablaze|on fire|fire at)\b/i;
const CYBER = /\b(cyber\w*|hack\w*)\b/i;
const CEASE = /\b(ceasefire|cease-fire|truce|peace (deal|talks|agreement|plan))\b/i;
const SANCTIONS = /\bsanction(s|ed|ing)?\b/i;
const OIL_SANCTION = /\b(oil|crude|tankers?|shadow fleet|rosneft|lukoil|gazprom|energy|lng|petroleum)\b/i;
const TARIFF = /\b(tariffs?|trade war|export controls?|trade deal|trade truce)\b/i;
const TARIFF_EASE = /\b(deal|truce|pause\w*|delay\w*|exempt\w*|lift\w*|remov\w*|cut|cuts|lower\w*|eases?|eased|suspend\w*)\b/i;
// Une menace de droits de douane (« Trump threatens to double tariffs ») : souvent sans suite, pas encore une mesure.
const TARIFF_THREAT = /\b(threat\w*|warns?|warned|ready to|prepared to|if)\b/i;
const TARIFF_NEW = /\b(impos\w*|slaps?|announc\w*|raises?|hikes?|new (\w+ ){0,2}(tariffs?|duties|levies)|retaliat\w*|doubles?|triples?|takes? effect|took effect)\b/i;

const RECAP = /\b(roundup|recap|weekly|this week|last week|this year|so far|in 20\d\d|since 20\d\d|report|reports|analysis|total|record year|h1|q[1-4]|first half|annual|monthly|quarterly|(this|last|past|first|second|third|fourth|monster|record|strong|weak|brutal|best|worst) quarter|in (january|february|march|april|may|june|july|august|september|october|november|december)|(past|last) (week|month|year|\d+ (days|weeks|months)))\b/i;
// Suite d'un piratage connu : remboursement, enquête, pirate qui déplace le butin (« Hacker turns to Zcash privacy pool »),
// plan pour combler le trou.
const FOLLOW_UP = /\b(recover\w*|refund\w*|reimburs\w*|compensat\w*|returns? (the )?(stolen )?funds|returned|bounty|ultimatum|identif\w*|arrest\w*|extradit\w*|sentenc\w*|indict\w*|pleads?|guilty|charged|launder\w*|post-?mortem|anniversary|privacy pools?|mixers?|tornado cash|(hacker|exploiter|attacker)s?\W+(turns?|moves?|moved|swaps?|swapped|bridges?|bridged|sends?|sent|sells?|sold|dumps?|dumped|converts?|converted|deposits?|deposited)|plugs?|plugged|plugging|shortfall|bad debt|hole left|trac(e|es|ed|ing)|attribut\w*|linked to|links? (\$[\d.,]+\w* )?\w* ?(hack|theft|exploit)|north korea\w*|dprk|lazarus|frozen|freez\w*|rollback|explains?|lessons?|pattern|where did|after (the |a |its )?(\$[\d.,]+\s?(m|b|bn|million|billion)?\s)?(hack|exploit|heist|theft))\b/i;
const HACK_TARGET = /\b(protocol|exchange|bridge|wallets?|dex|vault|lending|funds|drained|stolen|users?|hackers?|attackers?|exploiters?|exploit)\b/i;
const SOCIAL_HACK = /\b(x|twitter|instagram|youtube|discord|telegram|social media|facebook)\s+(accounts?|page|channel|server)\b.{0,20}\b(hack\w*|compromised)|\baccount (was |is )?(hacked|compromised)\b/i;
const BIG_EXCHANGE = /\b(binance|coinbase|kraken|okx|bybit|bitget|upbit|bithumb|kucoin|gemini|bitfinex|htx|gate\.?io|mexc|crypto\.com|robinhood|hyperliquid)\b/i;
const HACK = /\b(hack|hacks|hacked|hacker|hackers|hacking|exploit|exploits|exploited|exploiter|drained|draining|stolen|heist|attacker|attackers)\b/i;

const ETF = /\bet[fp]s?\b/i;
// Produits à levier ou à revenu : de nouveaux produits, sans argent frais pour le marché au comptant.
const ETF_NICHE = /\b(leveraged|[2-5]x|inverse|covered[- ]call|income|tokeni[sz]ed)\b/i;
const ETF_UP = /\b(inflows?|net (buying|inflows?)|attract\w*|record demand|approv\w*|launch\w*|debut\w*|green[- ]?light\w*|lists?|listed)\b/i;
const ETF_DOWN = /\b(outflows?|exits?|exited|bleed\w*|withdraw\w*|reject\w*|denied|denies|delay\w*|pulls?|redemptions?)\b/i;
const ETF_EVENT = /\b(approv\w*|reject\w*|denied|launch\w*|debut\w*|green[- ]?light\w*)\b/i;

const REG = /\b(sec|cftc|regulat\w*|pardon\w*|lawsuit|sues?|sued|suing|charges?|charged|ban|bans|banned|banning|bill|legislation|congress|senate|law|laws|mica|genius act|clarity act|approv\w*|reject\w*|fines?|fined|settle\w*|crackdown|enforcement|license|licence|lawmakers|white house|executive order)\b/i;
const REG_POS = /\b(approv\w*|pardon\w*|pass(es|ed)|signs?|signed|clears?|cleared|dismiss\w*|drops? (its |the )?(case|lawsuit|charges|probe)|ends? (its |the )?(case|probe|lawsuit)|wins?|won|green[- ]?light\w*|legaliz\w*|license granted|grants?|licen[cs]e)\b/i;
const REG_NEG = /\b(sues?|sued|suing|charges?|charged|ban|bans|banned|banning|crackdown|fines?|fined|penalt\w*|reject\w*|probe\w*|investigat\w*|subpoena\w*|arrest\w*|seiz\w*|halts?|restrict\w*)\b/i;
const REGULATOR = /\b(sec|cftc|occ|fdic|fed|federal reserve|treasury (department|secretary)|u\.?s\.? treasury|irs|doj|justice department|fbi|congress|senate|house|lawmakers|regulators?|court|judge|government|president|trump|white house|governor|state|eu|european|parliament|commission|esma|fca|mas|authorit\w*|ministry|minister|central bank|police|prosecutors?)\b/i;
const REG_STRONG = /\b(sues?|sued|charges?|charged|ban|bans|banned|approv\w*|pass(es|ed)|signs?|signed|law|dismiss\w*|arrest\w*|executive order|pardon\w*|drops? (its |the )?(case|lawsuit|charges|probe)|ends? (its |the )?(case|probe|lawsuit))\b/i;

const HOLDER = /\b(strategy|microstrategy|saylor|metaplanet|tesla|semler|gamestop|trump media|bitmine|sharplink|treasury (company|firm)|foundation|government|el salvador|bhutan|mt\.? ?gox|blackrock|fidelity|grayscale)\b/i;
const BUYS = /\b(buys?|bought|acquires?|acquired|adds?|added|purchases?|purchased|accumulat\w*|scoops? up)\b/i;
const SELLS = /\b(sells?|sold|dumps?|dumped|offloads?|offloaded|unloads?|liquidat\w*)\b/i;

const up = (...assets) => assets.map(a => [a, 1]);
const down = (...assets) => assets.map(a => [a, -1]);

// L'action principale d'un titre est la première citée (« Fed cuts rates, holds door open… » = baisse).
const rateAction = t => firstAction(t.replace(RATE_NOUNS, ' '), { cut: RATE_CUT, hike: RATE_HIKE, hold: RATE_HOLD });
function firstAction(t, actions) {
  let best = null, at = Infinity;
  for (const [name, re] of Object.entries(actions)) {
    const m = t.match(re);
    if (m && m.index < at) { at = m.index; best = name; }
  }
  return best;
}

// Chaque règle renvoie { theme, importance, impacts, why } ou null. La première qui répond l'emporte.
const RULES = [
  ['guerre', t => {
    if (CEASE.test(t) || CYBER.test(t) || REACTION.test(t) || NOT_STRIKE.test(t)) return null;
    const military = t.replace(NOT_MILITARY, ' ');
    if (SANCTIONS.test(t) && !WAR_ACT.test(military)) return null; // « US sanctions target Iran's auto sector »
    t = military;
    const blockade = HOT_ZONE.test(t) && STRAIT.test(t) && CLOSE.test(t) && !REOPEN.test(t);
    if (!(((WAR_ACT.test(t) || HITS_PLACE.test(t)) && HOT_ZONE.test(t)) || NEW_WAR.test(t) || blockade)) return null;
    const threat = UNCERTAIN.test(t) || THREAT.test(t) || /\b(despite|amid|in spite of)\b/i.test(t); // « despite attacks » : le contexte
    return {
      theme: 'geo', importance: threat ? 'medium' : 'critical', impacts: [...up('Pétrole', 'Or'), ...down('BTC')],
      why: threat ? "Menace d'escalade dans une zone clé (Golfe, Iran, Taïwan…) : si elle se concrétise, le pétrole et l'or montent souvent et les cryptos baissent."
        : "Escalade militaire dans une zone clé (Golfe, Iran, Taïwan…) : le pétrole et l'or montent souvent, les cryptos baissent.",
    };
  }],
  ['infra-petrole', t => {
    if (!(ATTACK_ANY.test(t) && OIL_SITE.test(t)) || CYBER.test(t)) return null;
    return {
      theme: 'geo', importance: 'medium', impacts: up('Pétrole'),
      why: 'Attaque contre des installations pétrolières : l\'offre est menacée, le prix du pétrole monte souvent.',
    };
  }],
  ['taux-surprise', t => {
    if (!(MAJOR_CB.test(t) && SURPRISE.test(t) && RATEWORD.test(t)) || UNCERTAIN.test(t) || PREVIEW.test(t)) return null;
    const act = rateAction(t);
    return {
      theme: 'cb', importance: 'critical', impacts: act === 'cut' ? up('BTC', 'Or') : act === 'hike' ? down('BTC') : [],
      why: 'Décision de taux inattendue : tous les marchés bougent d\'un coup, cryptos comprises.',
    };
  }],
  ['opep', t => {
    if (!(OPEC.test(t) && OUTPUT.test(t))) return null;
    const bull = (PAUSE.test(t) && OUT_RAISE.test(t)) || (!PAUSE.test(t) && OUT_CUT.test(t));
    const bear = !PAUSE.test(t) && !OUT_CUT.test(t) && OUT_RAISE.test(t);
    const sure = DECIDED.test(t) && !UNCERTAIN.test(t) && (bull || bear);
    return {
      theme: 'energy', importance: sure ? 'critical' : 'medium', impacts: bull ? up('Pétrole') : bear ? down('Pétrole') : [],
      why: bull ? "Moins de pétrole sur le marché : le prix a tendance à monter."
        : bear ? "Plus de pétrole sur le marché : le prix a tendance à baisser."
          : "L'OPEP+ décide de la quantité de pétrole produite : ses annonces font bouger le prix.",
    };
  }],
  ['hack', (t, ctx) => {
    if (!HACK.test(t) || !(CRYPTO.test(t) || ctx.crypto) || ETF.test(t) || /\b(inflows?|outflows?|liquidity)\b/i.test(t)) return null;
    const amt = amountUsd(t);
    // Dans un média crypto, un titre sans mot crypto ni montant (« AI models that hacked their way out of a test »)
    // ne parle pas d'un vol de fonds.
    if (!CRYPTO.test(t) && amt === null && !HACK_TARGET.test(t)) return null;
    const social = SOCIAL_HACK.test(t); // compte X ou Discord piraté : arnaque passagère, pas de fonds volés
    const tk = tokensIn(t);
    const recap = RECAP.test(t); // bilan des piratages, pas un nouveau piratage
    const followUp = FOLLOW_UP.test(t) || /\?\s*$/.test(t); // suite d'un piratage déjà connu : remboursement, pirate identifié, analyse…
    // Sans montant, seul le piratage d'un grand exchange compte d'emblée (le montant arrive souvent plus tard).
    let importance = recap || social ? 'low' : amt >= NEWS.hackCriticalUsd ? 'critical' : amt >= NEWS.hackMediumUsd || (amt === null && BIG_EXCHANGE.test(t)) ? 'medium' : 'low';
    // La suite d'un piratage déjà connu (traque des fonds, auteur identifié, remboursement) : le marché a déjà réagi.
    if (followUp) importance = 'low';
    const victim = tk.length ? tk : /\b(defi|protocol|lending|dex|bridge|vault|yield)\b/i.test(t) ? ['DeFi'] : ['Crypto'];
    return {
      theme: 'hack', importance, amountUsd: amt,
      impacts: importance === 'critical' ? down(...victim) : [],
      why: recap ? 'Bilan des piratages : le risque reste élevé dans la DeFi.'
        : social ? 'Compte de réseau social piraté : méfie-toi des liens qu\'il publie, mais pas de fonds volés.'
        : followUp ? 'Suite d\'un piratage : à suivre si tu as des fonds sur ce protocole ou cet exchange.'
          : importance === 'critical' ? 'Gros piratage : les pirates revendent souvent le butin, et la confiance dans tout le secteur en prend un coup.'
            : 'Piratage : vérifie que tu n\'as pas de fonds sur ce protocole.',
    };
  }],
  ['taux', (t, ctx) => {
    // Tout ce qui touche la Fed est gardé (nominations, indépendance, discours), au moins en faible importance.
    const official = Boolean(ctx.prefix) && /\bdecisions?\b/i.test(t) && !/\bin addition to\b/i.test(t); // communiqué « Monetary policy decisions » de la BCE
    if (!(CBANK.test(t) && (RATEWORD.test(t) || DECISION.test(t) || official)) && !FED.test(t)) return null;
    const decided = (DECISION.test(t) || official) && !UNCERTAIN.test(t) && !PREVIEW.test(t);
    const act = decided ? rateAction(t) : null;
    // Seule la Fed fait vraiment bouger les cryptos ; les autres banques centrales sont affichées sans flèche.
    const fed = FED.test(t);
    const bank = fed ? 'fed' : /\b(ecb|lagarde)\b/i.test(t) ? 'ecb' : /\b(bank of england|boe)\b/i.test(t) ? 'boe' : /\b(bank of japan|boj|ueda)\b/i.test(t) ? 'boj' : null;
    return {
      theme: 'cb', importance: decided && MAJOR_CB.test(t) ? 'medium' : 'low', key: decided && bank ? `taux-${bank}` : null,
      impacts: fed && act === 'cut' ? up('BTC', 'Or') : fed && act === 'hike' ? down('BTC') : [],
      why: act === 'cut' ? "Baisse des taux : l'argent coûte moins cher, ce qui aide les actifs à risque comme les cryptos."
        : act === 'hike' ? "Hausse des taux : l'argent coûte plus cher, ce qui pèse sur les actifs à risque comme les cryptos."
          : act === 'hold' ? 'Taux inchangés : le marché va surtout regarder le discours sur les prochaines décisions.'
            : 'Les banques centrales fixent le prix de l\'argent : chaque prise de parole peut faire bouger les marchés.',
    };
  }],
  ['inflation', t => {
    const rel = dataRelease(t);
    if (!rel && !INFLATION.test(t)) return null;
    const us = (!FOREIGN.test(t) || USA.test(t)) && !US_LOCAL.test(t);
    const release = Boolean(rel) && us && !PREVIEW.test(t);
    const labor = /unemployment|jobless/.test(rel?.what ?? '');
    const jobs = labor || /payrolls|nfp|jobs|job /.test(rel?.what ?? '');
    const verb = rel?.verb ?? '';
    const dir = UP_ANY.test(verb) ? 1 : DOWN.test(verb) ? -1 : 0;
    const vs = t.match(VS_EXPECTED)?.[1].toLowerCase();
    // > 0 : économie ou inflation plus forte, la Fed baissera ses taux moins vite. Chômage en hausse : l'inverse.
    const heat = labor ? -dir
      : HOT_WORDS.test(t) !== COOL_WORDS.test(t) ? (HOT_WORDS.test(t) ? 1 : -1)
        : vs && dir ? (vs === 'more' ? dir : -dir)
          : UP_STRONG.test(verb) ? 1 : DOWN.test(verb) ? -1 : 0;
    const bearish = release && heat > 0, bullish = release && heat < 0;
    return {
      theme: 'cb', importance: release ? 'medium' : 'low', impacts: bullish ? up('BTC') : bearish ? down('BTC') : [],
      key: release ? dataKey(rel.what, t) : null,
      why: bearish ? `${jobs ? 'Emploi américain solide' : 'Inflation américaine en hausse'} : la Fed baissera ses taux moins vite, ce qui pèse sur les cryptos.`
        : bullish ? `${jobs ? 'Emploi américain qui ralentit' : 'Inflation américaine en baisse'} : la Fed pourra baisser ses taux plus vite, ce qui aide les cryptos.`
          : 'Inflation et emploi décident du rythme des baisses de taux de la Fed.',
    };
  }],
  ['droits-de-douane', t => {
    if (!TARIFF.test(t)) return null;
    const negated = NEGATED.test(t);
    const ease = !negated && (/\b(deal|truce|agreement)\b/i.test(t) || (TARIFF_EASE.test(t) && !TARIFF_NEW.test(t)));
    const tough = !negated && !ease && TARIFF_NEW.test(t);
    return {
      theme: 'geo', importance: usActor(t) && MAJOR_TRADE.test(t) && (ease || tough) && !UNCERTAIN.test(t) && !PREVIEW.test(t) && !REQUEST.test(t) && !TARIFF_THREAT.test(t) ? 'medium' : 'low', impacts: ease ? up('BTC') : tough ? down('BTC') : [],
      why: tough ? 'Nouveaux droits de douane : les marchés à risque, cryptos comprises, baissent souvent.'
        : ease ? 'Apaisement commercial : bon signe pour les marchés à risque, cryptos comprises.'
          : 'Les guerres commerciales font bouger tous les marchés à risque.',
    };
  }],
  ['sanctions', t => {
    if (!SANCTIONS.test(t)) return null;
    const oil = OIL_SANCTION.test(t);
    const act = /\b(impos\w*|new|slaps?|announc\w*|targets?|targeted|expands?|tightens?|widens?|hits?|additional|fresh|lifts?|lifted|eases?|eased)\b/i.test(t)
      && !/\b(despite|risks?|evad\w*|evasion|skirt\w*|circumvent\w*|bypass\w*|dodg\w*)\b/i.test(t);
    return {
      theme: 'geo', importance: oil && act ? 'medium' : 'low', impacts: oil ? up('Pétrole') : [],
      why: oil ? 'Des sanctions sur un pays producteur peuvent réduire l\'offre de pétrole.' : 'Nouvelles sanctions internationales.',
    };
  }],
  ['cessez-le-feu', t => {
    const reopen = STRAIT.test(t) && REOPEN.test(t) && /\b(oil|crude|tankers?|shipping|exports?|traffic|blockade)\b/i.test(t);
    if (!(CEASE.test(t) || reopen) || !(HOT_ZONE.test(t) || ONGOING.test(t))) return null;
    const hot = HOT_ZONE.test(t);
    return {
      theme: 'geo', importance: hot ? 'medium' : 'low', impacts: hot ? down('Pétrole', 'Or') : [],
      why: 'Baisse des tensions : le pétrole et l\'or perdent souvent une partie de leur prime de risque.',
    };
  }],
  ['tensions', t => {
    if (!HOT_ZONE.test(t) || !(POSTURE.test(t) || DIPLOMACY.test(t) || THREAT.test(t))) return null;
    // Une déclaration (« Zelensky warns », « …: Donald Trump ») n'est pas un mouvement de troupes.
    const said = /\b(says?|said|claims?|warns?|warned|vows?|accuses?)\b|:\s*[\w. ]{3,30}$/i.test(t);
    const posture = POSTURE.test(t) && !DIPLOMACY.test(t) && !said && !REACTION.test(t);
    return {
      theme: 'geo', importance: posture ? 'medium' : 'low', impacts: [],
      why: posture ? "Tensions militaires dans une zone clé : une escalade ferait monter le pétrole et l'or."
        : "Diplomatie et menaces dans une zone clé (Golfe, Iran, Taïwan…) : à suivre pour le pétrole et l'or.",
    };
  }],
  ['etf', t => {
    if (!(ETF.test(t) && CRYPTO.test(t))) return null;
    const amt = amountUsd(t);
    const tk = tokensIn(t);
    const assets = tk.length ? tk : ['Crypto'];
    const isUp = ETF_UP.test(t) && !ETF_DOWN.test(t), isDown = ETF_DOWN.test(t) && !ETF_UP.test(t);
    return {
      theme: 'etf', importance: ((amt >= NEWS.etfMediumUsd && !RECAP.test(t)) || ETF_EVENT.test(t)) && !ETF_NICHE.test(t) ? 'medium' : 'low', amountUsd: amt,
      impacts: isUp ? up(...assets) : isDown ? down(...assets) : [],
      why: isUp ? 'Argent qui entre dans les ETF : les fonds doivent acheter les cryptos correspondantes.'
        : isDown ? 'Argent qui sort des ETF : les fonds revendent les cryptos correspondantes.'
          : 'Les ETF crypto sont la porte d\'entrée des investisseurs traditionnels.',
    };
  }],
  ['regulation', t => {
    if (!(REG.test(t) && CRYPTO.test(t))) return null;
    const pos = REG_POS.test(t) && !REG_NEG.test(t), neg = REG_NEG.test(t) && !REG_POS.test(t);
    const amt = amountUsd(t);
    const small = neg && amt !== null && amt < NEWS.regCaseMediumUsd; // « SEC sues crypto AI platform over $12.5M »
    // « Bank group sues OCC over crypto charters » : c'est le régulateur qui est attaqué, la règle ne change pas.
    const againstRegulator = /\b(sues?|sued|suing|challeng\w*)\s+(the\s+)?(u\.?s\.?\s+)?(occ|sec|cftc|fdic|fed|irs|treasury|regulators?|government|agency)\b/i.test(t);
    const strong = REG_STRONG.test(t) && REGULATOR.test(t) && !UNCERTAIN.test(t) && !small && !againstRegulator;
    return {
      theme: 'reg', importance: strong ? 'medium' : 'low', impacts: strong && pos ? up('Crypto') : strong && neg ? down('Crypto') : [],
      why: pos ? 'Feu vert des autorités : bon signe pour l\'adoption des cryptos.'
        : small ? 'Poursuite contre une seule société : peu d\'effet sur le marché.'
          : neg ? 'Action des autorités contre le secteur : peut faire peur aux investisseurs.'
            : 'Les règles du jeu pour les cryptos évoluent.',
    };
  }],
  ['gros-detenteur', t => {
    const tk = tokensIn(t);
    if (!tk.length || !HOLDER.test(t) || ETF.test(t)) return null;
    const buy = BUYS.test(t) && !SELLS.test(t), sell = SELLS.test(t) && !BUYS.test(t);
    if (!buy && !sell) return null;
    const amt = amountUsd(t);
    const importance = amt >= NEWS.whaleMediumUsd ? 'medium' : 'low';
    return {
      theme: 'whale', importance, amountUsd: amt, impacts: buy ? up(tk[0]) : down(tk[0]),
      why: buy ? 'Un gros détenteur connu achète : de la demande en plus sur le marché.'
        : 'Un gros détenteur connu vend : autant de tokens en plus à absorber par le marché.',
    };
  }],
  ['stocks-petrole', t => {
    if (!(INVENTORY.test(t) && /\b(crude|oil|gasoline|eia|api|distillate)\b/i.test(t))) return null;
    const draw = INV_DRAW.test(t) && !INV_BUILD.test(t), build = INV_BUILD.test(t) && !INV_DRAW.test(t);
    return {
      theme: 'energy', importance: 'low', impacts: draw ? up('Pétrole') : build ? down('Pétrole') : [],
      why: draw ? 'Stocks de pétrole en baisse aux États-Unis : signe de demande, plutôt haussier pour le prix.'
        : build ? 'Stocks de pétrole en hausse aux États-Unis : signe de demande faible, plutôt baissier pour le prix.'
          : 'Les stocks américains de pétrole donnent la tendance de la demande.',
    };
  }],
  ['energie', t => {
    if (!(OPEC.test(t) || (OIL.test(t) && MARKET_MOVE.test(t)))) return null;
    return { theme: 'energy', importance: 'low', impacts: [], why: 'Actualité du pétrole, du gaz et de l\'or.' };
  }],
  ['conflit', t => {
    if (!((WAR_ACT.test(t) || WAR.test(t) || HITS_PLACE.test(t)) && (ONGOING.test(t) || HOT_ZONE.test(t)))) return null;
    return { theme: 'geo', importance: 'low', impacts: [], why: 'Conflit en cours : effet limité sur les marchés tant qu\'il ne s\'étend pas.' };
  }],
];

// Projets du top 25 cités dans le titre (nom complet, ou ticker précédé de $).
export function matchProject(text, projects, crypto) {
  for (const p of projects || []) {
    const name = String(p.name || '');
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (p.symbol && p.symbol.length >= 2 && new RegExp(`\\$${esc(p.symbol)}\\b`).test(text)) return p;
    if (name.includes(' ') && name.length >= 6 && new RegExp(`\\b${esc(name)}\\b`, 'i').test(text)) return p;
    // Un nom d'un seul mot (« Lighter », « Bankr ») n'est cherché que dans les médias crypto, en respectant les majuscules.
    if (crypto && !name.includes(' ') && name.length >= 5 && new RegExp(`\\b${esc(name)}\\b`).test(text)) return p;
  }
  return null;
}

// Classe un titre. `ctx.crypto` : la source est un média crypto. `ctx.prefix` : précise l'émetteur (ex. « ECB »).
export function classify(title, ctx = {}) {
  const text = ctx.prefix ? `${ctx.prefix} ${title}` : title;
  if (PROMO.test(text)) return null;
  const project = matchProject(title, ctx.projects, ctx.crypto);
  for (const [rule, fn] of RULES) {
    const hit = fn(text, ctx);
    if (!hit) continue;
    if (commentary(text)) hit.importance = 'low'; // prévision, analyse, fil en direct : gardé mais en faible importance
    if (ctx.theme && hit.theme !== ctx.theme && hit.importance === 'low') continue;
    // Sur une news de faible importance, la flèche serait surtout du bruit.
    const impacts = hit.importance === 'low' && rule !== 'stocks-petrole' ? [] : hit.impacts;
    return { rule, ...hit, impacts, projectId: project?.id ?? null };
  }
  if (project) {
    return {
      rule: 'projet', theme: 'project', importance: commentary(text) ? 'low' : 'medium', impacts: [], projectId: project.id,
      why: `${project.name} fait partie du top 25 de l'onglet Projets (n°${project.rank}).`,
    };
  }
  if (ctx.theme) return { rule: 'source', theme: ctx.theme, importance: 'low', impacts: [], why: ctx.why || '', projectId: null };
  return null;
}

// ---------- Baleines (Whale Alert) ----------

const EXCHANGES = /^(binance(us)?|coinbase( institutional)?|kraken|bitfinex|okx|okex|bybit|bitget|htx|huobi|kucoin|gemini|bitstamp|crypto\.?com|gate\.?io|mexc|upbit|bithumb|robinhood|bitso|deribit|bitmex|poloniex|bitflyer|bitvavo|bingx|whitebit|hyperliquid)$/i;

const place = s => {
  const name = String(s || '').replace(/#/g, '').trim();
  if (/unknown/i.test(name)) return { name: 'un portefeuille inconnu', exchange: false, known: false };
  return { name, exchange: EXCHANGES.test(name), known: true };
};

export function parseWhale(text) {
  const line = String(text).split('\n').find(l => /\(\s*[\d,.]+\s*USD\s*\)/i.test(l))?.replace(/\s+details\s*$/i, '');
  const m = line?.match(/([\d][\d,.]*)\s+[#$]?([A-Za-z0-9]+)\s*\(\s*([\d,.]+)\s*USD\s*\)\s+(transferred|minted|burned|burnt)\b(.*)$/i);
  if (!m) return null;
  const qty = Number(m[1].replace(/,/g, '')), token = m[2].toUpperCase(), usd = Number(m[3].replace(/,/g, ''));
  const action = m[4].toLowerCase().replace('burnt', 'burned');
  const route = m[5].match(/from\s+(.+?)\s+to\s+(.+?)\s*$/i);
  const at = m[5].match(/\bat\s+(.+?)\s*$/i)?.[1]?.replace(/#/g, '').trim() ?? null;
  return { qty, token, usd, action, from: route ? place(route[1]) : null, to: route ? place(route[2]) : null, at };
}

// Transforme un message Whale Alert en news (titre en français, impact probable).
export function whaleNews(w, projects = []) {
  if (!w || !(w.usd >= NEWS.whaleMinUsd)) return null;
  const stable = STABLES.has(w.token);
  const top = (projects || []).find(p => String(p.symbol || '').toUpperCase() === w.token);
  // Pour un stablecoin, la quantité vaut déjà le montant en dollars.
  const what = stable ? `${fmtQty(w.qty)} ${w.token}` : `${fmtQty(w.qty)} ${w.token} (${fmtUsd(w.usd)})`;
  let title, why, impacts = [];
  if (w.action === 'minted') {
    title = `${what} créés${w.at ? ` par ${w.at}` : ''}`;
    if (stable) { impacts = up('Crypto'); why = 'De nouveaux stablecoins créés : de l\'argent frais prêt à acheter des cryptos.'; } else why = 'Création de nouveaux tokens.';
  } else if (w.action === 'burned') {
    title = `${what} détruits${w.at ? ` par ${w.at}` : ''}`;
    why = stable ? 'Des stablecoins retirés de la circulation : un peu moins de liquidités sur le marché.' : 'Tokens retirés de la circulation.';
  } else if (w.from && w.to) {
    const from = /^[aeiouyàâéèêîô]/i.test(w.from.name) ? `d'${w.from.name}` : `de ${w.from.name}`;
    title = `${what} envoyés ${from} vers ${w.to.name}`;
    // « de Binance vers Binance Beacon Deposit » : l'exchange déplace ses propres fonds (staking, portefeuille froid).
    const firstWord = p => p.name.split(/\s+/)[0].toLowerCase();
    if (w.from.known && w.to.known && firstWord(w.from) === firstWord(w.to)) why = 'Transfert interne à un exchange : ni achat ni vente.';
    else if (w.to.exchange && !w.from.exchange) {
      if (stable) { impacts = up('Crypto'); why = 'Des stablecoins arrivent sur un exchange : souvent pour acheter des cryptos.'; } else { impacts = down(w.token); why = 'Gros dépôt sur un exchange : souvent le signe d\'une vente à venir.'; }
    } else if (w.from.exchange && !w.to.exchange) {
      if (!stable) { impacts = up(w.token); why = 'Gros retrait d\'un exchange : l\'acheteur garde ses tokens, moins d\'offre à vendre.'; } else why = 'Des stablecoins quittent un exchange.';
    } else why = 'Gros transfert entre deux portefeuilles.';
  } else return null;
  // Sans sens clair (entre portefeuilles inconnus, interne à un exchange), un transfert n'apprend rien sur le marché
  // en dessous de 1 Md$ : il en passe des dizaines par jour.
  const bar = !impacts.length ? NEWS.whaleQuietMediumUsd : stable ? NEWS.whaleStableMediumUsd : NEWS.whaleMediumUsd;
  const importance = w.usd >= bar || top ? 'medium' : 'low';
  return {
    theme: 'whale', importance, impacts: importance === 'low' ? [] : impacts, why, title,
    amountUsd: w.usd, projectId: top?.id ?? null, rule: 'baleine',
  };
}

// ---------- Regroupement des doublons ----------

const STOP = new Set(('the a an and or of to in on for with at by from as is are was were be been after before over under amid says said say '
  + 'will would could may might its it this that than into about up down new more most via per just now how why what who amid against').split(' '));
const ENTITY = {
  fed: 'fed', fomc: 'fed', federal: 'fed', powell: 'fed', ecb: 'ecb', lagarde: 'ecb', boj: 'boj', boe: 'boe', opec: 'opec',
  sec: 'sec', cftc: 'cftc', bitcoin: 'btc', btc: 'btc', ether: 'eth', ethereum: 'eth', eth: 'eth', solana: 'sol', xrp: 'xrp',
  iran: 'iran', israel: 'israel', russia: 'russia', ukraine: 'ukraine', china: 'china', taiwan: 'taiwan', gold: 'gold', oil: 'oil', crude: 'oil', gas: 'gas',
};

export function words(title) {
  return new Set(String(title).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9$%+ ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w))
    .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)));
}

const entities = ws => new Set([...ws].map(w => ENTITY[w]).filter(Boolean));

export function similar(a, b) {
  const A = a.words ?? words(a.titleEn), B = b.words ?? words(b.titleEn);
  const ea = entities(A), eb = entities(B);
  if (ea.size && eb.size && ![...ea].some(e => eb.has(e))) return false; // ex. « Fed holds rates » ≠ « ECB holds rates »
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return inter >= 3 && (inter / union >= 0.4 || inter / Math.min(A.size, B.size) >= 0.7);
}

const rank = i => i.rank ?? 1;

// Une news critique venue d'un seul petit média reste « moyenne » tant qu'une agence, une source officielle
// ou un deuxième média ne l'a pas confirmée : évite un bandeau rouge sur une rumeur.
function confirmed(level, nSources, members) {
  if (level !== 'critical') return level;
  return nSources >= 2 || members.some(m => rank(m) >= 2) ? 'critical' : 'medium';
}

// Regroupe les news qui parlent de la même chose (même jour, mots en commun). Les anciennes news passent en premier
// pour garder leur identifiant, leur heure et leur traduction.
export function cluster(items) {
  const groups = [];
  for (const it of items) {
    it.words ??= words(it.titleEn);
    const g = it.kind === 'whale' ? null
      : groups.find(c => c.kind !== 'whale' && Math.abs(c.time - it.time) <= 24 * HOUR
        && c.members.some(m => similar(m, it) || (it.key && m.key === it.key && Math.abs(m.time - it.time) <= 12 * HOUR)));
    if (g) { g.members.push(it); g.time = Math.min(g.time, it.time); } else groups.push({ kind: it.kind, time: it.time, members: [it] });
  }
  return groups.map(({ members }) => {
    const raw = m => m.raw ?? m.importance;
    // Le titre affiché vient de la news qui a donné l'importance (sinon un bandeau « critique » sur un titre anodin),
    // puis de la source la plus fiable.
    const top = [...members].sort((a, b) => LEVEL[raw(b)] - LEVEL[raw(a)] || rank(b) - rank(a) || a.time - b.time)[0];
    const key = members.map(m => m.key).find(Boolean);
    const sources = []; // noms des médias, sans doublon
    for (const m of members) {
      for (const name of m.sources ?? [m.source]) if (name && !sources.includes(name)) sources.push(name);
    }
    return {
      id: members[0].id,
      // Identifiants de toutes les news regroupées : elles ne sont plus rajoutées aux mises à jour suivantes.
      ids: [...new Set(members.flatMap(m => m.ids ?? [m.id]))].slice(-40),
      time: Math.min(...members.map(m => m.time)),
      title: top.title ?? null, titleEn: top.titleEn, lang: top.lang ?? 'en',
      link: top.link, source: top.source ?? top.sources?.[0] ?? null,
      sources: sources.slice(0, 12), count: Math.max(sources.length, ...members.map(m => m.count ?? 0)),
      theme: top.theme, raw: raw(top), importance: confirmed(raw(top), sources.length, members), impacts: top.impacts, why: top.why, rule: top.rule,
      amountUsd: members.map(m => m.amountUsd).filter(v => v != null).sort((x, y) => y - x)[0] ?? null,
      projectId: members.map(m => m.projectId).find(Boolean) ?? null,
      kind: top.kind ?? 'feed', rank: Math.max(...members.map(rank)), src: top.src ?? null,
      ...(members.some(m => m.calm) && { calm: true }),
      ...(key && { key }),
    };
  });
}

// Nouvelles règles : les news déjà dans le fil sont reclassées avec leur titre anglais. `ctxOf(item)` redonne le
// contexte de leur source. Une news qu'aucune règle ne garde plus passe en faible importance (elle quitte le fil
// au bout de 72 h). Les baleines ne changent pas.
export function reclassify(items, ctxOf) {
  return (items || []).map(i => {
    if (i.kind === 'whale' || !i.titleEn) return i;
    const hit = classify(i.titleEn, ctxOf(i));
    const next = hit ? { theme: hit.theme, raw: hit.importance, importance: hit.importance, impacts: hit.impacts, why: hit.why || i.why, rule: hit.rule }
      : { raw: 'low', importance: 'low', impacts: [] };
    const out = { ...i, ...next };
    if (hit?.key) out.key = hit.key; else delete out.key;
    if (out.rule !== 'guerre') delete out.calm;
    return out;
  });
}

// Identifiant court et stable (FNV-1a).
export function hashId(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// Guerre déjà en cours : seule la première frappe d'une zone en 24 h est critique. Les suivantes passent en
// « moyenne » (le marché les attend en partie), sauf une escalade majeure : déclaration de guerre, invasion, détroit fermé.
const zoneOf = t => (/\btaiwan/i.test(t) ? 'taiwan' : /\bnato\b/i.test(t) ? 'otan' : 'moyen-orient');
const majorEscalation = t => NEW_WAR.test(t) || (STRAIT.test(t) && CLOSE.test(t) && !REOPEN.test(t));

function calmOngoingWars(items) {
  const last = {};
  for (const i of [...items].sort((a, b) => a.time - b.time)) {
    if (i.rule !== 'guerre') continue;
    const zone = zoneOf(i.titleEn);
    const strike = i.raw === 'critical'; // une frappe ; sinon une menace
    if (i.calm || (!majorEscalation(i.titleEn) && last[zone] != null && i.time - last[zone] < 24 * HOUR)) {
      Object.assign(i, strike ? {
        calm: true, importance: 'medium',
        why: 'Nouvelle frappe dans une guerre déjà en cours : le marché l\'attend en partie, l\'effet sur le pétrole et l\'or est souvent plus faible qu\'à la première escalade.',
      } : {
        calm: true, importance: 'low', impacts: [],
        why: 'Déclaration ou menace dans une guerre déjà en cours : peu d\'effet tant qu\'elle ne change pas l\'ampleur du conflit.',
      });
    }
    if (strike) last[zone] = i.time;
  }
}

// Fusionne les anciennes news et les nouvelles, regroupe, garde 72 h.
// Les petits mouvements de baleines sont limités aux plus récents pour ne pas noyer le fil, et les news de faible
// importance laissent la place aux autres : une news critique reste 72 h même un jour très chargé.
export function buildFeed(previous, fresh, now = Date.now()) {
  const since = now - NEWS.keepHours * HOUR;
  const prev = (previous || []).filter(i => i.time >= since).map(i => ({ ...i, words: undefined }));
  const known = new Set(prev.flatMap(i => i.ids ?? [i.id]));
  const seen = new Set();
  const add = fresh
    .filter(i => i.time >= since && i.time <= now + HOUR && !known.has(i.id) && !seen.has(i.id) && seen.add(i.id))
    .sort((a, b) => a.time - b.time);
  const items = cluster([...prev.sort((a, b) => a.time - b.time), ...add]);
  calmOngoingWars(items);
  let smallWhales = 0, low = 0;
  const kept = items.sort((a, b) => b.time - a.time)
    .filter(i => i.kind !== 'whale' || i.importance !== 'low' || ++smallWhales <= NEWS.maxSmallWhales);
  const lowRoom = NEWS.maxItems - kept.filter(i => i.importance !== 'low').length;
  return kept.filter(i => i.importance !== 'low' || ++low <= lowRoom).slice(0, NEWS.maxItems);
}
