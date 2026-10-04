// Scanner (scripts/build-scanner.mjs) : choix des cryptos, résumé de chaque crypto, script complet sur les réponses fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { RECENT_DAYS, coinView, pickUniverse } from '../scripts/build-scanner.mjs';
import { setupRoutes } from './setups-fixtures.mjs';

const DAY = 86_400_000;
const toBar = row => ({ t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[7]), closed: row[8] === '1' });

test('scanner : perpétuels USDT de cryptos seulement, triés par volume en dollars', () => {
  const inst = (instId, extra = {}) => ({ instId, state: 'live', settleCcy: 'USDT', instCategory: '1', ...extra });
  const instruments = [
    inst('BTC-USDT-SWAP'), inst('ETH-USDT-SWAP'), inst('PEPE-USDT-SWAP'), inst('USDC-USDT-SWAP'), inst('BZ-USDT-SWAP'),
    inst('XAU-USDT-SWAP', { instCategory: '4' }), inst('BTC-USD-SWAP', { settleCcy: 'BTC' }), inst('OLD-USDT-SWAP', { state: 'suspend' }),
  ];
  const tick = (instId, last, volCcy24h) => ({ instId, last: String(last), open24h: String(last * 0.98), volCcy24h: String(volCcy24h) });
  const tickers = [
    tick('BTC-USDT-SWAP', 100_000, 50_000), tick('ETH-USDT-SWAP', 4_000, 2_000_000), tick('PEPE-USDT-SWAP', 0.00001, 1e15),
    tick('USDC-USDT-SWAP', 1, 1e12), tick('BZ-USDT-SWAP', 70, 1e9), tick('XAU-USDT-SWAP', 3_000, 1e9), tick('BTC-USD-SWAP', 100_000, 1e9), tick('OLD-USDT-SWAP', 1, 1e12),
  ];
  const u = pickUniverse(instruments, tickers);
  assert.deepEqual(u.map(t => t.symbol), ['PEPE', 'ETH', 'BTC']); // 10 Md$, 8 Md$, 5 Md$
  assert.equal(u[0].volume, 1e10);
  assert.deepEqual(pickUniverse(instruments, tickers, 2).map(t => t.symbol), ['PEPE', 'ETH']);
});

test('scanner : tendance, prochain déclenchement et signal récent ou en jeu', () => {
  const now = Date.now();
  const data = setupRoutes(now);
  for (const sym of ['BTC', 'ETH', 'SOL', 'DOGE']) {
    const bars = data[sym].bars.slice(0, 300).map(toBar).reverse();
    const daily = data[sym].days.slice(0, 300).map(toBar).reverse();
    const t = { symbol: sym, last: data[sym].last, open24h: data[sym].open24h, volume: 1e6 };
    const c = coinView(t, bars, daily, now);
    assert.equal(c.symbol, sym);
    assert.equal(c.tested, sym !== 'DOGE');
    assert.ok(['haussière', 'baissière', 'neutre'].includes(c.trend));
    if (c.trend === 'neutre') assert.equal(c.trigger, null);
    if (c.trigger) {
      // Long : le déclenchement est au-dessus du prix, le stop en dessous (l'inverse pour un short).
      const s = c.dir === 'long' ? 1 : -1;
      assert.ok(s * c.trigger.distance > 0);
      assert.ok(s * (c.trigger.price - c.trigger.stop) > 0);
    }
    if (c.signal) {
      assert.ok(c.signal.outcome === 'open' || c.signal.confirmedAt >= now - RECENT_DAYS * DAY);
      assert.ok(['range20', 'range10', 'macd'].includes(c.signal.detector));
      assert.ok(Number.isFinite(c.signal.entry) && Number.isFinite(c.signal.sl) && Number.isFinite(c.signal.tp1));
    }
  }
});

test('build-scanner : fichier complet sur les réponses fictives, compressé en fin de journal sur une branche', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scanner-'));
  const root = resolve('.');
  await new Promise((ok, ko) => execFile(process.execPath, ['--import', join(root, 'tests/mock-fetch.mjs'), join(root, 'scripts/build-scanner.mjs'), '--out', dir],
    { cwd: dir, env: { ...process.env, PUBLISH: 'false' } }, (e, out) => (e ? ko(e) : ok(out))));
  const text = await readFile(join(dir, 'scanner.json'), 'utf8');
  const d = JSON.parse(text);
  // CL est une matière première (catégorie 4), BZ est écarté : seules les cryptos restent.
  assert.deepEqual(d.coins.map(c => c.symbol).sort(), ['BTC', 'DOGE', 'ETH', 'SOL']);
  assert.deepEqual(d.tested, ['BTC', 'ETH', 'SOL']);
  assert.equal(d.rules.recentDays, RECENT_DAYS);
  assert.ok(d.detectors.range20);
  const lines = (await readFile(join(dir, 'scanner-gz.txt'), 'utf8')).trim().split('\n');
  const gz = lines.map(l => l.split(' ')[3]).join('');
  assert.equal(gunzipSync(Buffer.from(gz, 'base64')).toString(), text);
});
