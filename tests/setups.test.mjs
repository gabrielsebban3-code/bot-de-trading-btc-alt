import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  BAR, RULES, atr, dailyContext, detectSwing, detectorStats, evaluate, fmtPx, mergeHistory, plan, scanAsset, trend1d,
} from '../scripts/lib/setups.mjs';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 5, 1); // lundi 1er juin 2026, minuit UTC

// Bougies 4h plates autour de 100 (range 99–101, volume 1000), puis les bougies données.
function bars(extra = [], n = 40) {
  const out = Array.from({ length: n }, (_, i) => ({ t: T0 + i * BAR, o: 100, h: 101, l: 99, c: 100, v: 1000, closed: true }));
  extra.forEach((b, k) => out.push({ t: T0 + (n + k) * BAR, v: 1000, closed: true, ...b }));
  return out;
}

// 80 journées : tendance haussière (step > 0) ou baissière (step < 0), range de 4 autour de la clôture.
function days(step, n = 80) {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + step * i;
    return { t: T0 + i * DAY, o: c - step, h: c + 2, l: c - 2, c, v: 1000, closed: true };
  });
}

// Bougies 4h du jour qui suit les journées données, à plat sur la dernière clôture, puis les bougies données.
function after(daily, extra) {
  const t0 = daily.at(-1).t + DAY, c = daily.at(-1).c;
  const out = [0, 1].map(k => ({ t: t0 + k * BAR, o: c, h: c + 0.5, l: c - 0.5, c, v: 1000, closed: true }));
  extra.forEach((b, k) => out.push({ t: t0 + (2 + k) * BAR, v: 1000, closed: true, ...b }));
  return out;
}

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

test('trend1d : haussière, baissière, neutre sans assez de journées', () => {
  assert.equal(trend1d(days(1), T0 + 80 * DAY), 'haussière');
  assert.equal(trend1d(days(-0.5), T0 + 80 * DAY), 'baissière');
  assert.equal(trend1d(days(1).slice(0, 30), T0 + 30 * DAY), 'neutre');
  assert.equal(trend1d(days(1), T0 + 10 * DAY), 'neutre', 'seulement les journées déjà clôturées');
});

test('swing : cassure du plus haut de 20 jours en tendance haussière = long', () => {
  const daily = days(1); // plus haut des 20 derniers jours : 179 + 2 = 181
  const b = after(daily, [{ o: 179, h: 183, l: 179, c: 182 }]);
  const hit = detectSwing({ bars: b, dc: dailyContext(daily) }, b.length - 1);
  assert.equal(hit.dir, 'long');
  assert.equal(hit.ref, 181);
  assert.match(hit.why, /plus haut des 20 derniers jours \(181,0\)/);
  const inside = after(daily, [{ o: 179, h: 180.5, l: 179, c: 180.5 }]);
  assert.equal(detectSwing({ bars: inside, dc: dailyContext(daily) }, inside.length - 1), null, 'pas de cassure, pas de signal');
  assert.match(hit.why, /Volume des dernières 24 h : 3,0× la moyenne/);
});

test('swing : une cassure sans volume est ignorée', () => {
  const daily = days(1); // volume journalier moyen : 1000
  const b = after(daily, [{ o: 179, h: 183, l: 179, c: 182 }]).map(x => ({ ...x, v: 150 })); // 6 × 150 = 900 sur 24 h
  assert.equal(detectSwing({ bars: b, dc: dailyContext(daily) }, b.length - 1), null);
});

test('swing : pas de long contre la tendance, short sur cassure du plus bas en tendance baissière', () => {
  const down = days(-0.5); // dernière clôture 60,5 ; plus bas des 20 jours : 60,5 - 2 = 58,5
  const lowBreak = after(down, [{ o: 60.5, h: 60.5, l: 57, c: 58 }]);
  assert.equal(detectSwing({ bars: lowBreak, dc: dailyContext(down) }, lowBreak.length - 1).dir, 'short');
  const highBreak = after(down, [{ o: 60.5, h: 72, l: 60.5, c: 71 }]);
  assert.equal(detectSwing({ bars: highBreak, dc: dailyContext(down) }, highBreak.length - 1), null, 'cassure haussière en tendance baissière : ignorée');
});

test('plan : stop à 1 ATR journalier, TP1 à 2R, TP2 à 3R, TP3 à 4R', () => {
  const p = plan('long', 100, 5);
  assert.equal(p.sl, 95);
  assert.deepEqual(p.tp, [110, 115, 120]);
  assert.equal(p.rr, 2);
  assert.deepEqual(p.tpLabels, ['objectif 2R', 'objectif 3R', 'objectif 4R']);
  assert.deepEqual(plan('short', 100, 5).tp, [90, 85, 80]);
});

test('evaluate : TP1 avant le stop = gagné, stop d\'abord = perdu, rien après 5 jours = sortie', () => {
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

test('scanAsset : un seul trade à la fois par actif, statut en cours sur la bougie ouverte', () => {
  const daily = days(1);
  const b = after(daily, [
    { o: 179, h: 183, l: 179, c: 182 },         // cassure : long, stop 1 ATR jour (4) → 178, TP1 190
    { o: 182, h: 185, l: 181, c: 184.5 },       // nouvelle clôture au-dessus : trade déjà en jeu
    { o: 184.5, h: 186, l: 184, c: 185, closed: false },
  ]);
  const sigs = scanAsset({ symbol: 'TEST' }, { bars: b, daily });
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].status, 'confirmé');
  assert.equal(sigs[0].outcome, 'open');
  assert.equal(sigs[0].trend, 'haussière');
  assert.ok(Math.abs(sigs[0].entry - sigs[0].sl - RULES.stopAtr * dailyContext(daily).atr.at(-1)) < 1e-9);
});

test('detectorStats : gagnant = trade fini en gain, et mergeHistory retire les anciens détecteurs et actifs', () => {
  const now = T0 + 400 * DAY;
  const s = (id, outcome, r, t = now - DAY, symbol = 'BTC', detector = 'swing') => ({ id, detector, symbol, status: 'confirmé', time: t, outcome, r });
  const st = detectorStats([s('a', 'tp1', 2), s('b', 'sl', -1), s('c', 'expired', 0.5), s('e', 'expired', -0.3), s('d', 'open', null), s('old', 'tp1', 2, now - 370 * DAY)], now).swing;
  assert.equal(st.signals, 5);
  assert.equal(st.resolved, 4);
  assert.equal(st.winRate, 0.5, 'TP1 et la sortie à +0,5R sont gagnants');
  assert.equal(st.tp1, 1);
  assert.equal(st.losses, 1);
  assert.equal(st.expired, 2);
  assert.equal(st.avgR, 0.3);
  assert.equal(st.best.symbol, 'BTC');
  const merged = mergeHistory(
    [s('p1', 'tp1', 2, now - 300 * DAY), s('p2', 'sl', -1, now - 2 * DAY), s('alt', 'sl', -1, now - 300 * DAY, 'HBAR'), s('fvg', 'sl', -1, now - 300 * DAY, 'BTC', 'fvg')],
    [s('f1', 'sl', -1, now - DAY)], { swing: now - 10 * DAY }, now, ['BTC', 'ETH', 'SOL', 'BZ']);
  assert.deepEqual(merged.map(x => x.id), ['f1', 'p1'], 'recalcul prioritaire, ancien détecteur et altcoin retirés');
});

test('build-setups écrit setups.json pour BTC, ETH, SOL et le Brent seulement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dinexo-setups-'));
  await writeFile(join(dir, 'prev.json'), JSON.stringify({ history: [
    { id: 'old', detector: 'funding', symbol: 'BTC', status: 'confirmé', time: Date.now() - 60 * DAY, outcome: 'tp1', r: 2 },
    { id: 'alt', detector: 'breakout', symbol: 'HBAR', status: 'confirmé', time: Date.now() - 60 * DAY, outcome: 'sl', r: -1 },
  ] }));
  await promisify(execFile)('node', ['--import', './tests/mock-fetch.mjs', 'scripts/build-setups.mjs', '--out', dir, '--previous', join(dir, 'prev.json'), '--sample']);
  const out = JSON.parse(await readFile(join(dir, 'setups.json'), 'utf8'));
  assert.deepEqual(out.assets.map(a => a.symbol), ['BTC', 'ETH', 'SOL', 'BZ']);
  assert.deepEqual(out.assets.filter(a => a.kind === 'commodity').map(a => a.symbol), ['BZ']);
  assert.ok(out.history.length >= 5, `historique trop court : ${out.history.length}`);
  assert.ok(!out.history.some(h => h.id === 'old' || h.id === 'alt'), 'anciens détecteurs et altcoins retirés');
  assert.ok(out.history.every(h => ['BTC', 'ETH', 'SOL', 'BZ'].includes(h.symbol) && h.detector === 'swing'));
  for (const s of out.live) {
    assert.ok(s.rr >= RULES.minRR);
    assert.ok(out.charts[s.symbol]);
  }
  for (const s of out.history) assert.ok(['tp1', 'sl', 'expired', 'open'].includes(s.outcome));
  assert.deepEqual(Object.keys(out.stats), ['swing']);
  // Peu de signaux : un trade à la fois par actif, au plus un par jour sur l'ensemble des paires en moyenne.
  const spanDays = (Math.max(...out.history.map(h => h.time)) - Math.min(...out.history.map(h => h.time))) / DAY;
  assert.ok(out.history.length <= spanDays, `${out.history.length} signaux sur ${Math.round(spanDays)} jours`);
});
