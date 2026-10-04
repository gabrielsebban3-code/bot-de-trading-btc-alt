// Onglet Outils, données du marché : lecture des tableaux de flux ETF et petits calculs partagés
// par le script de données (Node) et la page (navigateur). Testé dans tests/outils.test.mjs.

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const DAY = 86_400_000;

const cellText = s => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// « 12.3 » → 12.3, « (4.5) » → −4.5, « - » ou vide → 0, sinon null.
export function flowNum(s) {
  const t = String(s ?? '').replace(/,/g, '').trim();
  if (t === '' || t === '-' || t === '–') return 0;
  const m = t.match(/^(\()?(-?\d+(?:\.\d+)?)\)?$/);
  if (!m) return null;
  return m[1] ? -Number(m[2]) : Number(m[2]);
}

// « 11 Jan 2024 » → nombre de jours depuis le 1er janvier 1970 (UTC). « Sept » ou « June » marchent aussi.
export function farsideDay(s) {
  const m = String(s).match(/^(\d{1,2}) ([A-Z][a-z]{2})[a-z]*\.? (\d{4})$/);
  if (!m || !(m[2] in MONTHS)) return null;
  return Date.UTC(Number(m[3]), MONTHS[m[2]], Number(m[1])) / DAY;
}

// Tableau de farside.co.uk : une ligne par jour, une colonne par ETF (code boursier) et une colonne Total,
// en millions de dollars. Renvoie { issuers: ['IBIT', …], days: [[jour, total, [flux par ETF]]] }.
export function parseFarside(html) {
  const rows = [...String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(m => [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(c => cellText(c[1])));
  // Ligne des codes boursiers : celle qui en contient le plus, avant la première ligne datée.
  const firstData = rows.findIndex(r => farsideDay(r[0]) != null);
  if (firstData < 0) return { issuers: [], days: [] };
  let header = null;
  for (const r of rows.slice(0, firstData)) {
    const codes = r.filter(c => /^[A-Z]{3,5}$/.test(c)).length;
    if (codes >= 2 && (!header || codes > header.filter(c => /^[A-Z]{3,5}$/.test(c)).length)) header = r;
  }
  const width = rows[firstData].length;
  const totalCol = header ? header.findIndex(c => /^total$/i.test(c)) : -1;
  const tCol = totalCol > 0 ? totalCol : width - 1;
  const issuers = (header || []).slice(1, tCol).map((c, i) => c || `ETF ${i + 1}`);
  const days = [];
  for (const r of rows) {
    const d = farsideDay(r[0]);
    if (d == null || r.length < 3) continue;
    const total = flowNum(r[tCol]);
    if (total == null) continue;
    const flows = r.slice(1, tCol).map(flowNum).map(v => (v == null ? 0 : v));
    // Jour pas encore publié : toutes les cases vides.
    if (r.slice(1).every(c => c === '' || c === '-') ) continue;
    days.push([d, total, flows]);
  }
  days.sort((a, b) => a[0] - b[0]);
  return { issuers, days };
}

// Garde l'historique déjà publié et ajoute les nouveaux jours (les nouveaux gagnent).
export function mergeFlows(old, next) {
  if (!old?.days?.length || old.issuers.join() !== next.issuers.join()) return next;
  const m = new Map(old.days.map(d => [d[0], d]));
  for (const d of next.days) m.set(d[0], d);
  return { issuers: next.issuers, days: [...m.values()].sort((a, b) => a[0] - b[0]) };
}

// Résumé des flux : dernier jour, sommes sur 5 et 20 jours de bourse, cumul, série cumulée.
export function flowSummary(etf) {
  if (!etf?.days?.length) return null;
  const days = etf.days;
  const sum = n => days.slice(-n).reduce((s, d) => s + d[1], 0);
  let cum = 0;
  const cumulative = days.map(d => [d[0], (cum += d[1])]);
  let streak = 0;
  const sign = Math.sign(days.at(-1)[1]);
  for (let i = days.length - 1; i >= 0 && sign !== 0 && Math.sign(days[i][1]) === sign; i--) streak++;
  const last = days.at(-1);
  const byIssuer = etf.issuers.map((name, i) => ({ name, last: last[2][i] ?? 0, d20: days.slice(-20).reduce((s, d) => s + (d[2][i] ?? 0), 0) }))
    .sort((a, b) => Math.abs(b.d20) - Math.abs(a.d20));
  return { last: { day: last[0], total: last[1] }, d5: sum(5), d20: sum(20), total: cum, streak: streak * sign, cumulative, byIssuer };
}

// Funding sur 8 h (en %) → rendement sur un an pour qui le reçoit (3 versements par jour).
export const annualFunding = pct8h => pct8h * 3 * 365;
