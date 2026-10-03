// Logique de l'onglet Projets : regroupement, filtres, statistiques, score.
// Fonctions pures, sans accès réseau, testées dans tests/projects.test.mjs.

export const DEFAULTS = {
  maxMcap: 1e9,           // market cap max
  minRevenue30d: 50_000,  // en dessous, trop petit pour être significatif
  shortlist: 60,          // projets analysés en détail
  topSize: 25,            // taille du top affiché
  newDays: 3,             // un projet reste « nouveau » 3 jours
  lowFloat: 0.3,          // flottant < 30 % = faible flottant
};

const DAY = 86_400;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sum = a => a.reduce((s, v) => s + v, 0);
const prettify = id => id.replace(/^parent#/, '').split('-').map(w => w[0]?.toUpperCase() + w.slice(1)).join(' ');
export const slugify = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Regroupe les entrées DefiLlama par protocole parent (ex. « Aerodrome V1 » + « Aerodrome Slipstream »).
export function groupFees(feeProtocols, parentProtocols = []) {
  const parents = new Map(parentProtocols.map(p => [p.id, p]));
  const groups = new Map();
  for (const p of feeProtocols) {
    const key = p.parentProtocol || `id:${p.defillamaId ?? p.id ?? p.name}`;
    const slug = p.slug || slugify(p.name);
    let g = groups.get(key);
    if (!g) {
      const parent = p.parentProtocol ? parents.get(p.parentProtocol) : null;
      g = {
        key,
        name: p.parentProtocol ? parent?.name || prettify(p.parentProtocol) : p.displayName || p.name,
        detailSlug: p.parentProtocol ? p.parentProtocol.replace(/^parent#/, '') : slug,
        children: [],
        category: null,
        chains: new Set(),
        revenue30d: 0,
        revenuePrev30d: 0,
        hasPrev: false,
        _topChild: -1,
      };
      groups.set(key, g);
    }
    const r30 = num(p.total30d) ?? 0;
    g.children.push({ id: String(p.defillamaId ?? p.id ?? ''), slug });
    g.revenue30d += r30;
    if (num(p.total60dto30d) !== null) { g.revenuePrev30d += p.total60dto30d; g.hasPrev = true; }
    (p.chains || []).forEach(c => g.chains.add(c));
    if (r30 > g._topChild) { g._topChild = r30; g.category = p.category || g.category; }
  }
  return [...groups.values()].map(({ _topChild, ...g }) => ({ ...g, chains: [...g.chains] }));
}

// Revenus reversés aux détenteurs (buybacks, distributions) sur 30 jours, par groupe.
export function holdersRevenueByKey(holderProtocols) {
  const out = new Map();
  for (const p of holderProtocols) {
    const key = p.parentProtocol || `id:${p.defillamaId ?? p.id ?? p.name}`;
    out.set(key, (out.get(key) ?? 0) + (num(p.total30d) ?? 0));
  }
  return out;
}

// Trouve le token (id CoinGecko, ticker) d'un groupe.
export function findToken(group, llamaProtocols, parentProtocols = []) {
  if (group.key.startsWith('parent#')) {
    const parent = parentProtocols.find(p => p.id === group.key);
    if (parent?.gecko_id) return { geckoId: parent.gecko_id, symbol: clean(parent.symbol), mcap: num(parent.mcap) };
    const ids = new Set(group.children.map(c => c.id));
    const kids = llamaProtocols.filter(p => p.parentProtocol === group.key || ids.has(String(p.id)));
    const gecko = [...new Set(kids.map(k => k.gecko_id).filter(Boolean))];
    if (gecko.length === 1) {
      const k = kids.find(x => x.gecko_id === gecko[0]);
      return { geckoId: gecko[0], symbol: clean(k.symbol), mcap: num(k.mcap) };
    }
    return null;
  }
  const child = group.children[0];
  const p = llamaProtocols.find(x => String(x.id) === child.id) || llamaProtocols.find(x => x.slug === child.slug);
  return p?.gecko_id ? { geckoId: p.gecko_id, symbol: clean(p.symbol), mcap: num(p.mcap) } : null;
}
const clean = s => (s && s !== '-' ? String(s).toUpperCase() : null);

// Fusionne plusieurs séries [[timestamp, valeur], ...] en une seule série journalière triée.
export function mergeDaily(charts) {
  const byDay = new Map();
  for (const chart of charts) {
    for (const [ts, v] of chart || []) {
      const day = Math.floor(Number(ts) / DAY) * DAY;
      byDay.set(day, (byDay.get(day) ?? 0) + (Number(v) || 0));
    }
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]);
}

// Statistiques de revenus à partir de la série journalière.
export function revenueStats(daily) {
  if (!daily || daily.length < 30) return null;
  const vals = daily.map(d => d[1]);
  const last30 = vals.slice(-30), prev30 = vals.slice(-60, -30), last7 = vals.slice(-7);
  const revenue30d = sum(last30);
  const revenuePrev30d = prev30.length === 30 ? sum(prev30) : null;
  const growth = revenuePrev30d && revenuePrev30d >= 1000 ? revenue30d / revenuePrev30d - 1 : null;
  const avg7 = sum(last7) / 7, avg30 = revenue30d / 30;
  return {
    revenue30d,
    revenuePrev30d,
    growth,
    accelerating: growth !== null && growth > 0.1 && avg7 > avg30 * 1.1,
    series: vals.slice(-90).map(v => Math.round(v)),
    seriesStart: new Date(daily[Math.max(0, daily.length - 90)][0] * 1000).toISOString().slice(0, 10),
  };
}

// Croissance du TVL sur 30 jours (null si TVL trop petit pour être significatif).
export function tvlStats(tvl) {
  const pts = (tvl || []).map(p => [Number(p.date), Number(p.totalLiquidityUSD)]).filter(p => p[0] && Number.isFinite(p[1]));
  if (!pts.length) return { tvl: null, tvlGrowth: null };
  const [lastDate, now] = pts[pts.length - 1];
  const before = [...pts].reverse().find(p => p[0] <= lastDate - 30 * DAY);
  const tvlGrowth = before && before[1] >= 100_000 && now >= 100_000 ? now / before[1] - 1 : null;
  return { tvl: now, tvlGrowth };
}

// Investisseurs (leads d'abord) et montant total levé. DefiLlama donne les montants en millions de $.
export function investorStats(raises) {
  const names = [];
  let raised = 0;
  for (const r of raises || []) {
    if (num(r.amount)) raised += r.amount * 1e6;
    for (const n of [...(r.leadInvestors || []), ...(r.otherInvestors || [])]) if (n && !names.includes(n)) names.push(n);
  }
  return { investors: names.slice(0, 8), investorsTotal: names.length, raisedUsd: raised || null };
}

// Part de l'offre en circulation.
export function floatRatio(m) {
  const denom = num(m?.max_supply) || num(m?.total_supply);
  const circ = num(m?.circulating_supply);
  return denom && circ ? Math.min(1, circ / denom) : null;
}

// Rang en percentile (0 = plus petit, 1 = plus grand). Les valeurs nulles restent nulles.
export function percentiles(values) {
  const idx = values.map((v, i) => [v, i]).filter(([v]) => num(v) !== null).sort((a, b) => a[0] - b[0]);
  const out = values.map(() => null);
  const n = idx.length;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const pct = n === 1 ? 1 : (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[idx[k][1]] = pct;
    i = j + 1;
  }
  return out;
}

// Score /100 : 50 % revenus, 30 % croissance, 20 % valorisation.
export function scoreProjects(projects) {
  const missing = 0.3; // une donnée absente pénalise sans éliminer
  const pRev = percentiles(projects.map(p => p.revenue30d));
  const pRevG = percentiles(projects.map(p => p.revenueGrowth));
  const pTvlG = percentiles(projects.map(p => p.tvlGrowth));
  const pVal = percentiles(projects.map(p => (p.psRatio === null ? null : -p.psRatio)));
  return projects.map((p, i) => {
    const g = [pRevG[i], pTvlG[i]].filter(v => v !== null);
    const parts = {
      revenue: pRev[i] ?? missing,
      growth: g.length ? sum(g) / g.length : missing,
      valuation: pVal[i] ?? missing,
    };
    const score = Math.round(100 * (0.5 * parts.revenue + 0.3 * parts.growth + 0.2 * parts.valuation));
    return {
      ...p,
      score,
      scoreParts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100)])),
    };
  }).sort((a, b) => b.score - a.score || b.revenue30d - a.revenue30d);
}

// Garde la date d'entrée dans le top d'une mise à jour à l'autre, pour repérer les nouveaux.
export function markNew(projects, previous, now = new Date(), opts = DEFAULTS) {
  const prev = new Map((previous?.projects || []).map(p => [p.id, p]));
  const hasPrev = Boolean(previous?.projects?.length);
  return projects.map((p, rank) => {
    const inTop = rank < opts.topSize;
    const before = prev.get(p.id);
    let firstSeenTop = null;
    if (inTop) firstSeenTop = before?.inTop ? before.firstSeenTop ?? null : hasPrev ? now.toISOString() : null;
    const isNew = Boolean(firstSeenTop) && now - new Date(firstSeenTop) < opts.newDays * DAY * 1000;
    return { ...p, rank: rank + 1, inTop, firstSeenTop, isNew };
  });
}

// Assemble la fiche d'un projet à partir de toutes les sources.
export function buildProject({ group, token, market, holdersRevenue30d, daily, detail, listings }) {
  const stats = revenueStats(daily);
  const revenue30d = stats?.revenue30d ?? group.revenue30d;
  const revenuePrev30d = stats ? stats.revenuePrev30d : group.hasPrev ? group.revenuePrev30d : null;
  const revenueGrowth = stats ? stats.growth : revenuePrev30d >= 1000 ? revenue30d / revenuePrev30d - 1 : null;
  const mcap = num(market?.market_cap) || token.mcap;
  const annual = revenue30d * (365 / 30);
  const { tvl, tvlGrowth } = tvlStats(detail?.tvl);
  const inv = investorStats(detail?.raises);
  const fl = floatRatio(market);
  const symbol = (market?.symbol || token.symbol || '').toUpperCase() || null;
  const holders = holdersRevenue30d > 0 ? holdersRevenue30d : 0;
  return {
    id: group.detailSlug,
    name: group.name,
    symbol,
    geckoId: token.geckoId,
    category: group.category,
    chains: group.chains.slice(0, 6),
    chainsTotal: group.chains.length,
    price: num(market?.current_price),
    change24h: num(market?.price_change_percentage_24h),
    change7d: num(market?.price_change_percentage_7d_in_currency),
    mcap,
    fdv: num(market?.fully_diluted_valuation),
    volume24h: num(market?.total_volume),
    revenue30d,
    revenuePrev30d,
    revenueGrowth,
    revenueAnnualized: annual,
    holdersRevenue30d: holders,
    holdersShare: holders && revenue30d ? Math.min(1, holders / revenue30d) : 0,
    tvl,
    tvlGrowth,
    psRatio: mcap && annual > 0 ? mcap / annual : null,
    float: fl,
    ...inv,
    series: stats?.series ?? [],
    seriesStart: stats?.seriesStart ?? null,
    badges: {
      buyback: holders > 0,
      accelerating: Boolean(stats?.accelerating),
      lowFloat: fl !== null && fl < DEFAULTS.lowFloat,
      binanceAlpha: Boolean(symbol && listings.alpha?.has(symbol)),
      okx: Boolean(symbol && listings.okx?.has(symbol)),
      trending: Boolean(listings.trending?.has(token.geckoId)),
    },
    links: {
      site: detail?.url || null,
      twitter: detail?.twitter ? `https://x.com/${detail.twitter}` : null,
      coingecko: `https://www.coingecko.com/en/coins/${token.geckoId}`,
      defillama: `https://defillama.com/protocol/${group.detailSlug}`,
      okx: symbol && listings.okx?.has(symbol) ? `https://www.okx.com/trade-spot/${symbol.toLowerCase()}-usdt` : null,
    },
  };
}

// Pré-sélection : token connu, revenus suffisants, market cap < max, pas sur Binance.
export function preselect(groups, { tokens, markets, binance, opts = DEFAULTS }) {
  const counts = { total: groups.length, noToken: 0, smallRevenue: 0, noMcap: 0, tooBig: 0, onBinance: 0, kept: 0 };
  const kept = [];
  for (const group of groups) {
    const token = tokens.get(group.key);
    if (!token) { counts.noToken++; continue; }
    if (group.revenue30d < opts.minRevenue30d) { counts.smallRevenue++; continue; }
    const market = markets.get(token.geckoId);
    const mcap = num(market?.market_cap) || token.mcap;
    if (!mcap) { counts.noMcap++; continue; }
    if (mcap >= opts.maxMcap) { counts.tooBig++; continue; }
    const symbol = (market?.symbol || token.symbol || '').toUpperCase();
    if (binance && symbol && binance.has(symbol)) { counts.onBinance++; continue; }
    kept.push({ group, token, market });
  }
  kept.sort((a, b) => b.group.revenue30d - a.group.revenue30d);
  counts.kept = kept.length;
  return { kept: kept.slice(0, opts.shortlist), counts };
}
