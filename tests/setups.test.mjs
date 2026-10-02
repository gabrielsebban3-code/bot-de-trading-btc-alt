import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  BAR, RULES, atr, dailyContext, detectBreakout, detectFunding, detectFvg, detectLevels, detectSweep, detectorStats, evaluate,
  exitLevel, fmtPx, hasRoom, mergeHistory, plan, priorLevels, roundStep, scanAsset, trend1d,
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

test('breakout : clôture au-dessus du plus haut des 20 bougies avec du volume', () => {
  const b = bars([{ o: 100, h: 104, l: 100, c: 103.5, v: 2500 }]);
  const hit = detectBreakout(ctxOf(b), b.length - 1);
  assert.equal(hit.dir, 'long');
  assert.equal(hit.ref, 101);
  assert.match(hit.why, /volume 2,5× la moyenne/);
  const weak = bars([{ o: 100, h: 104, l: 100, c: 103.5, v: 1200 }]);
  assert.equal(detectBreakout(ctxOf(weak), weak.length - 1), null, 'sans volume, pas de signal');
});

test('sweep : mèche sous le plus bas puis clôture au-dessus', () => {
  const b = bars([{ o: 100, h: 100.5, l: 97, c: 100.2 }]);
  const hit = detectSweep(ctxOf(b), b.length - 1);
  assert.equal(hit.dir, 'long');
  assert.match(hit.why, /plus bas des 20 dernières bougies \(99,00\)/);
  const b2 = bars([{ o: 100, h: 103, l: 99.5, c: 99.8 }]);
  assert.equal(detectSweep(ctxOf(b2), b2.length - 1).dir, 'short');
});

test('fvg : retour dans un gap haussier encore intact', () => {
  const b = bars([
    { o: 100, h: 101, l: 99, c: 100.5 },  // a
    { o: 100.5, h: 108, l: 100.5, c: 107.5, v: 3000 }, // impulsion
    { o: 107.5, h: 109, l: 104, c: 108.5 }, // c : bas 104 > haut de a (101) → gap 101–104
    { o: 108.5, h: 110, l: 106, c: 109 },
    { o: 109, h: 109.5, l: 103, c: 105 },   // retour dans le gap, clôture au-dessus de 101
  ]);
  const hit = detectFvg(ctxOf(b), b.length - 1);
  assert.equal(hit.dir, 'long');
  assert.match(hit.why, /gap 101,0–104,0/);
});

test('niveaux : rebond sur le plus bas de la veille', () => {
  const daily = [{ t: T0 + 7 * DAY - DAY, o: 100, h: 106, l: 95, c: 100 }];
  const b = Array.from({ length: 42 }, (_, i) => ({ t: T0 + 7 * DAY - 41 * BAR + i * BAR, o: 100, h: 101, l: 99, c: 100, v: 1000, closed: true }));
  b.push({ t: T0 + 7 * DAY + BAR, o: 96.5, h: 98, l: 95.1, c: 97.5, v: 1000, closed: true });
  b[b.length - 2].c = 96.5;
  const hit = detectLevels({ bars: b, daily, atr: atr(b) }, b.length - 1);
  assert.equal(hit.dir, 'long');
  assert.match(hit.why, /plus bas de la veille \(95,00\)/);
});

test('funding/OI : funding extrême et open interest en hausse → signal contraire', () => {
  const b = bars();
  const i = b.length - 1;
  const oi = t => (t === b[i].t ? 1.2e6 : 1e6);
  assert.equal(detectFunding({ bars: b, fundingAt: () => 0.0006, oiAt: oi }, i).dir, 'short');
  assert.equal(detectFunding({ bars: b, fundingAt: () => -0.0005, oiAt: oi }, i).dir, 'long');
  assert.equal(detectFunding({ bars: b, fundingAt: () => 0.0001, oiAt: oi }, i), null);
  assert.equal(detectFunding({ bars: b, fundingAt: () => 0.0006, oiAt: () => 1e6 }, i), null, 'OI stable : pas de signal');
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

test('plan : stop à 2 ATR journaliers, moitié à 2R', () => {
  const p = plan('long', 100, 5);
  assert.equal(p.sl, 90);
  assert.deepEqual(p.tp, [120]);
  assert.equal(p.rr, 2);
  assert.deepEqual(plan('short', 100, 5).tp, [80]);
});

test('marge : pas de trade si un niveau bloque avant 2R (2 × 1,5 ATR 4h)', () => {
  assert.equal(hasRoom('long', 100, 2, [{ price: 104 }]), false, 'résistance à 2 ATR seulement');
  assert.equal(hasRoom('long', 100, 2, [{ price: 110 }, { price: 90 }]), true);
  assert.equal(hasRoom('short', 100, 2, [{ price: 103 }, { price: 97 }]), false);
  assert.equal(hasRoom('short', 100, 2, []), true, 'aucun niveau devant');
});

test('evaluate : stop, moitié puis stop à l\'entrée, sortie sur clôture journalière, trade en jeu', () => {
  const sig = { dir: 'long', entry: 100, sl: 96, tp: [108], rr: 2 };
  const daily = Array.from({ length: 13 }, (_, d) => ({ t: T0 + d * DAY, o: 100, h: 101, l: 99, c: 100, closed: true }));
  // Bougies 4h de la journée n° 11 : la 6e (indice 5) ferme la journée.
  const day11 = extra => [{ t: T0 + 11 * DAY, o: 100, h: 100.5, l: 99.5, c: 100, closed: true },
    ...extra.map((b, k) => ({ t: T0 + 11 * DAY + (k + 1) * BAR, closed: true, ...b }))];
  const flatBar = { o: 100, h: 100.5, l: 99.5, c: 100 };
  const at = b => b.at(-1).t;

  const stop = day11([{ o: 100, h: 100.5, l: 95, c: 96 }]);
  assert.deepEqual(evaluate(sig, stop, 0, daily), { outcome: 'sl', at: at(stop), r: -1, tpHit: 0 });

  const be = day11([{ o: 100, h: 109, l: 100.5, c: 105 }, { o: 105, h: 106, l: 99.5, c: 101 }]);
  assert.deepEqual(evaluate(sig, be, 0, daily), { outcome: 'be', at: at(be), r: 1, tpHit: 1 }, 'moitié à 2R, reste sorti à 0R');

  const fade = day11([flatBar, flatBar, flatBar, flatBar, { o: 100, h: 100, l: 97.5, c: 98 }]);
  assert.equal(exitLevel(daily, 11, 'long'), 99, 'plus bas des 10 journées avant le jour 11');
  assert.deepEqual(evaluate(sig, fade, 0, daily), { outcome: 'exit', at: at(fade), r: -0.5, tpHit: 0 }, 'clôture journalière sous le plus bas de 10 jours');
  const midDay = day11([flatBar, { o: 100, h: 100, l: 97.5, c: 98 }]);
  assert.equal(evaluate(sig, midDay, 0, daily).outcome, 'open', 'une bougie 4h sous le niveau ne suffit pas : il faut la clôture du jour');

  const live = day11([{ o: 100, h: 109, l: 100.5, c: 108 }, { o: 108, h: 110, l: 107, c: 109, closed: false }]);
  const e = evaluate(sig, live, 0, daily);
  assert.equal(e.outcome, 'open');
  assert.equal(e.tpHit, 1);
  assert.equal(e.stop, 100, 'stop remonté au prix d\'entrée');
  assert.equal(e.exitAt, null, 'plus bas de 10 jours (99) sous le stop : pas affiché');
});

test('scanAsset : signal seulement dans le sens de la tendance, un seul trade à la fois', () => {
  const b = bars([
    { o: 100, h: 104, l: 100, c: 103.5, v: 3000 },   // breakout haussier avec volume
    { o: 103.5, h: 106, l: 103, c: 105.5, v: 3500 }, // nouvelle cassure : trade déjà en jeu
    { o: 105.5, h: 106, l: 105, c: 105.8, closed: false },
  ], 80);
  const up = trendDays(0.6);
  const sigs = scanAsset({ symbol: 'TEST' }, { bars: b, daily: up });
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].detector, 'breakout');
  assert.equal(sigs[0].dir, 'long');
  assert.equal(sigs[0].status, 'confirmé');
  assert.equal(sigs[0].outcome, 'open');
  assert.equal(sigs[0].confirmedAt, sigs[0].time + BAR);
  assert.match(sigs[0].why, /tendance journalière est haussière/);
  assert.ok(Math.abs(sigs[0].entry - sigs[0].sl - RULES.stopAtr * dailyContext(up).atr.at(-1)) < 1e-9, 'stop à 2 ATR journaliers');
  const down = trendDays(-0.6);
  assert.deepEqual(scanAsset({ symbol: 'TEST' }, { bars: b, daily: down }).filter(s => s.dir === 'long'), [], 'cassure haussière en tendance baissière : ignorée');
});

test('detectorStats : gagnant = trade fini en gain, et mergeHistory retire les anciens détecteurs et actifs', () => {
  const now = T0 + 400 * DAY;
  const s = (id, outcome, r, t = now - 20 * DAY, symbol = 'BTC', detector = 'breakout', tpHit = 0) => ({ id, detector, symbol, status: 'confirmé', time: t, at: outcome === 'open' ? null : t + 10 * DAY, outcome, r, tpHit });
  const st = detectorStats([s('a', 'exit', 3.5, undefined, 'BTC', 'breakout', 1), s('b', 'sl', -1), s('c', 'be', 1, undefined, 'BTC', 'breakout', 1), s('e', 'exit', -0.3), s('d', 'open', null), s('old', 'exit', 2, now - 370 * DAY)], now).breakout;
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
    [s('f1', 'sl', -1, now - DAY)], { breakout: now - 10 * DAY }, now, ['BTC', 'ETH', 'SOL', 'BZ']);
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
  assert.deepEqual(Object.keys(out.stats), ['breakout', 'sweep', 'fvg', 'funding', 'levels']);
  assert.equal(out.rules.exitDays, 10);
  // Peu de signaux : un trade à la fois par actif, des trades de plusieurs jours.
  const spanDays = (Math.max(...out.history.map(h => h.time)) - Math.min(...out.history.map(h => h.time))) / DAY;
  assert.ok(out.history.length <= spanDays / 3, `${out.history.length} signaux sur ${Math.round(spanDays)} jours`);
});
