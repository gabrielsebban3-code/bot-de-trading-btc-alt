import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  RULES, atr, dailyContext, detectTrend, detectorStats, evaluate, exitLevel, fmtPx, mergeHistory, plan, scanAsset, trend1d,
} from '../scripts/lib/setups.mjs';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 5, 1); // lundi 1er juin 2026, minuit UTC

// 80 journées : tendance haussière (step > 0) ou baissière (step < 0), range de 4 autour de la clôture.
function days(step, n = 80) {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + step * i;
    return { t: T0 + i * DAY, o: c - step, h: c + 2, l: c - 2, c, v: 1000, closed: true };
  });
}

// Ajoute des journées à la suite (clôturées sauf indication contraire).
const then = (daily, extra) => [...daily, ...extra.map((d, k) => ({ t: daily.at(-1).t + (k + 1) * DAY, v: 1000, closed: true, ...d }))];
// 30 journées à plat autour de 100 (range 99–101).
const flat = (n = 30) => days(0, n).map(d => ({ ...d, h: 101, l: 99 }));

test('fmtPx garde assez de chiffres pour les petits prix', () => {
  assert.equal(fmtPx(85860.1), '85 860');
  assert.equal(fmtPx(3.14159), '3,14');
  assert.equal(fmtPx(0.0000123), '0,00001230');
});

test('atr vaut la taille moyenne des bougies', () => {
  const a = atr(flat());
  assert.equal(a[5], null);
  assert.ok(Math.abs(a.at(-1) - 2) < 1e-9);
});

test('trend1d : haussière, baissière, neutre sans assez de journées', () => {
  assert.equal(trend1d(days(1), T0 + 80 * DAY), 'haussière');
  assert.equal(trend1d(days(-0.5), T0 + 80 * DAY), 'baissière');
  assert.equal(trend1d(days(1).slice(0, 30), T0 + 30 * DAY), 'neutre');
  assert.equal(trend1d(days(1), T0 + 10 * DAY), 'neutre', 'seulement les journées déjà clôturées');
});

test('tendance : clôture au-dessus du plus haut de 20 jours en tendance haussière = long', () => {
  const up = then(days(1), [{ o: 179, h: 183, l: 179, c: 182 }]); // plus haut des 20 jours d'avant : 179 + 2 = 181
  const hit = detectTrend(dailyContext(up), up.length - 1);
  assert.equal(hit.dir, 'long');
  assert.equal(hit.ref, 181);
  assert.match(hit.why, /plus haut des 20 derniers jours \(181,0\)/);
  assert.match(hit.why, /moitié est prise à 2R/);
  const inside = then(days(1), [{ o: 179, h: 183, l: 179, c: 180.5 }]);
  assert.equal(detectTrend(dailyContext(inside), inside.length - 1), null, 'mèche au-dessus mais clôture dedans : pas de signal');
});

test('tendance : pas de long contre la tendance, short sous le plus bas en tendance baissière', () => {
  const lowBreak = then(days(-0.5), [{ o: 60.5, h: 60.5, l: 57, c: 58 }]); // plus bas des 20 jours : 58,5
  assert.equal(detectTrend(dailyContext(lowBreak), lowBreak.length - 1).dir, 'short');
  const highBreak = then(days(-0.5), [{ o: 60.5, h: 72, l: 60.5, c: 71 }]);
  assert.equal(detectTrend(dailyContext(highBreak), highBreak.length - 1), null, 'cassure haussière en tendance baissière : ignorée');
});

test('plan : stop à 2 ATR journaliers, moitié à 2R', () => {
  const p = plan('long', 100, 5);
  assert.equal(p.sl, 90);
  assert.deepEqual(p.tp, [120]);
  assert.equal(p.rr, 2);
  assert.deepEqual(plan('short', 100, 5).tp, [80]);
});

test('evaluate : stop, moitié puis stop à l\'entrée, sortie de tendance, trade en jeu', () => {
  const sig = { dir: 'long', entry: 100, sl: 96, tp: [108], rr: 2 };
  const base = flat();
  const i = base.length - 1;
  const at = d => d.at(-1).t;

  const stop = then(base, [{ o: 100, h: 101, l: 95, c: 96 }]);
  assert.deepEqual(evaluate(sig, stop, i), { outcome: 'sl', at: at(stop), r: -1, tpHit: 0 });

  const be = then(base, [{ o: 100, h: 109, l: 100.5, c: 105 }, { o: 105, h: 106, l: 99.5, c: 101 }]);
  assert.deepEqual(evaluate(sig, be, i), { outcome: 'be', at: at(be), r: 1, tpHit: 1 }, 'moitié à 2R, reste sorti à 0R');

  const climb = Array.from({ length: 10 }, (_, k) => ({ o: 109 + k, h: 111 + k, l: 109 + k, c: 110 + k }));
  const run = then(base, [{ o: 100, h: 109, l: 100.5, c: 108 }, ...climb, { o: 119, h: 119, l: 107.5, c: 108 }]);
  assert.equal(exitLevel(run, run.length - 1, 'long'), 109, 'plus bas des 10 journées précédentes');
  assert.deepEqual(evaluate(sig, run, i), { outcome: 'exit', at: at(run), r: 2, tpHit: 1 }, '(2R + 2R) / 2');

  const fade = then(base, [{ o: 100, h: 100, l: 97.5, c: 98 }]);
  assert.deepEqual(evaluate(sig, fade, i), { outcome: 'exit', at: at(fade), r: -0.5, tpHit: 0 }, 'clôture sous le plus bas de 10 jours avant le stop');

  const live = then(base, [{ o: 100, h: 109, l: 100.5, c: 108 }, { o: 108, h: 110, l: 107, c: 109, closed: false }]);
  const e = evaluate(sig, live, i);
  assert.equal(e.outcome, 'open');
  assert.equal(e.tpHit, 1);
  assert.equal(e.stop, 100, 'stop remonté au prix d\'entrée');
  assert.equal(e.exitAt, null, 'plus bas de 10 jours (99) sous le stop (100) : pas affiché');
  const later = then(run.slice(0, -1), [{ o: 119, h: 121, l: 118, c: 120, closed: false }]);
  assert.equal(evaluate(sig, later, i).exitAt, 109, 'plus bas de 10 jours au-dessus du stop : sortie affichée');
});

test('scanAsset : un seul trade à la fois par actif, statut en cours sur la journée ouverte', () => {
  const up = then(days(1), [
    { o: 179, h: 183, l: 179, c: 182 },     // cassure : long, stop 2 ATR jour (4) → 174
    { o: 182, h: 185, l: 181, c: 184.5 },   // nouvelle clôture au-dessus : trade déjà en jeu
    { o: 184.5, h: 186, l: 184, c: 185, closed: false },
  ]);
  const sigs = scanAsset({ symbol: 'TEST' }, { daily: up });
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].status, 'confirmé');
  assert.equal(sigs[0].outcome, 'open');
  assert.equal(sigs[0].trend, 'haussière');
  assert.equal(sigs[0].confirmedAt, sigs[0].time + DAY);
  assert.ok(Math.abs(sigs[0].entry - sigs[0].sl - RULES.stopAtr * dailyContext(up).atr[79]) < 1e-9);
  const pending = then(days(1), [{ o: 179, h: 183, l: 179, c: 182, closed: false }]);
  assert.equal(scanAsset({ symbol: 'TEST' }, { daily: pending })[0].status, 'en cours');
});

test('detectorStats : gagnant = trade fini en gain, et mergeHistory retire les anciens détecteurs et actifs', () => {
  const now = T0 + 400 * DAY;
  const s = (id, outcome, r, t = now - 20 * DAY, symbol = 'BTC', detector = 'tendance', tpHit = 0) => ({ id, detector, symbol, status: 'confirmé', time: t, at: outcome === 'open' ? null : t + 10 * DAY, outcome, r, tpHit });
  const st = detectorStats([s('a', 'exit', 3.5, undefined, 'BTC', 'tendance', 1), s('b', 'sl', -1), s('c', 'be', 1, undefined, 'BTC', 'tendance', 1), s('e', 'exit', -0.3), s('d', 'open', null), s('old', 'exit', 2, now - 370 * DAY)], now).tendance;
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
    [s('f1', 'sl', -1, now - DAY)], { tendance: now - 10 * DAY }, now, ['BTC', 'ETH', 'SOL', 'BZ']);
  assert.deepEqual(merged.map(x => x.id), ['f1', 'p1'], 'recalcul prioritaire, ancien détecteur swing et altcoin retirés');
});

test('build-setups écrit setups.json pour BTC, ETH, SOL et le Brent seulement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dinexo-setups-'));
  await writeFile(join(dir, 'prev.json'), JSON.stringify({ history: [
    { id: 'old', detector: 'funding', symbol: 'BTC', status: 'confirmé', time: Date.now() - 60 * DAY, outcome: 'tp1', r: 2 },
    { id: 'swing', detector: 'swing', symbol: 'ETH', status: 'confirmé', time: Date.now() - 60 * DAY, outcome: 'tp1', r: 2 },
    { id: 'alt', detector: 'breakout', symbol: 'HBAR', status: 'confirmé', time: Date.now() - 60 * DAY, outcome: 'sl', r: -1 },
  ] }));
  await promisify(execFile)('node', ['--import', './tests/mock-fetch.mjs', 'scripts/build-setups.mjs', '--out', dir, '--previous', join(dir, 'prev.json'), '--sample']);
  const out = JSON.parse(await readFile(join(dir, 'setups.json'), 'utf8'));
  assert.deepEqual(out.assets.map(a => a.symbol), ['BTC', 'ETH', 'SOL', 'BZ']);
  assert.deepEqual(out.assets.filter(a => a.kind === 'commodity').map(a => a.symbol), ['BZ']);
  assert.ok(out.history.length >= 5, `historique trop court : ${out.history.length}`);
  assert.ok(!out.history.some(h => ['old', 'swing', 'alt'].includes(h.id)), 'anciens détecteurs et altcoins retirés');
  assert.ok(out.history.every(h => ['BTC', 'ETH', 'SOL', 'BZ'].includes(h.symbol) && h.detector === 'tendance'));
  for (const s of out.live) {
    assert.ok(s.rr >= RULES.minRR);
    assert.ok(out.charts[s.symbol]);
    assert.ok(out.charts[s.symbol].length >= 100 && out.charts[s.symbol][1][0] - out.charts[s.symbol][0][0] === DAY, 'graphique journalier');
  }
  for (const s of out.history) assert.ok(['sl', 'be', 'exit', 'open'].includes(s.outcome));
  assert.deepEqual(Object.keys(out.stats), ['tendance']);
  assert.equal(out.rules.exitDays, 10);
  // Peu de signaux : un trade à la fois par actif, des trades de plusieurs jours.
  const spanDays = (Math.max(...out.history.map(h => h.time)) - Math.min(...out.history.map(h => h.time))) / DAY;
  assert.ok(out.history.length <= spanDays / 7, `${out.history.length} signaux sur ${Math.round(spanDays)} jours`);
});
