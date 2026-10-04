// Onglet Outils : calculs purs (sans page), testés dans tests/outils.test.mjs.
// Les pourcentages sont passés en % (1 = 1 %) ; les frais sont par côté (entrée ou sortie), en % de la valeur.

// Lit un nombre tapé en français ou en anglais : « 1 250,5 », « 1250.5 », « 0,05 % ».
export function num(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const t = String(s ?? '').replace(/[\s  %$€]/g, '').replace(',', '.');
  if (!/^-?\d*\.?\d+(e-?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const sideOf = (entry, stop) => (stop < entry ? 'long' : 'short');

// 2. Risque / rendement : R:R, prix des objectifs en R et taux de réussite minimum pour ne pas perdre.
export function riskReward({ entry, stop, target, feePct = 0, winRatePct = null }) {
  if (!(entry > 0 && stop > 0 && target > 0) || entry === stop) return null;
  const side = sideOf(entry, stop);
  const dir = side === 'long' ? 1 : -1;
  const r = Math.abs(entry - stop);
  const fee = feePct / 100;
  const loss = r + fee * (entry + stop); // perte réelle au stop, par unité
  const gain = dir * (target - entry) - fee * (entry + target); // gain réel à l'objectif, par unité
  const rr = gain / loss;
  const out = {
    side, rr,
    rawRR: dir * (target - entry) / r,
    targetPct: dir * (target - entry) / entry * 100,
    stopPct: r / entry * 100,
    breakEvenWinRate: rr > 0 ? 100 / (1 + rr) : null,
    levels: [1, 2, 3, 5, 10].map(k => ({ k, price: entry + dir * k * r })).filter(l => l.price > 0),
  };
  if (winRatePct != null && winRatePct >= 0 && winRatePct <= 100) {
    const w = winRatePct / 100;
    out.expectancy = w * rr - (1 - w); // en R par trade
  }
  return out;
}

// 6. DCA : `amount` $ investis tous les `every` jours depuis `startDay`, sur des clôtures quotidiennes [jour, prix].
// Comparé à la même somme totale investie d'un coup au premier achat.
export function dca(points, { amount, every, startDay, feePct = 0 }) {
  const rows = (points || []).filter(([d, p]) => d >= startDay && p > 0);
  if (!(amount > 0 && every >= 1) || rows.length < 2) return null;
  const fee = feePct / 100;
  let units = 0, invested = 0, next = rows[0][0], buys = 0;
  const series = [], cost = [];
  for (const [d, p] of rows) {
    if (d >= next) {
      units += amount * (1 - fee) / p;
      invested += amount;
      buys++;
      next += every * Math.ceil((d - next + 1) / every);
    }
    series.push([d, invested, units * p]);
    cost.push([d, invested * (1 - fee) / units]);
  }
  const first = rows[0][1], last = rows.at(-1)[1];
  const lumpUnits = invested * (1 - fee) / first;
  const value = units * last;
  // Pire moment : plus grosse perte latente par rapport à l'argent déjà investi.
  const worst = series.reduce((w, s) => (s[2] / s[1] - 1 < w.pct ? { day: s[0], pct: s[2] / s[1] - 1 } : w), { day: null, pct: 0 });
  return {
    buys, invested, units, value,
    avgPrice: invested * (1 - fee) / units,
    lastPrice: last,
    returnPct: (value / invested - 1) * 100,
    lump: { value: lumpUnits * last, returnPct: (lumpUnits * last / invested - 1) * 100, price: first },
    worst: { day: worst.day, pct: worst.pct * 100 },
    series: series.map(([d, inv, v], i) => [d, inv, v, lumpUnits * rows[i][1]]),
    cost, // prix moyen payé à chaque jour : [jour, prix]
  };
}

// 7. Intérêts composés : capital de départ, gain moyen par mois (en %), versement mensuel, objectif facultatif.
export function compound({ capital, ratePct, months, monthly = 0, target = null }) {
  if (!(capital >= 0 && months >= 1 && months <= 600) || ratePct == null || ratePct <= -100) return null;
  if (!(capital > 0 || monthly > 0)) return null;
  const r = ratePct / 100;
  const series = [[0, capital, capital]];
  let v = capital, paid = capital, reach = target > 0 && capital >= target ? 0 : null;
  for (let m = 1; m <= Math.max(months, 1); m++) {
    v = v * (1 + r) + monthly;
    paid += monthly;
    series.push([m, paid, v]);
    if (reach == null && target > 0 && v >= target) reach = m;
  }
  // Objectif au-delà de la durée choisie : on continue le calcul (jusqu'à 100 ans) pour dire quand il serait atteint.
  if (reach == null && target > 0) {
    let w = v;
    for (let m = months + 1; m <= 1200; m++) {
      w = w * (1 + r) + monthly;
      if (w >= target) { reach = m; break; }
    }
  }
  return { final: v, paid, gains: v - paid, multiple: capital > 0 ? v / capital : null, reach, series };
}

// Générateur pseudo-aléatoire reproductible (mulberry32) : même graine = mêmes tirages.
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p / 100 * (sorted.length - 1))));
  return sorted[i];
}

// 8. Séries de pertes (Monte-Carlo) : `runs` parcours de `trades` trades, chaque trade risquant `riskPct` %
// du capital du moment. Un gagnant rapporte `winR` fois le risque, un perdant coûte 1 fois le risque.
export function streaks({ winRatePct, winR, riskPct, trades, runs = 2000, seed = 42 }) {
  if (!(winRatePct >= 0 && winRatePct <= 100 && winR > 0 && riskPct > 0 && riskPct < 100 && trades >= 1 && trades <= 2000)) return null;
  const rand = rng(seed);
  const w = winRatePct / 100, risk = riskPct / 100;
  const maxLoss = [], maxDD = [], finals = [];
  const curves = [];
  for (let k = 0; k < runs; k++) {
    let eq = 1, peak = 1, dd = 0, run = 0, longest = 0;
    const curve = [1];
    for (let t = 0; t < trades; t++) {
      if (rand() < w) { eq *= 1 + winR * risk; run = 0; } else { eq *= 1 - risk; run++; if (run > longest) longest = run; }
      if (eq > peak) peak = eq;
      if (1 - eq / peak > dd) dd = 1 - eq / peak;
      curve.push(eq);
    }
    maxLoss.push(longest); maxDD.push(dd * 100); finals.push((eq - 1) * 100);
    curves.push(curve);
  }
  const s = a => [...a].sort((x, y) => x - y);
  const L = s(maxLoss), D = s(maxDD), F = s(finals);
  // Courbes de capital des parcours médian, pire 5 % et meilleur 5 % (classés par résultat final).
  const order = finals.map((f, i) => [f, i]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const pick = p => curves[order[Math.min(runs - 1, Math.round(p / 100 * (runs - 1)))]].map(v => (v - 1) * 100);
  return {
    expectancyR: w * winR - (1 - w),
    losingStreak: { median: percentile(L, 50), p95: percentile(L, 95), max: L.at(-1) },
    drawdown: { median: percentile(D, 50), p95: percentile(D, 95), max: D.at(-1) },
    final: { p5: percentile(F, 5), median: percentile(F, 50), p95: percentile(F, 95) },
    lossOdds: finals.filter(f => f < 0).length / runs * 100,
    curves: { p5: pick(5), median: pick(50), p95: pick(95) },
  };
}

// 9. Prix moyen d'entrée : plusieurs achats (prix, montant en $), comparés au prix actuel.
// Avec `target`, montant à acheter au prix actuel pour ramener le prix moyen à `target`.
export function averageEntry(buys, { current = null, target = null, feePct = 0 } = {}) {
  const ok = (buys || []).filter(b => b.price > 0 && b.amount > 0);
  if (!ok.length) return null;
  const fee = feePct / 100;
  const invested = ok.reduce((s, b) => s + b.amount, 0);
  const units = ok.reduce((s, b) => s + b.amount * (1 - fee) / b.price, 0);
  const avg = invested / units;
  const out = { count: ok.length, invested, units, avg };
  if (current > 0) {
    out.value = units * current;
    out.pnl = out.value - invested;
    out.pnlPct = (out.value / invested - 1) * 100;
    out.toBreakEvenPct = (avg / current - 1) * 100;
    if (target > 0) {
      // (invested + A) / (units + A·(1 − fee)/current) = target  →  A = (target·units − invested) / (1 − target·(1 − fee)/current)
      const k = 1 - target * (1 - fee) / current;
      const a = (target * units - invested) / k;
      const between = (target - avg) * (target - current) < 0 || target === avg;
      out.toTarget = between && Number.isFinite(a) && a >= 0 ? a : null;
    }
  }
  return out;
}

// 10. Convertisseur : `rates` donne la valeur d'une unité en dollars ({ USD: 1, EUR: 1.08, BTC: 60000 }).
export function convert(amount, from, to, rates) {
  const a = rates?.[from], b = rates?.[to];
  if (!(amount >= 0) || !(a > 0) || !(b > 0)) return null;
  return amount * a / b;
}

// DCA vers l'avenir : rejoue au hasard des tranches de 30 jours du passé (mêmes hausses, mêmes krachs, dans un
// autre ordre) pour `years` années d'achats réguliers. `drift` garde toute la tendance du passé (1), la moitié
// (0,5) ou aucune (0, seulement les secousses). Renvoie les parcours pessimiste (10 %), médian et optimiste (90 %)
// de la valeur du portefeuille, mois par mois, et ceux du prix de l'actif (`prices` : [jours après le dernier
// prix, bas, milieu, haut]).
export function dcaProjection(points, { amount, every, years, runs = 1000, seed = 7, feePct = 0, block = 30, drift = 1 }) {
  const closes = (points || []).map(p => p[1]).filter(p => p > 0);
  if (!(amount > 0 && every >= 1 && years > 0 && years <= 30) || closes.length < block * 4) return null;
  const raw = closes.slice(1).map((p, i) => Math.log(p / closes[i]));
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  const rets = raw.map(r => r - (1 - drift) * mean);
  const days = Math.round(years * 365);
  // Un point par mois pour le graphique ; le dernier tombe le dernier jour, comme le résultat final.
  const n = Math.round(years * 12);
  const monthAt = new Map(Array.from({ length: n + 1 }, (_, i) => [Math.round(i * days / n), i]));
  const fee = feePct / 100;
  const rand = rng(seed);
  const at = Array.from({ length: n + 1 }, () => []);
  const priceAt = Array.from({ length: n + 1 }, () => []);
  const finals = [];
  for (let k = 0; k < runs; k++) {
    let lp = 0, units = 0, start = 0;
    for (let d = 0; d <= days; d++) {
      if (d > 0) {
        if ((d - 1) % block === 0) start = Math.floor(rand() * (rets.length - block));
        lp += rets[start + ((d - 1) % block)];
      }
      if (d % every === 0 && d < days) units += amount * (1 - fee) / Math.exp(lp);
      if (monthAt.has(d)) {
        at[monthAt.get(d)].push(units * Math.exp(lp));
        priceAt[monthAt.get(d)].push(Math.exp(lp));
      }
    }
    finals.push(units * Math.exp(lp));
  }
  const buys = Math.ceil(days / every);
  const invested = buys * amount;
  const pick = (a, p) => percentile([...a].sort((x, y) => x - y), p);
  const paidAt = d => (Math.floor(Math.min(d, days - 1) / every) + 1) * amount;
  const checkpoints = at.map((vals, i) => [i, paidAt(Math.round(i * days / n)), pick(vals, 10), pick(vals, 50), pick(vals, 90)]);
  const lastPrice = closes.at(-1);
  const prices = priceAt.map((vals, i) => [Math.round(i * days / n), ...[10, 50, 90].map(q => pick(vals, q) * lastPrice)]);
  const histYears = (closes.length - 1) / 365;
  return {
    invested, buys, days, runs, block, lastPrice,
    final: { p10: pick(finals, 10), p50: pick(finals, 50), p90: pick(finals, 90) },
    price: { p10: prices.at(-1)[1], p50: prices.at(-1)[2], p90: prices.at(-1)[3] },
    prices,
    lossOdds: finals.filter(f => f < invested).length / runs * 100,
    histCagr: ((closes.at(-1) / closes[0]) ** (1 / histYears) - 1) * 100,
    usedCagr: (Math.exp(mean * drift * 365) - 1) * 100,
    histYears,
    checkpoints,
  };
}
