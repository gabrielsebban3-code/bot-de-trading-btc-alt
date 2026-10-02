// Watchlist : symboles, fusion à la connexion, enregistrement sur l'appareil, news qui touchent la watchlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT, MAX, createWatchlist, merge, normalize, star, toggle, touches } from '../js/watchlist.js';

const memory = (init = {}) => {
  const data = { ...init };
  return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
};

test('symboles : majuscules, sans $, sans doublon, 50 au plus', () => {
  assert.deepEqual(normalize([' btc', '$sol', 'BTC', 'eth', '', 'not valid', 'x'.repeat(16), null, 42]), ['BTC', 'SOL', 'ETH', '42']);
  assert.deepEqual(normalize('BTC'), [], 'pas une liste');
  assert.equal(normalize(Array.from({ length: 80 }, (_, k) => `T${k}`)).length, MAX);
  assert.deepEqual(toggle(['BTC', 'ETH'], 'eth'), ['BTC']);
  assert.deepEqual(toggle(['BTC'], '$cl'), ['BTC', 'CL']);
});

test('première connexion : la liste du compte, puis ce qui a été ajouté sur l\'appareil', () => {
  assert.deepEqual(merge(['ETH', 'CL'], ['BTC', 'ETH', 'SOL']), ['ETH', 'CL', 'BTC', 'SOL']);
  assert.deepEqual(merge([], ['BTC']), ['BTC'], 'nouveau compte : la liste de l\'appareil');
  assert.deepEqual(merge(null, undefined), []);
});

test('createWatchlist : liste par défaut, enregistrement, abonnés avec l\'origine du changement', () => {
  const storage = memory();
  const wl = createWatchlist(storage);
  assert.deepEqual(wl.get(), DEFAULT, 'première visite');
  const seen = [];
  wl.subscribe((list, source) => seen.push([list.join(), source]));
  wl.toggle('cl');
  assert.ok(wl.has('CL') && wl.has('$cl'));
  assert.equal(storage.data['dinexo-watchlist'], '["BTC","ETH","SOL","CL"]');
  wl.set(['ETH'], 'account');
  assert.equal(wl.set(['ETH'], 'account'), false, 'même liste : personne n\'est prévenu');
  assert.deepEqual(seen, [['BTC,ETH,SOL,CL', 'user'], ['ETH', 'account']]);
  assert.deepEqual(createWatchlist(storage).get(), ['ETH'], 'relue à la visite suivante');
  assert.deepEqual(createWatchlist(memory({ 'dinexo-watchlist': '[]' })).get(), [], 'une liste vidée reste vide');
  assert.deepEqual(createWatchlist(memory({ 'dinexo-watchlist': '{oups' })).get(), DEFAULT, 'valeur abîmée');
  const blocked = { getItem() { throw new Error('bloqué'); }, setItem() { throw new Error('bloqué'); } };
  const wl2 = createWatchlist(blocked);
  wl2.toggle('NG');
  assert.ok(wl2.has('NG'), 'navigation privée : la liste marche pour la visite');
});

test('touches : impact sur un actif suivi, pétrole pour le WTI et le Brent, projet suivi', () => {
  const item = (impacts, projectId = null) => ({ impacts, projectId });
  assert.ok(touches(item([['BTC', -1]]), ['BTC']));
  assert.ok(!touches(item([['Crypto', 1]]), ['BTC']), '« Crypto » en général ne suffit pas');
  assert.ok(touches(item([['Pétrole', 1], ['Or', 1]]), ['CL']));
  assert.ok(touches(item([['Gaz', 1]]), ['NG']));
  assert.ok(!touches(item([['Pétrole', 1]]), ['NG']));
  assert.ok(touches(item([], 'nebula-dex'), ['NBL'], id => (id === 'nebula-dex' ? 'NBL' : null)));
  assert.ok(!touches(item([], null), ['BTC'], () => null));
});

test('étoile : symbole vérifié, état et libellé', () => {
  assert.equal(star('bad symbol!'), '', 'pas d\'étoile pour un symbole invalide');
  assert.match(star('btc'), /data-sym="BTC" aria-pressed="true"/);
  assert.match(star('NG', { text: true }), /aria-pressed="false".*Suivre/s);
});

test('schéma Supabase : chaque compte ne touche que sa ligne, l\'admin lit tout', async () => {
  const sql = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  assert.match(sql, /alter table public\.profiles enable row level security/);
  assert.match(sql, /alter table public\.admins enable row level security/);
  assert.match(sql, /grant update \(watchlist, updated_at\) on public\.profiles to authenticated/, 'pas de mise à jour de l\'adresse ni de l\'identifiant');
  assert.match(sql, /using \(id = \(select auth\.uid\(\)\) or \(select public\.is_admin\(\)\)\)/);
  assert.match(sql, /revoke all on public\.admins from anon, authenticated/, 'adresses des admins invisibles');
  assert.match(sql, /'\^\[A-Z0-9\]\{1,15\}\$'/, 'mêmes règles de symbole que le site');
  assert.ok(!/@/.test(sql), 'aucune adresse e-mail dans le dépôt public');
});
