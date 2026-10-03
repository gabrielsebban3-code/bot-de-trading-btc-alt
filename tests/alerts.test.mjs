// Alertes Discord : seulement ce qui vient d'apparaître, jamais d'avalanche, messages épurés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALERTS, pickAlerts, toDiscord } from '../scripts/lib/alerts.mjs';

const now = Date.UTC(2026, 9, 2, 16);
const h = n => now - n * 3600e3;
const setup = (id, o = {}) => ({ id, symbol: 'BTC', dir: 'long', status: 'confirmé', outcome: 'open', time: h(1), entry: 86619.4, sl: 84000, tp: [91857, 94476, 97095], rr: 2, why: 'Cassure du plus haut de 20 jours.', detector: 'breakout', ...o });
const news = (id, o = {}) => ({ id, ids: [id], importance: 'critical', time: h(1), title: 'La Fed baisse ses taux', why: 'Argent moins cher.', impacts: [['BTC', 1]], link: 'https://ex.fr/a', sources: ['Reuters'], ...o });
const S = live => ({ live, detectors: { breakout: 'Cassure 20 jours' } });
const N = items => ({ items });

test('nouveau setup confirmé et nouvelle news critique : envoyés', () => {
  const out = pickAlerts({ setups: S([setup('a'), setup('b')]), prevSetups: S([setup('a')]), news: N([news('n1')]), prevNews: N([]), now });
  assert.deepEqual(out.map(a => a.item.id), ['b', 'n1']);
  assert.equal(out[0].detector, 'Cassure 20 jours');
});

test('rien à envoyer : déjà vu, en cours, terminé, trop vieux, pas critique', () => {
  const out = pickAlerts({
    setups: S([setup('a'), setup('c', { status: 'en cours' }), setup('d', { outcome: 'sl' }), setup('e', { time: h(30) })]),
    prevSetups: S([setup('a')]),
    news: N([news('n1', { ids: ['n1', 'n2'] }), news('n3', { importance: 'medium' }), news('n4', { time: h(7) })]),
    prevNews: N([news('n2')]),
    now,
  });
  assert.deepEqual(out, []);
});

test('signal journalier : l\'âge compte depuis la clôture de la journée', () => {
  const day = setup('j', { time: h(25), confirmedAt: h(1) });
  assert.deepEqual(pickAlerts({ setups: S([day]), prevSetups: S([]), news: null, prevNews: null, now }).map(a => a.item.id), ['j']);
});

test('premier passage (pas de version en ligne) : aucune alerte', () => {
  assert.deepEqual(pickAlerts({ setups: S([setup('a')]), prevSetups: null, news: N([news('n1')]), prevNews: null, now }), []);
});

test('jamais plus de 5 messages d\'un coup, les plus récents', () => {
  const items = Array.from({ length: 8 }, (_, k) => news(`n${k}`, { time: h(5 - k * 0.5) }));
  const out = pickAlerts({ news: N(items), prevNews: N([]), now });
  assert.equal(out.length, ALERTS.maxPerRun);
  assert.equal(out.at(-1).item.id, 'n7');
});

test('message Discord : vert pour un long, rouge pour un short, lien vers le setup', () => {
  const long = toDiscord({ kind: 'setup', item: setup('BTC-1'), detector: 'Cassure 20 jours' }, 'https://site.fr/dinexo');
  assert.equal(long.color, 0x22c55e);
  assert.equal(long.title, 'BTC · Long · Cassure 20 jours');
  assert.equal(long.url, 'https://site.fr/dinexo/#setup/BTC-1');
  assert.deepEqual(long.fields.map(f => f.value), ['86 619', '84 000', '1:2', '91 857 · 94 476 · 97 095']);
  assert.equal(toDiscord({ kind: 'setup', item: setup('x', { dir: 'short' }) }).color, 0xef4444);
  const n = toDiscord({ kind: 'news', item: news('n1') });
  assert.match(n.title, /^Critique · La Fed/);
  assert.match(n.description, /Impact probable : BTC ▲/);
  assert.match(n.footer.text, /Reuters · Pas un conseil financier/);
});

// Lance scripts/send-alerts.mjs contre un faux Discord qui répond `status`.
// Par défaut à 6 h, heure de Paris : avant le résumé du matin.
async function sendAlerts({ status = 204, state, hook = true, at = Date.UTC(2026, 9, 3, 4) } = {}) {
  const got = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      got.push(JSON.parse(body));
      res.writeHead(status, { 'content-type': 'application/json' }).end(status < 300 ? '' : '{"message": "Unknown Webhook", "code": 10015}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'dinexo-alerts-'));
  await mkdir(join(dir, 'previous'));
  if (state) await writeFile(join(dir, 'previous', 'alerts.json'), JSON.stringify(state));
  const env = { ...process.env, DISCORD_WEBHOOK_URL: hook ? `http://127.0.0.1:${server.address().port}/api/webhooks/1/abc` : '' };
  const script = fileURLToPath(new URL('../scripts/send-alerts.mjs', import.meta.url));
  const log = await new Promise((resolve, reject) => execFile(process.execPath, [script, '--data', join(dir, 'site'), '--previous', join(dir, 'previous'), '--site', 'https://site.fr/dinexo', '--now', String(at)], { env }, (err, out) => (err ? reject(err) : resolve(out))));
  server.close();
  const saved = await readFile(join(dir, 'site', 'alerts.json'), 'utf8').then(JSON.parse).catch(() => null);
  return { got, log, saved };
}

test('premier passage avec le lien : un message de bienvenue, une seule fois', async () => {
  const first = await sendAlerts();
  assert.equal(first.got.length, 1);
  assert.equal(first.got[0].username, 'Dinexo');
  assert.equal(first.got[0].embeds[0].title, 'Dinexo est branché sur ce salon');
  assert.equal(first.got[0].embeds[0].url, 'https://site.fr/dinexo/');
  assert.match(first.log, /Message de bienvenue envoyé/);
  assert.ok(!Number.isNaN(Date.parse(first.saved.connected)));

  const next = await sendAlerts({ state: first.saved });
  assert.equal(next.got.length, 0);
  assert.deepEqual(next.saved, first.saved);
});

test('lien refusé par Discord : rien de retenu, nouvel essai au passage suivant', async () => {
  const { got, log, saved } = await sendAlerts({ status: 404 });
  assert.equal(got.length, 1);
  assert.match(log, /::warning::Discord a refusé un message \(404 Unknown Webhook\)/);
  assert.match(log, /::warning::Bienvenue non envoyée/);
  assert.equal(saved, null);
});

test('sans lien : aucun message, état gardé', async () => {
  const { got, log, saved } = await sendAlerts({ hook: false, state: { connected: '2026-10-02T20:30:00.000Z' } });
  assert.equal(got.length, 0);
  assert.match(log, /Pas de DISCORD_WEBHOOK_URL/);
  assert.deepEqual(saved, { connected: '2026-10-02T20:30:00.000Z' });
});

test('résumé du matin : une fois par jour après 7 h, retenu dans l\'état', async () => {
  const state = { connected: '2026-10-02T20:30:00.000Z' };
  const morning = await sendAlerts({ state, at: Date.UTC(2026, 9, 3, 6, 30) });
  assert.equal(morning.got.length, 1);
  assert.match(morning.got[0].embeds[0].title, /^Résumé du samedi 3 octobre/);
  assert.equal(morning.got[0].embeds[1].title, 'Situation géopolitique');
  assert.equal(morning.saved.digest, '2026-10-03');
  assert.match(morning.log, /Résumé du 2026-10-03 envoyé/);

  const later = await sendAlerts({ state: morning.saved, at: Date.UTC(2026, 9, 3, 9) });
  assert.equal(later.got.length, 0);
});
