import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  BAR, RULES, atr, dailyContext, detectMacd, detectRange10, detectRange20, detectorStats, evaluate,
  exitLevel, fmtPx, hasRoom, indicatorState, legState, mergeHistory, plan, priorLevels, radar, roundStep, scanAsset, trend1d,
} from '../scripts/lib/setups.mjs';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1); // mardi 1er sept. 2026, minuit UTC

// Bougies 4h plates autour de 100 (range 99–101, volume 1000), puis les bougies données.
function bars(extra = [], n = 40) {
  const out = Array.from({ length: n }, (_, i) => ({ t: T0 + i * BAR, o: 100, h: 101, l: 99, c: 100, v: 1000, closed: true }));
  extra.forEach((b, k) => out.push({ t: T0 + (n + k) * BAR, v: 1000, closed: true, ...b }));
  return out;
}
const ctxOf = (b, extra = {}) => ({ bars: b, daily: [], atr: atr(b), ...extra });

// Journées qui finissent la veille de T0 : tendance haussière (step > 0) ou baissière (step < 0), dernière clôture ≈ 99.
const trendDays = (step, n = 80) => Array.from({ length: n }, (_, i) => {
  const c = 99 - step * (n - 1 - i);
  return { t: T0 - (n - i) * DAY, o: c - step, h: c + 0.5, l: c - 0.5, c, v: 1000, closed: true };
});

test('fmtPx garde assez de chiffres pour les petits prix', () => {
  assert.equal(fmtPx(85860.1), '85 860');
  assert.equal(fmtPx(3.14159), '3,14');
  assert.equal(fmtPx(0.0000123), '0,00001230');
});

test('atr vaut la taille moyenne des bougies', () => {
  const a = atr(bars());
  assert.equal(a[5], null);
  assert.ok(Math.abs(a.at(-1) - 2) < 1e-9);
});

test('roundStep choisit des chiffres ronds adaptés au prix', () => {
  assert.equal(roundStep(85_000), 5000);
  assert.equal(roundStep(180), 50);
  assert.equal(roundStep(0.41), 0.05);
});

test('cassure 10 jours : clôture 4h au-delà du plus haut / plus bas des 60 bougies précédentes', () => {
  const b = bars([{ o: 100, h: 103, l: 100, c: 102 }], 70);
  const hit = detectRange10({ bars: b }, b.length - 1);
  assert.equal(hit.dir, 'long');
  assert.equal(hit.ref, 101);
  const down = bars([{ o: 100, h: 100, l: 97, c: 98 }], 70);
  assert.equal(detectRange10({ bars: down }, down.length - 1).dir, 'short');
  const again = bars([{ o: 100, h: 103, l: 100, c: 102 }, { o: 102, h: 104, l: 101.5, c: 103 }], 70);
  assert.equal(detectRange10({ bars: again }, again.length - 1), null, 'déjà au-dessus à la bougie d\'avant : pas de nouvelle cassure');
});

test('cassure 20 jours : clôture 4h au-dessus du plus haut des 20 dernières journées', () => {
  const daily = trendDays(0.1, 30); // plus haut des 20 jours = 99,5
  const b = bars([{ o: 99, h: 100.2, l: 99, c: 100 }], 70).map(x => ({ ...x, o: x.o - 2, h: x.h - 2, l: x.l - 2, c: x.c - 2 }));
  const i = b.length - 1;
  assert.equal(detectRange20({ bars: b, daily }, i), null, 'clôture à 98 sous 99,5');
  b[i] = { ...b[i], h: 100.5, c: 100 };
  const hit = detectRange20({ bars: b, daily }, i);
  assert.equal(hit.dir, 'long');
  assert.equal(hit.ref, 99.5);
  assert.match(hit.why, /20 derniers jours/);
});

test('MACD : l\'histogramme 4h repasse au-dessus ou au-dessous de zéro', () => {
  const h = new Array(40).fill(-1);
  h[39] = 0.5;
  assert.equal(detectMacd({ hist: h }, 39).dir, 'long');
  h[38] = 1; h[39] = -0.2;
  assert.equal(detectMacd({ hist: h }, 39).dir, 'short');
  h[38] = 1; h[39] = 2;
  assert.equal(detectMacd({ hist: h }, 39), null);
});

test('trend1d et priorLevels', () => {
  const daily = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * DAY, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i }));
  assert.equal(trend1d(daily, T0 + 60 * DAY), 'haussière');
  assert.equal(trend1d(daily.slice(0, 10), T0 + 10 * DAY), 'neutre');
  const lv = priorLevels(daily, T0 + 14 * DAY + 3 * BAR); // mardi 15 sept. : semaine précédente = lundi 7 → dimanche 13
  assert.equal(lv.find(l => l.key === 'dh').price, 101 + 13);
  assert.equal(lv.find(l => l.key === 'wh').price, 101 + 12);
  assert.equal(lv.find(l => l.key === 'wl').price, 99 + 6);
});

test('plan : stop à 0,75 ATR journalier, moitié à 5R', () => {
  const p = plan('long', 100, 4);
  assert.equal(p.sl, 97);
  assert.deepEqual(p.tp, [115]);
  assert.equal(p.rr, 5);
  assert.deepEqual(plan('short', 100, 4).tp, [85]);
});

test('marge : pas de trade si un niveau bloque avant 2R (2 × 1,5 ATR 4h)', () => {
  assert.equal(hasRoom('long', 100, 2, [{ price: 104 }]), false, 'résistance à 2 ATR seulement');
  assert.equal(hasRoom('long', 100, 2, [{ price: 110 }, { price: 90 }]), true);
  assert.equal(hasRoom('short', 100, 2, [{ price: 103 }, { price: 97 }]), false);
  assert.equal(hasRoom('short', 100, 2, []), true, 'aucun niveau devant');
});

test('evaluate : stop, moitié puis stop à l\'entrée, sortie sur clôture journalière, trade en jeu', () => {
  const sig = { dir: 'long', entry: 100, sl: 98, tp: [110], rr: 5 };
  const daily = Array.from({ length: 13 }, (_, d) => ({ t: T0 + d * DAY, o: 100, h: 101, l: 99, c: 100, closed: true }));
  // Bougies 4h de la journée n° 11 : la 6e (indice 5) ferme la journée.
  const day11 = extra => [{ t: T0 + 11 * DAY, o: 100, h: 100.5, l: 99.5, c: 100, closed: true },
    ...extra.map((b, k) => ({ t: T0 + 11 * DAY + (k + 1) * BAR, closed: true, ...b }))];
  const flatBar = { o: 100, h: 100.5, l: 99.5, c: 100 };
  const at = b => b.at(-1).t;

  const stop = day11([{ o: 100, h: 100.5, l: 97.5, c: 98 }]);
  assert.deepEqual(evaluate(sig, stop, 0, daily), { outcome: 'sl', at: at(stop), r: -1, tpHit: 0, halfAt: null, exitPx: sig.sl, exitLvl: null });

  const be = day11([{ o: 100, h: 111, l: 100.5, c: 105 }, { o: 105, h: 106, l: 99.5, c: 101 }]);
  assert.deepEqual(evaluate(sig, be, 0, daily), { outcome: 'be', at: at(be), r: 2.5, tpHit: 1, halfAt: be[1].t, exitPx: 100, exitLvl: null }, 'moitié à 5R, reste sorti à 0R');

  const fade = day11([flatBar, flatBar, flatBar, flatBar, { o: 100, h: 100, l: 98.5, c: 98.8 }]);
  assert.equal(exitLevel(daily, 11, 'long'), 99, 'plus bas des 7 journées avant le jour 11');
  assert.deepEqual(evaluate(sig, fade, 0, daily), { outcome: 'exit', at: at(fade), r: -0.6, tpHit: 0, halfAt: null, exitPx: 98.8, exitLvl: 99 }, 'clôture journalière sous le plus bas de 7 jours');
  const midDay = day11([flatBar, { o: 100, h: 100, l: 98.5, c: 98.8 }]);
  assert.equal(evaluate(sig, midDay, 0, daily).outcome, 'open', 'une bougie 4h sous le niveau ne suffit pas : il faut la clôture du jour');

  const live = day11([{ o: 100, h: 111, l: 100.5, c: 110 }, { o: 110, h: 112, l: 109, c: 111, closed: false }]);
  const e = evaluate(sig, live, 0, daily);
  assert.equal(e.outcome, 'open');
  assert.equal(e.tpHit, 1);
  assert.equal(e.stop, 100, 'stop remonté au prix d\'entrée');
  assert.equal(e.halfAt, live[1].t, 'moment où la moitié est prise, pour la fiche du trade');
  assert.equal(e.halfAt, live[1].t, 'moment où la moitié est prise, pour la fiche du trade');
  assert.equal(e.exitAt, null, 'plus bas de 10 jours (99) sous le stop : pas affiché');
});

test('scanAsset : signal seulement dans le sens de la tendance, un seul trade à la fois', () => {
  const b = bars([
    { o: 100, h: 104, l: 100, c: 103.5 },   // cassure du plus haut des 10 jours
    { o: 103.5, h: 106, l: 103, c: 105.5 }, // trade déjà en jeu
    { o: 105.5, h: 106, l: 105, c: 105.8, closed: false },
  ], 80);
  const up = trendDays(0.6);
  const sigs = scanAsset({ symbol: 'TEST' }, { bars: b, daily: up });
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].detector, 'range10');
  assert.equal(sigs[0].dir, 'long');
  assert.equal(sigs[0].status, 'confirmé');
  assert.equal(sigs[0].outcome, 'open');
  assert.equal(sigs[0].confirmedAt, sigs[0].time + BAR);
  assert.match(sigs[0].why, /tendance journalière est haussière/);
  assert.equal(sigs[0].ref, 101, 'plus haut cassé, gardé pour la fiche du trade');
  assert.ok(sigs[0].day.e20 > sigs[0].day.e50 && sigs[0].day.c > sigs[0].day.e50, 'clôture et moyennes du jour qui donnaient la tendance');
  assert.ok(Math.abs(sigs[0].entry - sigs[0].sl - RULES.stopAtr * dailyContext(up).atr.at(-1)) < 1e-9, 'stop à 0,75 ATR journalier');
  const down = trendDays(-0.6);
  assert.deepEqual(scanAsset({ symbol: 'TEST' }, { bars: b, daily: down }).filter(s => s.dir === 'long'), [], 'cassure haussière en tendance baissière : ignorée');
});

test('radar : prix de la prochaine cassure dans le sens de la tendance, rien en tendance neutre', () => {
  const b = bars([], 80); // range 99–101 sur 80 bougies 4h, plus haut des 10 jours = 101
  const up = radar(b, trendDays(0.01)); // journées presque plates : plus haut des 20 jours = 99,5 + petit pas
  assert.equal(up.trend, 'haussière');
  assert.equal(up.dir, 'long');
  assert.equal(up.trigger.key, 'range10');
  assert.equal(up.trigger.price, 101);
  assert.ok(Math.abs(up.trigger.distance - 0.01) < 1e-9);
  assert.ok(up.trigger.stop < 101);
  assert.deepEqual(up.levels.map(l => l.key), ['range20', 'range10'], 'les deux cassures, pour la fiche de la paire');
  const down = radar(b, trendDays(-0.6));
  assert.equal(down.dir, 'short');
  assert.equal(down.trigger.price, 99, 'plus bas des 10 jours, plus proche que celui des 20 jours');
  const flat = radar(b, Array.from({ length: 80 }, (_, i) => ({ t: T0 - (80 - i) * DAY, o: 100, h: 101, l: 99, c: 100, closed: true })));
  assert.equal(flat.trend, 'neutre');
  assert.equal(flat.trigger, undefined);
});

test('detectorStats : gagnant = trade fini en gain, et mergeHistory retire les anciens détecteurs et actifs', () => {
  const now = T0 + 400 * DAY;
  const s = (id, outcome, r, t = now - 20 * DAY, symbol = 'BTC', detector = 'range20', tpHit = 0) => ({ id, detector, symbol, status: 'confirmé', time: t, at: outcome === 'open' ? null : t + 10 * DAY, outcome, r, tpHit });
  const st = detectorStats([s('a', 'exit', 3.5, undefined, 'BTC', 'range20', 1), s('b', 'sl', -1), s('c', 'be', 1, undefined, 'BTC', 'range20', 1), s('e', 'exit', -0.3), s('d', 'open', null), s('old', 'exit', 2, now - 370 * DAY)], now).range20;
  assert.equal(st.signals, 5);
  assert.equal(st.resolved, 4);
  assert.equal(st.winRate, 0.5);
  assert.equal(st.tp1, 2, 'moitié prise deux fois');
  assert.equal(st.losses, 1);
  assert.equal(st.avgR, 0.8);
  assert.equal(st.bestR, 3.5);
  assert.equal(st.avgDays, 10);
  assert.equal(st.best.symbol, 'BTC');
  const merged = mergeHistory(
    [s('p1', 'exit', 2, now - 300 * DAY), s('p2', 'sl', -1, now - 2 * DAY), s('alt', 'sl', -1, now - 300 * DAY, 'HBAR'), s('sw', 'sl', -1, now - 300 * DAY, 'BTC', 'swing')],
    [s('f1', 'sl', -1, now - DAY)], { range20: now - 10 * DAY }, now, ['BTC', 'ETH', 'SOL', 'BZ']);
  assert.deepEqual(merged.map(x => x.id), ['f1', 'p1'], 'recalcul prioritaire, ancien détecteur swing et altcoin retirés');
});

test('build-setups écrit setups.json pour BTC, ETH, SOL et le Brent seulement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dinexo-setups-'));
  await writeFile(join(dir, 'prev.json'), JSON.stringify({ history: [
    { id: 'old', detector: 'tendance', symbol: 'BTC', status: 'confirmé', time: Date.now() - 60 * DAY, outcome: 'exit', r: 2 },
    { id: 'swing', detector: 'swing', symbol: 'ETH', status: 'confirmé', time: Date.now() - 60 * DAY, outcome: 'tp1', r: 2 },
    { id: 'alt', detector: 'breakout', symbol: 'HBAR', status: 'confirmé', time: Date.now() - 60 * DAY, outcome: 'sl', r: -1 },
  ] }));
  await promisify(execFile)('node', ['--import', './tests/mock-fetch.mjs', 'scripts/build-setups.mjs', '--out', dir, '--previous', join(dir, 'prev.json'), '--sample']);
  const out = JSON.parse(await readFile(join(dir, 'setups.json'), 'utf8'));
  assert.deepEqual(out.assets.map(a => a.symbol), ['BTC', 'ETH', 'SOL', 'BZ']);
  assert.deepEqual(out.assets.filter(a => a.kind === 'commodity').map(a => a.symbol), ['BZ']);
  assert.ok(out.history.length >= 5, `historique trop court : ${out.history.length}`);
  assert.ok(!out.history.some(h => ['old', 'swing', 'alt'].includes(h.id)), 'anciens détecteurs et altcoins retirés');
  assert.ok(out.history.every(h => ['BTC', 'ETH', 'SOL', 'BZ'].includes(h.symbol) && Object.keys(out.detectors).includes(h.detector)));
  for (const s of out.live) {
    assert.ok(s.rr >= RULES.minRR);
    assert.ok(out.charts[s.symbol]);
    assert.ok(out.charts[s.symbol].length >= 100 && out.charts[s.symbol][1][0] - out.charts[s.symbol][0][0] === BAR, 'graphique 4h');
  }
  for (const s of out.history) assert.ok(['sl', 'be', 'exit', 'open'].includes(s.outcome));
  assert.deepEqual(Object.keys(out.stats), ['range20', 'range10', 'macd']);
  assert.equal(out.rules.exitDays, 7);
  // Peu de signaux : un trade à la fois par actif, des trades de plusieurs jours.
  const spanDays = (Math.max(...out.history.map(h => h.time)) - Math.min(...out.history.map(h => h.time))) / DAY;
  assert.ok(out.history.length <= spanDays / 3, `${out.history.length} signaux sur ${Math.round(spanDays)} jours`);
});

test('indicatorState décrit une paire en tendance haussière, sans signal', () => {
  const daily = trendDays(0.5, 220);
  const b = Array.from({ length: 120 }, (_, i) => {
    const c = 95 + i * 0.05;
    return { t: T0 - (120 - i) * BAR, o: c - 0.05, h: c + 0.2, l: c - 0.2, c, v: 1000, closed: true };
  });
  const s = indicatorState(b, daily);
  const by = Object.fromEntries(s.items.map(x => [x.key, x]));
  assert.equal(by.trend.value, 'haussière');
  assert.equal(by.trend.tone, 'up');
  assert.equal(by.ma200.tone, 'up');
  assert.equal(by.macd.value, 'haussier');
  assert.equal(by.rsi1d.tone, 'down', 'une montée sans pause = surachat, signalé en rouge');
  assert.equal(s.verdict, 'plutôt haussier');
  assert.ok(s.items.every(x => x.text && x.label && x.value));
});

test('indicatorState renvoie null sans assez d\'historique', () => {
  assert.equal(indicatorState(bars(), trendDays(0.5, 30)), null);
});

test('legState suit la jambe en cours, son creux de départ et son plus haut', () => {
  // 60 jours de baisse de 200 à 140, puis 40 jours de hausse jusqu'à 220.
  const daily = Array.from({ length: 100 }, (_, i) => {
    const c = i < 60 ? 200 - i : 140 + (i - 59) * 2;
    return { t: T0 + i * DAY, o: c, h: c + 1, l: c - 1, c, v: 1000, closed: true };
  });
  const s = legState(daily);
  assert.equal(s.dir, 'up');
  assert.equal(s.origin.price, 140, 'le creux de la jambe baissière d\'avant');
  assert.equal(s.ext.price, 221);
  assert.ok(s.since.t > daily[59].t, 'le croisement arrive après le creux');
  assert.equal(s.past[0].dir, 'down');
});

test('toWeeks regroupe les journées par semaine du lundi', async () => {
  const { toWeeks, legsOf } = await import('../js/legs-lib.js');
  const MON = Date.UTC(2026, 8, 7); // lundi 7 sept. 2026
  const days = Array.from({ length: 14 }, (_, i) => ({ t: MON + i * DAY, o: 100 + i, h: 110 + i, l: 90 + i, c: 101 + i, v: 1 }));
  const w = toWeeks(days);
  assert.equal(w.length, 2);
  assert.deepEqual(w[0], { t: MON, o: 100, h: 116, l: 90, c: 107, v: 7 });
  assert.equal(legsOf(w), null, 'pas assez de semaines pour les moyennes');
});

test('legDetails mesure le retard sur le creux et le résultat de chaque jambe', async () => {
  const { legDetails } = await import('../js/legs-lib.js');
  const daily = Array.from({ length: 100 }, (_, i) => {
    const c = i < 60 ? 200 - i : 140 + (i - 59) * 2;
    return { t: T0 + i * DAY, o: c, h: c + 1, l: c - 1, c, v: 1000 };
  });
  const legs = legDetails(daily);
  const cur = legs.at(-1);
  assert.equal(cur.dir, 'up');
  assert.equal(cur.open, true);
  assert.equal(cur.origin.price, 140, 'plus bas de la jambe baissière d\'avant');
  assert.ok(cur.lagMs > 0 && cur.fromOrigin > 0, 'le signal arrive après le creux, plus haut que lui');
  assert.equal(cur.result, 220 / cur.signal.price - 1);
  assert.equal(cur.exit, null);
});
