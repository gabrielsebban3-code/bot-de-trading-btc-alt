// Onglet Académie : contenu de la formation et calculs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODS, PARTS, L, QUIZ, EX } from '../js/academie-data.js';
import { examQuestions, positionSize } from '../js/academie.js';

const TABS = ['resume', 'marche', 'projets', 'setups', 'actu', 'heatmap', 'outils', 'historique', 'scanner', 'impots', 'premium', 'academie', 'compte'];

test('plan : chaque module est dans une partie, chaque leçon est écrite', () => {
  assert.deepEqual(PARTS.flatMap(p => p.mods).sort((a, b) => a - b), MODS.map(m => m.n));
  MODS.forEach((m, i) => assert.equal(m.n, i));
  const ids = MODS.flatMap(m => m.l.map((_, i) => `${m.n}-${i + 1}`));
  assert.deepEqual(Object.keys(L).sort(), ids.sort());
  for (const m of MODS) {
    if (m.quiz) assert.ok(QUIZ[m.n], `quiz du module ${m.n}`);
    if (m.ex) assert.ok(EX[m.n], `exercice du module ${m.n}`);
  }
});

test('leçons : texte complet, pas de code oublié, liens vers de vrais onglets', () => {
  for (const [k, les] of Object.entries(L)) {
    assert.ok(les.min >= 3 && les.min <= 10, `${k} durée`);
    assert.ok(les.body.length > 800, `${k} trop courte`);
    assert.ok(les.key, `${k} à retenir`);
    for (const part of [les.body, les.key, les.warn || '', les.site || '']) {
      assert.ok(!part.includes('${') && !part.includes('undefined'), `${k} contient du code`);
      for (const [, tab] of part.matchAll(/href="#([^"/]+)/g)) assert.ok(TABS.includes(tab), `${k} lien #${tab}`);
    }
  }
});

test('quiz et exercices : une bonne réponse valide et une explication', () => {
  const all = [...Object.values(QUIZ).flat(), ...Object.values(EX).flatMap(e => e.qs)];
  assert.ok(all.length > 80);
  for (const q of all) {
    assert.ok(q.o.length >= 2 && Number.isInteger(q.a) && q.a >= 0 && q.a < q.o.length, q.q);
    assert.equal(new Set(q.o).size, q.o.length, `réponses en double : ${q.q}`);
    assert.ok(q.w.length > 20, `explication : ${q.q}`);
  }
});

test('examen : 30 questions différentes tirées des quiz', () => {
  let seed = 1;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const qs = examQuestions(QUIZ, 30, rand);
  assert.equal(qs.length, 30);
  assert.equal(new Set(qs).size, 30);
  const pool = new Set(Object.values(QUIZ).flat());
  qs.forEach(q => assert.ok(pool.has(q)));
});

test('taille de position : montant risqué ÷ distance du stop', () => {
  assert.deepEqual(positionSize(2000, 1, 2), { risk: 20, size: 1000, leverage: 0 });
  assert.deepEqual(positionSize(1000, 1, 0.5), { risk: 10, size: 2000, leverage: 2 });
  assert.equal(positionSize(0, 1, 2), null);
  assert.equal(positionSize(1000, 1, 0), null);
});
