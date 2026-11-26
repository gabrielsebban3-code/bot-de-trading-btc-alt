import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCode, durationText, inviteFromHash, inviteLink, inviteState, redeemText, storedInvite, INVITE_MS } from '../js/invite.js';

test('le code se lit dans #premium/CODE, et seulement là', () => {
  assert.equal(inviteFromHash('#premium/61d3ae39c41b4235'), '61D3AE39C41B4235');
  assert.equal(inviteFromHash('#premium'), null);
  assert.equal(inviteFromHash('#paire/61D3AE39C41B4235'), null);
  assert.equal(inviteFromHash('#premium/abc'), null);
  assert.equal(inviteFromHash('#premium/<script>xx'), null);
  assert.equal(cleanCode(42), null);
});

test('le lien garde l\'adresse du site sans ancre ni paramètres', () => {
  assert.equal(inviteLink('https://ex.io/site/?code=1#compte', 'ABCD1234'), 'https://ex.io/site/#premium/ABCD1234');
});

test('invitation gardée une semaine sur l\'appareil', () => {
  const now = 1_000_000_000_000;
  assert.equal(storedInvite(JSON.stringify({ code: 'ABCD1234', at: now - 1000 }), now), 'ABCD1234');
  assert.equal(storedInvite(JSON.stringify({ code: 'ABCD1234', at: now - INVITE_MS - 1 }), now), null);
  assert.equal(storedInvite('pas du json', now), null);
  assert.equal(storedInvite(null, now), null);
});

test('messages d\'activation et de refus', () => {
  assert.match(redeemText({ ok: true, until: '2026-12-09' }), /Bienvenue.*9 décembre 2026/);
  assert.match(redeemText({ ok: true, until: null }), /sans date de fin/);
  assert.match(redeemText({ ok: true, again: true, until: null }), /déjà activée/);
  assert.match(redeemText({ ok: false, reason: 'full' }), /places/);
  assert.match(redeemText({ ok: false, reason: 'expired' }), /expiré/);
  assert.match(redeemText(null), /pas pu/);
});

test('état et durée d\'un lien pour l\'admin', () => {
  const inv = { active: true, expires: '2026-12-01', uses: 1, max_uses: 10 };
  assert.equal(inviteState(inv, '2026-11-09'), 'actif');
  assert.equal(inviteState({ ...inv, expires: '2026-11-08' }, '2026-11-09'), 'expiré');
  assert.equal(inviteState({ ...inv, uses: 10 }, '2026-11-09'), 'complet');
  assert.equal(inviteState({ ...inv, active: false }, '2026-11-09'), 'arrêté');
  assert.equal(durationText(30), '1 mois');
  assert.equal(durationText(null), 'sans fin');
  assert.equal(durationText(45), '45 jours');
});
