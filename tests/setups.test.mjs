import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  BAR, RULES, atr, detectBreakout, detectFunding, detectFvg, detectLevels, detectSweep, detectorStats, evaluate, fmtPx,
  mergeHistory, plan, priorLevels, roundStep, scanAsset, trend1d,
} from '../scripts/lib/setups.mjs';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1); // mardi 1er sept. 2026, minuit UTC

// Bougies plates autour de 100 (range 99–101, volume 1000), puis les bougies données.
function bars(extra = [], n = 40) {
  const out = Array.from({ length: n }, (_, i) => ({ t: T0 + i * BAR, o: 100, h: 101, l: 99, c: 100, v: 1000, closed: true }));
  extra.forEach((b, k) => out.push({ t: T0 + (n + k) * BAR, v: 1000, closed: true, ...b }));
  return out;
}
const ctxOf = (b, extra = {}) => ({ bars: b, daily: [], atr: atr(b), ...extra });

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

test('plan : stop à 1,5 ATR, objectif sur le niveau suivant, rejet si R:R < 2', () => {
  const p = plan('long', 100, 2, [{ price: 110, label: 'résistance' }, { price: 90, label: 'support' }]);
  assert.equal(p.sl, 97);
  assert.ok(Math.abs(p.tp[0] - 109.8) < 1e-9);
  assert.equal(p.rr, 3.3);
  assert.equal(p.tp.length, 3);
  assert.equal(plan('long', 100, 2, [{ price: 104, label: 'trop proche' }]), null);
  const open = plan('short', 100, 2, []);
  assert.equal(open.tp[0], 94);
  assert.equal(open.rr, 2);
  assert.match(open.tpLabels[1], /objectif 3,0R/);
});

test('evaluate : TP1 avant le stop = gagné, stop d\'abord = perdu, rien = expiré', () => {
  const sig = { dir: 'long', entry: 100, sl: 97, tp: [106, 109, 112], rr: 2 };
  const win = bars([{ o: 100, h: 101, l: 99, c: 100 }, { o: 100, h: 107, l: 99.5, c: 106 }]);
  assert.deepEqual(evaluate(sig, win, win.length - 2), { outcome: 'tp1', at: win.at(-1).t, r: 2, tpHit: 1 });
  const loss = bars([{ o: 100, h: 101, l: 99, c: 100 }, { o: 100, h: 107, l: 96, c: 98 }]);
  assert.equal(evaluate(sig, loss, loss.length - 2).outcome, 'sl', 'stop et TP1 sur la même bougie : on compte perdu');
  const flat = bars(Array.from({ length: 31 }, () => ({ o: 100, h: 101, l: 99, c: 101.5 })));
  const e = evaluate(sig, flat, flat.length - 32);
  assert.equal(e.outcome, 'expired');
  assert.equal(e.r, 0.5);
  const pending = bars([{ o: 100, h: 101, l: 99, c: 100 }, { o: 100, h: 101, l: 99, c: 100, closed: false }]);
  assert.equal(evaluate(sig, pending, pending.length - 2).outcome, 'open');
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

test('scanAsset : un signal par setup, cooldown de 24 h, statut en cours sur la bougie ouverte', () => {
  const b = bars([], 80);
  b.push({ t: b.at(-1).t + BAR, o: 100, h: 104, l: 100, c: 103.5, v: 3000, closed: true });
  b.push({ t: b.at(-1).t + BAR, o: 103.5, h: 106, l: 103, c: 105.5, v: 3500, closed: true });
  b.push({ t: b.at(-1).t + BAR, o: 105.5, h: 110, l: 105, c: 109, v: 9000, closed: false });
  const sigs = scanAsset({ symbol: 'TEST' }, { bars: b, daily: [] }).filter(s => s.detector === 'breakout');
  assert.equal(sigs.length, 1, 'la 2e cassure est dans le cooldown, la bougie ouverte aussi');
  assert.equal(sigs[0].status, 'confirmé');
  assert.equal(sigs[0].sl, 103.5 - RULES.stopAtr * atr(b)[80]);
});

test('detectorStats et mergeHistory', () => {
  const now = T0 + 100 * DAY;
  const s = (id, outcome, r, t = now - DAY, symbol = 'BTC') => ({ id, detector: 'sweep', symbol, status: 'confirmé', time: t, outcome, r });
  const st = detectorStats([s('a', 'tp1', 2), s('b', 'sl', -1), s('c', 'expired', 0.5), s('d', 'open', null), s('old', 'tp1', 2, now - 95 * DAY)], now).sweep;
  assert.equal(st.signals, 4);
  assert.equal(st.resolved, 3);
  assert.equal(Math.round(st.winRate * 100), 33);
  assert.equal(st.avgR, 0.5);
  assert.equal(st.best.symbol, 'BTC');
  const merged = mergeHistory([s('p1', 'tp1', 2, now - 30 * DAY), s('p2', 'sl', -1, now - 2 * DAY)], [s('f1', 'sl', -1, now - DAY)], { sweep: now - 10 * DAY }, now);
  assert.deepEqual(merged.map(x => x.id), ['f1', 'p1'], 'l\'ancien signal couvert par le recalcul est remplacé');
});

test('build-setups écrit setups.json à partir des réponses fictives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dinexo-setups-'));
  await writeFile(join(dir, 'prev.json'), JSON.stringify({ history: [{ id: 'old', detector: 'funding', symbol: 'BTC', status: 'confirmé', time: Date.now() - 60 * DAY, outcome: 'tp1', r: 2 }] }));
  await promisify(execFile)('node', ['--import', './tests/mock-fetch.mjs', 'scripts/build-setups.mjs', '--out', dir, '--previous', join(dir, 'prev.json'), '--sample']);
  const out = JSON.parse(await readFile(join(dir, 'setups.json'), 'utf8'));
  assert.equal(out.assets.length, 8);
  assert.deepEqual(out.assets.filter(a => a.kind === 'commodity').map(a => a.symbol), ['CL', 'NG']);
  assert.ok(!out.assets.some(a => a.symbol === 'USDT'), 'les stablecoins sont exclus');
  assert.ok(out.history.length > 10);
  assert.ok(out.history.some(h => h.id === 'old'), 'l\'ancien historique funding hors de la fenêtre recalculée est gardé');
  for (const s of out.live) {
    assert.ok(s.rr >= RULES.minRR);
    assert.ok(out.charts[s.symbol]);
  }
  for (const s of out.history) assert.ok(['tp1', 'sl', 'expired', 'open'].includes(s.outcome));
  assert.deepEqual(Object.keys(out.stats), ['breakout', 'sweep', 'fvg', 'funding', 'levels']);
});
