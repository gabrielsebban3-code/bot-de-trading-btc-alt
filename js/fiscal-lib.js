// Calculateur d'impôts crypto (onglet Impôts, Premium) : règles françaises des particuliers (article 150 VH bis du CGI).
// Seules les cessions contre des euros (ou contre un bien ou un service) sont imposables ; un échange crypto contre
// crypto ne l'est pas. Chaque cession se calcule comme le formulaire 2086 :
//   224 = 218 − 223 × 217 / 212 (prix de cession net − part du prix d'achat du portefeuille qui correspond à la vente).
// Le total des plus et moins-values de l'année est imposé au prélèvement forfaitaire unique, sauf si le total des
// prix de cession de l'année ne dépasse pas 305 €. Fonctions pures, testées dans tests/fiscal.test.mjs.

const DAY = 86_400_000;
export const EXEMPT = 305; // € de ventes par an en dessous desquels rien n'est dû
export const STABLES = ['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDP', 'PYUSD', 'USDE'];
export const FIATS = ['EUR', 'USD', 'GBP', 'CHF'];
export const TYPES = {
  achat: 'Achat',
  vente: 'Vente',
  echange: 'Échange',
  recompense: 'Récompense',
};

// Taux du prélèvement forfaitaire unique : 12,8 % d'impôt sur le revenu + prélèvements sociaux
// (17,2 % jusqu'aux cessions de 2024, 18,6 % depuis les cessions de 2025, loi de financement de la sécurité sociale 2026).
export function rates(year) {
  const ps = year >= 2025 ? 18.6 : 17.2;
  return { ir: 12.8, ps, total: Math.round((12.8 + ps) * 10) / 10 };
}

const round2 = x => Math.round(x * 100) / 100;
export const yearOf = t => new Date(t).getUTCFullYear();
export const dayOf = t => Math.floor(t / DAY) * DAY;

// Nombre saisi en français ou en anglais : « 1 234,56 », « 1,234.56 », « 0,5 », « €12.30 ».
export function num(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  let s = String(text ?? '').replace(/[\s  €$£]/g, '').replace(/^(EUR|USD)/i, '');
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()]/g, '').replace(/^-/, '');
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = /,\d{3}$/.test(s) && s.split(',').length > 2 ? s.replace(/,/g, '') : s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

export const cleanSym = s => String(s ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);

// Opération bien formée, ou null : { id, date, type, asset, qty, eur, fee, to, toQty, src, portfolio }.
// eur : prix payé (achat) ou reçu (vente), en euros. fee : frais en euros. portfolio : valeur du portefeuille saisie
// à la main pour une vente (ligne 212), quand le site ne connaît pas le prix de toutes les cryptos détenues.
export function normalizeOp(o) {
  if (!o || !TYPES[o.type]) return null;
  const date = Number(o.date);
  const asset = cleanSym(o.asset);
  const qty = num(o.qty);
  if (!Number.isFinite(date) || !asset || !(qty > 0)) return null;
  const op = { id: String(o.id || `${date.toString(36)}${Math.random().toString(36).slice(2, 6)}`), date, type: o.type, asset, qty, src: o.src || 'manuel' };
  if (o.type === 'achat' || o.type === 'vente') {
    const eur = num(o.eur);
    if (!(eur >= 0)) return null;
    op.eur = eur;
    op.fee = Math.max(0, num(o.fee) ?? 0);
  }
  if (o.type === 'echange') {
    op.to = cleanSym(o.to);
    op.toQty = num(o.toQty);
    if (!op.to || !(op.toQty > 0) || op.to === asset) return null;
  }
  if (o.type === 'vente' && num(o.portfolio) > 0) op.portfolio = num(o.portfolio);
  if (o.note) op.note = String(o.note).slice(0, 120);
  return op;
}

// Ordre de traitement : par date ; à la même seconde, les entrées avant les sorties.
const ORDER = { achat: 0, recompense: 0, echange: 1, vente: 2 };
export const sortOps = ops => [...ops].sort((a, b) => a.date - b.date || ORDER[a.type] - ORDER[b.type]);

// Valeur en euros d'une quantité d'une crypto à une date (null si prix inconnu).
function valueOf(asset, qty, t, priceAt) {
  if (asset === 'EUR') return qty;
  const p = priceAt(asset, t);
  return p == null ? null : qty * p;
}

// Rejoue toutes les opérations : quantités détenues, prix d'achat total du portefeuille et une ligne 2086 par vente.
// priceAt(symbole, date) → prix en euros ou null. Retourne { holdings, cessions, base, invested, warnings }.
export function compute(ops, priceAt) {
  const holdings = new Map();
  const add = (a, q) => holdings.set(a, (holdings.get(a) || 0) + q);
  let invested = 0;   // ligne 220 : tout ce qui a été payé en euros pour acheter des cryptos (frais compris)
  let fractions = 0;  // ligne 221 : parts du prix d'achat déjà déduites lors des ventes précédentes
  const cessions = [];
  const warnings = [];
  for (const op of sortOps(ops)) {
    if (op.type === 'achat') { add(op.asset, op.qty); invested += op.eur + op.fee; continue; }
    if (op.type === 'recompense') { add(op.asset, op.qty); continue; } // reçue gratuitement : prix d'achat nul
    const held = holdings.get(op.asset) || 0;
    if (op.qty > held * (1 + 1e-9) + 1e-12) warnings.push({ id: op.id, text: `${op.qty} ${op.asset} vendus ou échangés, mais seulement ${round(held)} détenus à cette date : il manque sans doute un achat.` });
    if (op.type === 'echange') { add(op.asset, -op.qty); add(op.to, op.toQty); continue; }
    // Vente : valeur de tout le portefeuille juste avant la vente (ligne 212).
    let value = 0;
    const missing = [];
    for (const [a, q] of holdings) {
      if (q <= 1e-12) continue;
      const v = valueOf(a, q, op.date, priceAt);
      if (v == null) missing.push(a); else value += v;
    }
    const auto = missing.length ? null : value;
    let l212 = op.portfolio ?? auto;
    const l213 = op.eur, l214 = op.fee;
    if (l212 == null) l212 = Math.max(value, l213); // estimation partielle : à compléter par l'utilisateur
    if (l212 < l213) l212 = l213; // le portefeuille vaut au moins ce qu'on en vend
    const l217 = l213, l218 = l213 - l214;
    const l220 = invested, l221 = fractions, l222 = 0;
    const l223 = Math.max(0, l220 - l221 - l222);
    const part = l212 > 0 ? l223 * l217 / l212 : 0;
    const l224 = l218 - part;
    fractions += part;
    add(op.asset, -op.qty);
    cessions.push({
      id: op.id, date: op.date, asset: op.asset, qty: op.qty,
      l212: round2(l212), l213: round2(l213), l214: round2(l214), l215: round2(l213 - l214), l216: 0, l217: round2(l217), l218: round2(l218),
      l220: round2(l220), l221: round2(l221), l222: 0, l223: round2(l223), l224: round2(l224),
      estimated: op.portfolio == null && missing.length > 0, missing, manual: op.portfolio != null,
    });
  }
  for (const [a, q] of holdings) if (Math.abs(q) < 1e-10) holdings.delete(a);
  return { holdings, cessions, invested: round2(invested), base: round2(Math.max(0, invested - fractions)), warnings };
}

const round = x => Number(x.toPrecision(8));

// Bilan d'une année : total des ventes, plus ou moins-value, impôt au prélèvement forfaitaire unique.
export function yearSummary(cessions, year) {
  const list = cessions.filter(c => yearOf(c.date) === year);
  const sales = round2(list.reduce((t, c) => t + c.l213, 0));
  const gain = round2(list.reduce((t, c) => t + c.l224, 0));
  const exempt = sales <= EXEMPT;
  const r = rates(year);
  const taxable = !exempt && gain > 0 ? gain : 0;
  return {
    year, list, sales, gain, exempt, rates: r,
    tax: round2(taxable * r.total / 100), ir: round2(taxable * r.ir / 100), ps: round2(taxable * r.ps / 100),
    // Report sur la déclaration 2042 C : plus-value en 3AN, moins-value en 3BN (rien si exonéré).
    box: exempt || gain === 0 ? null : gain > 0 ? { key: '3AN', value: Math.round(gain) } : { key: '3BN', value: Math.round(-gain) },
    estimated: list.some(c => c.estimated),
  };
}

export const years = cessions => [...new Set(cessions.map(c => yearOf(c.date)))].sort((a, b) => b - a);

// Où on en est aujourd'hui : valeur du portefeuille, prix d'achat restant, gain si on vendait tout.
export function standing(result, priceNow) {
  let value = 0;
  const lines = [];
  const missing = [];
  for (const [a, q] of result.holdings) {
    if (q <= 0) continue;
    const p = a === 'EUR' ? 1 : priceNow(a);
    if (p == null) { missing.push(a); lines.push({ asset: a, qty: q, price: null, value: null }); continue; }
    value += q * p;
    lines.push({ asset: a, qty: q, price: p, value: q * p });
  }
  lines.sort((x, y) => (y.value ?? -1) - (x.value ?? -1));
  const gain = value - result.base;
  const r = rates(yearOf(Date.now()));
  return { lines, value: round2(value), base: result.base, gain: round2(gain), taxIfSold: round2(Math.max(0, gain) * r.total / 100), missing };
}

// Mode DCA : un achat de `eur` euros tous les jours, semaines ou mois, du `from` au `to` (inclus).
// La quantité achetée = (montant − frais) ÷ prix du jour. Les jours sans prix connu sont sautés.
export function dcaOps({ asset, eur, every, from, to = Date.now(), feePct = 0 }, priceAt) {
  const a = cleanSym(asset);
  const amount = num(eur), fp = Math.max(0, num(feePct) ?? 0);
  if (!a || !(amount > 0) || !Number.isFinite(from) || !(to >= from)) return { ops: [], skipped: 0 };
  const ops = [];
  let skipped = 0;
  const start = new Date(dayOf(from));
  for (let k = 0; k < 2000; k++) {
    const d = new Date(start);
    if (every === 'jour') d.setUTCDate(d.getUTCDate() + k);
    else if (every === 'semaine') d.setUTCDate(d.getUTCDate() + 7 * k);
    else d.setUTCMonth(d.getUTCMonth() + k);
    // 31 du mois sur un mois de 30 jours : JavaScript passe au mois suivant, on garde le dernier jour du mois voulu.
    if (every === 'mois' && d.getUTCDate() !== start.getUTCDate()) d.setUTCDate(0);
    const t = d.getTime() + 12 * 3600_000; // midi UTC
    if (t > to) break; // pas d'achat dans le futur
    const p = priceAt(a, t);
    if (p == null || !(p > 0)) { skipped++; continue; }
    const fee = round2(amount * fp / 100);
    ops.push({ id: `dca-${a}-${t.toString(36)}`, date: t, type: 'achat', asset: a, qty: round((amount - fee) / p), eur: round2(amount - fee), fee, src: 'dca' });
  }
  return { ops, skipped };
}

// ---------- Import des fichiers d'historique des plateformes ----------

// Lecture CSV : virgule ou point-virgule, guillemets doublés.
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const first = src.split(/\r?\n/).find(l => l.trim()) || '';
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x.trim() !== '')) rows.push(row.map(x => x.trim()));
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim() !== '')) rows.push(row.map(x => x.trim()));
  return rows;
}

// Date d'un export : « 2024-03-01 10:00:00 UTC », « 2024-03-01T10:00:00Z », « 24-03-01 10:00:00 » (Binance).
export function parseDate(s) {
  const t = String(s ?? '').trim().replace(' UTC', 'Z').replace(/ (?=\d{2}:)/, 'T');
  const iso = /^\d{2}-\d{2}-\d{2}T/.test(t) ? `20${t}` : t;
  const ms = Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}${iso.includes('T') ? 'Z' : 'T00:00:00Z'}`);
  return Number.isFinite(ms) ? ms : null;
}

// Repère la plateforme d'après les colonnes du fichier.
export function detectFormat(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const h = rows[i].map(x => x.toLowerCase());
    if (h.includes('timestamp') && h.includes('transaction type')) return { format: 'coinbase', header: i };
    if (h.includes('utc_time') && h.includes('operation') && h.includes('change')) return { format: 'binance', header: i };
  }
  return { format: null, header: -1 };
}

// Coinbase (Relevé des transactions) : Buy, Sell, Convert, Rewards Income… Les envois et réceptions entre
// tes propres portefeuilles ne changent rien à l'impôt : ils sont ignorés.
const CB_BUY = /^(buy|advanced trade buy|purchase)$/i;
const CB_SELL = /^(sell|advanced trade sell)$/i;
const CB_REWARD = /(reward|income|staking|interest|learning|airdrop|inflation)/i;
const CB_SKIP = /^(send|receive|deposit|withdrawal|pro deposit|pro withdrawal|exchange deposit|exchange withdrawal|retail eth2 deprecation)$/i;

export function parseCoinbase(rows, header) {
  const h = rows[header].map(x => x.toLowerCase());
  const col = (...names) => names.map(n => h.indexOf(n)).find(i => i >= 0);
  const c = {
    time: col('timestamp'), type: col('transaction type'), asset: col('asset'), qty: col('quantity transacted'),
    cur: col('price currency', 'spot price currency'), sub: col('subtotal'), total: col('total (inclusive of fees and/or spread)'),
    fee: col('fees and/or spread'), notes: col('notes'),
  };
  const ops = [], skipped = [];
  for (const r of rows.slice(header + 1)) {
    const date = parseDate(r[c.time]);
    const type = r[c.type] || '';
    const asset = cleanSym(r[c.asset]);
    const qty = Math.abs(num(r[c.qty]) ?? NaN);
    const cur = cleanSym(r[c.cur]) || 'EUR';
    const sub = Math.abs(num(r[c.sub]) ?? NaN), fee = Math.abs(num(r[c.fee]) ?? 0);
    const line = `${r[c.time]} · ${type} ${r[c.qty] ?? ''} ${asset}`;
    if (date == null || !asset) { skipped.push(line); continue; }
    if (CB_SKIP.test(type)) continue;
    if (/convert/i.test(type)) {
      // « Converted 0.01 BTC to 250.5 USDC »
      const m = /([\d.,]+)\s+([A-Z0-9]+)\s+to\s+([\d.,]+)\s+([A-Z0-9]+)/i.exec(r[c.notes] || '');
      if (m) ops.push({ date, type: 'echange', asset: cleanSym(m[2]), qty: num(m[1]), to: cleanSym(m[4]), toQty: num(m[3]), src: 'coinbase' });
      else skipped.push(line);
      continue;
    }
    if (CB_REWARD.test(type)) { ops.push({ date, type: 'recompense', asset, qty, src: 'coinbase' }); continue; }
    const buy = CB_BUY.test(type), sell = CB_SELL.test(type);
    if (!buy && !sell) { skipped.push(line); continue; }
    if (cur !== 'EUR' && !FIATS.includes(cur)) {
      // Achat ou vente contre une autre crypto (ex. BTC-USDC) : échange, sans impôt.
      const other = sub + (buy ? fee : -fee);
      ops.push(buy ? { date, type: 'echange', asset: cur, qty: other, to: asset, toQty: qty, src: 'coinbase' }
        : { date, type: 'echange', asset, qty, to: cur, toQty: other, src: 'coinbase' });
      continue;
    }
    if (cur !== 'EUR') { skipped.push(`${line} (montant en ${cur}, pas en euros)`); continue; }
    ops.push({ date, type: buy ? 'achat' : 'vente', asset, qty, eur: sub, fee, src: 'coinbase' });
  }
  return { ops: ops.map(normalizeOp).filter(Boolean), skipped };
}

// Binance (Historique des transactions) : une ligne par mouvement. Les lignes d'une même seconde forment une
// opération : euros donnés et crypto reçue = achat ; crypto donnée et euros reçus = vente ; crypto contre crypto = échange.
const BN_REWARD = /(interest|reward|distribution|airdrop|staking|savings|earn.*(interest|reward)|launchpool|cashback|mining|referral|commission)/i;
const BN_SKIP = /(deposit|withdraw|transfer|subscription|redemption|fiat)/i;

export function parseBinance(rows, header) {
  const h = rows[header].map(x => x.toLowerCase());
  const c = { time: h.indexOf('utc_time'), op: h.indexOf('operation'), coin: h.indexOf('coin'), change: h.indexOf('change') };
  const groups = new Map();
  const ops = [], skipped = [];
  for (const r of rows.slice(header + 1)) {
    const date = parseDate(r[c.time]);
    const coin = cleanSym(r[c.coin]);
    const change = num(r[c.change]);
    const op = r[c.op] || '';
    if (date == null || !coin || change == null || change === 0) continue;
    if (BN_REWARD.test(op) && change > 0 && !/subscription|redemption/i.test(op)) {
      ops.push({ date, type: 'recompense', asset: coin, qty: change, src: 'binance' });
      continue;
    }
    if (!groups.has(date)) groups.set(date, { date, ops: new Set(), net: new Map() });
    const g = groups.get(date);
    g.ops.add(op);
    g.net.set(coin, (g.net.get(coin) || 0) + change);
  }
  for (const g of groups.values()) {
    const moves = [...g.net].filter(([, v]) => Math.abs(v) > 1e-12);
    if (!moves.length) continue; // virement entre comptes Binance : tout s'annule
    const out = moves.filter(([, v]) => v < 0), inn = moves.filter(([, v]) => v > 0);
    const label = `${new Date(g.date).toISOString().slice(0, 19).replace('T', ' ')} · ${[...g.ops].join(', ')}`;
    if (!out.length || !inn.length) {
      // Un seul sens : dépôt, retrait ou mouvement non reconnu.
      if (![...g.ops].every(o => BN_SKIP.test(o))) skipped.push(label);
      continue;
    }
    const eurOut = g.net.get('EUR') < 0 ? -g.net.get('EUR') : 0;
    const eurIn = g.net.get('EUR') > 0 ? g.net.get('EUR') : 0;
    const cryptoIn = inn.filter(([k]) => k !== 'EUR'), cryptoOut = out.filter(([k]) => k !== 'EUR');
    if (eurOut && cryptoIn.length === 1 && !cryptoOut.length) ops.push({ date: g.date, type: 'achat', asset: cryptoIn[0][0], qty: cryptoIn[0][1], eur: eurOut, fee: 0, src: 'binance' });
    else if (eurIn && cryptoOut.length >= 1 && !cryptoIn.length) {
      // Frais payés en BNB : petite sortie de BNB à côté de la vente principale. On garde la plus grosse sortie.
      const main = cryptoOut.length === 1 ? cryptoOut[0] : cryptoOut.filter(([k]) => k !== 'BNB')[0] || cryptoOut[0];
      ops.push({ date: g.date, type: 'vente', asset: main[0], qty: -main[1], eur: eurIn, fee: 0, src: 'binance' });
    }
    else if (!eurIn && !eurOut && cryptoOut.length >= 1 && cryptoIn.length === 1) {
      // Frais payés en BNB : petite sortie de BNB à côté de l'échange principal. On garde la plus grosse sortie.
      const main = cryptoOut.length === 1 ? cryptoOut[0] : cryptoOut.filter(([k]) => k !== 'BNB')[0] || cryptoOut[0];
      ops.push({ date: g.date, type: 'echange', asset: main[0], qty: -main[1], to: cryptoIn[0][0], toQty: cryptoIn[0][1], src: 'binance' });
    } else skipped.push(label);
  }
  return { ops: ops.map(normalizeOp).filter(Boolean), skipped };
}

// Fichier déposé : détecte la plateforme et renvoie les opérations reconnues et les lignes ignorées.
export function importFile(text) {
  const rows = parseCsv(text);
  const { format, header } = detectFormat(rows);
  if (format === 'coinbase') return { format, ...parseCoinbase(rows, header) };
  if (format === 'binance') return { format, ...parseBinance(rows, header) };
  return { format: null, ops: [], skipped: [] };
}

// Prix en euros d'une crypto à une date, depuis les fichiers data/prix (clôtures journalières en euros).
// series : Map symbole → { start, closes } ; usdEur : { start, rates }. Les stablecoins valent 1 dollar.
export function makePriceAt(series, usdEur) {
  const at = (s, t) => {
    if (!s) return null;
    const k = Math.floor((dayOf(t) - s.start) / DAY);
    const list = s.closes || s.rates;
    if (k < 0 || !list?.length) return null;
    return list[Math.min(k, list.length - 1)] ?? null;
  };
  return (asset, t) => {
    if (asset === 'EUR') return 1;
    if (STABLES.includes(asset)) return usdEur ? at(usdEur, t) : null;
    return at(series.get(asset), t);
  };
}
