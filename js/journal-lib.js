// Journal figé des signaux Setups : chaque signal y entre au moment où le site le publie pour la première fois,
// avec son prix d'entrée, son stop et sa taille. Ces champs ne changent plus jamais, même si les règles changent.
// Seule la fin du trade (résultat, date, moitié prise) est recopiée depuis le calcul du site tant que le trade est ouvert.
// L'historique de l'onglet, lui, est recalculé à chaque passage : ce journal est la seule trace des vrais signaux.

export const JOURNAL_FRESH_MS = 3 * 3_600_000; // un signal confirmé il y a plus de 3 h n'entre pas : il n'a pas été vu « en direct »
export const ORPHAN_MS = 3 * 86_400_000;        // trade ouvert introuvable 3 jours de suite (règles changées) : on arrête de le suivre

const FROZEN = ['id', 'symbol', 'dir', 'detector', 'time', 'entry', 'sl', 'sz', 'score', 'model'];

// prev : journal déjà en ligne ({ start, entries }) ou null. signals : signaux du passage (tous statuts).
// prices : { BTC: 97000, ... } au moment du passage. model : clé des règles en cours.
export function updateJournal(prev, signals, prices, now, model) {
  const start = prev?.start ?? now;
  const entries = (prev?.entries ?? []).map(e => ({ ...e }));
  const byId = new Map(signals.filter(s => s.status === 'confirmé').map(s => [s.id, s]));
  const known = new Set(entries.map(e => e.id));

  for (const e of entries) {
    if (e.outcome !== 'open') continue; // un trade terminé ne bouge plus
    const s = byId.get(e.id);
    if (s && s.entry === e.entry && s.sl === e.sl) {
      e.seenLast = now;
      e.tpHit = s.tpHit ?? null;
      if (s.outcome !== 'open') Object.assign(e, { outcome: s.outcome, r: s.r, at: s.at, exitPx: s.exitPx ?? null });
    } else if (now - (e.seenLast ?? e.seen) > ORPHAN_MS) {
      e.outcome = 'orphan'; // le calcul du site ne retrouve plus ce trade : on le garde affiché, hors bilan
      e.at = now;
    }
  }

  for (const s of byId.values()) {
    if (known.has(s.id) || s.time < start) continue;
    const confirmedAt = s.confirmedAt ?? s.time;
    if (now - confirmedAt > JOURNAL_FRESH_MS) continue; // signal du passé recalculé : pas un vrai signal publié
    const e = Object.fromEntries(FROZEN.map(k => [k, k === 'model' ? model : s[k] ?? null]));
    if (e.sz === null) e.sz = 1;
    Object.assign(e, { seen: now, seenLast: now, priceSeen: prices[s.symbol] ?? null, outcome: 'open', r: null, at: null, tpHit: s.tpHit ?? null });
    if (s.outcome !== 'open') Object.assign(e, { outcome: s.outcome, r: s.r, at: s.at });
    entries.push(e);
  }

  entries.sort((a, b) => b.seen - a.seen);
  return { start, entries };
}

// Bilan du journal : trades terminés (hors suivis perdus), gagnants, total en « R de base » (taille comprise).
export function journalStats(journal) {
  const entries = journal?.entries ?? [];
  const done = entries.filter(e => e.outcome !== 'open' && e.outcome !== 'orphan' && typeof e.r === 'number');
  const total = Math.round(done.reduce((t, e) => t + e.r * (e.sz ?? 1), 0) * 100) / 100;
  return {
    start: journal?.start ?? null,
    signals: entries.length,
    open: entries.filter(e => e.outcome === 'open').length,
    done: done.length,
    wins: done.filter(e => e.r > 0).length,
    total,
    orphans: entries.filter(e => e.outcome === 'orphan').length,
  };
}

// Risque total des trades ouverts : ce que perd le compte si tous touchent leur stop en même temps.
// Un trade dont la moitié est prise a son stop au prix d'entrée : il ne risque plus rien.
export function openRisk(live, riskPct = 1) {
  const open = (live ?? []).filter(s => s.outcome === 'open' && s.status === 'confirmé');
  const atRisk = open.filter(s => !s.tpHit);
  const pct = Math.round(atRisk.reduce((t, s) => t + riskPct * (s.sz ?? 1), 0) * 100) / 100;
  const dirs = { long: atRisk.filter(s => s.dir === 'long').length, short: atRisk.filter(s => s.dir === 'short').length };
  return { open: open.length, atRisk: atRisk.length, pct, dirs };
}
