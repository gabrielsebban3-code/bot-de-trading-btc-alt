// Onglet Académie : formation gratuite pour apprendre à trader et investir, de zéro à son propre plan.
// Ancres : #academie (plan du cours), #academie/l-1-3 (leçon 1.3), #academie/q1 (quiz du module 1),
// #academie/x3 (exercice du module 3), #academie/exam (examen final).
// Le contenu (≈ 370 Ko) n'est chargé qu'à la première ouverture de l'onglet. La progression reste sur l'appareil.
import { esc } from './format.js';

const KEY = 'dinexo-academie';
const EXAM_N = 30;
const $ = id => document.getElementById(id);
let data = null;
let done = {};
try { done = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { done = {}; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(done)); } catch { /* stockage indisponible */ } };
const openMods = new Set([0, 1]);

const lid = (m, i) => `${m}-${i + 1}`;
const href = id => `#academie/${id}`;

// Parcours dans l'ordre : leçons écrites, puis exercice, quiz, et l'examen à la fin.
function course() {
  const { MODS, L, QUIZ, EX } = data;
  const order = [];
  for (const m of MODS) {
    m.l.forEach((_, i) => { if (L[lid(m.n, i)]) order.push({ id: 'l-' + lid(m.n, i), type: 'l', m }); });
    if (m.ex && EX[m.n]) order.push({ id: 'x' + m.n, type: 'x', m });
    if (m.quiz && QUIZ[m.n]) order.push({ id: 'q' + m.n, type: 'q', m });
    if (m.exam) order.push({ id: 'exam', type: 'e', m });
  }
  return order;
}

function next(id) {
  const order = course();
  const n = order[order.findIndex(x => x.id === id) + 1];
  if (!n) return { label: 'Retour au plan', to: '#academie' };
  const label = { l: 'Leçon suivante', x: 'Exercice pratique', q: `Quiz du module ${n.m.n}`, e: 'Examen final' }[n.type];
  return { label, to: href(n.id) };
}

const readCount = () => Object.keys(data.L).filter(k => done['l-' + k]).length;

function renderPlan(root) {
  const { PARTS, MODS, L, QUIZ, EX } = data;
  const total = Object.keys(L).length;
  const pct = Math.round(readCount() / total * 100);
  const nQuiz = MODS.filter(m => m.quiz).length;
  const row = (id, title, tag, cls = '') => `<li class="${done[id] ? 'done' : ''}"><a href="${href(id)}"><span class="ac-dot">${done[id] ? '✓' : ''}</span><span>${title}</span><span class="ac-tag ${cls}">${tag}</span></a></li>`;
  const mod = n => {
    const m = MODS[n];
    const read = m.l.filter((_, i) => done['l-' + lid(n, i)]).length;
    const items = m.l.map((t, i) => row('l-' + lid(n, i), `${n}.${i + 1} · ${esc(t)}`, `${L[lid(n, i)].min} min`));
    if (m.ex && EX[n]) items.push(row('x' + n, esc(m.ex), 'pratique', 'q'));
    if (m.quiz && QUIZ[n]) items.push(row('q' + n, `Quiz du module ${n}`, `${QUIZ[n].length} questions`, 'q'));
    if (m.exam) items.push(row('exam', 'Examen final', `${EXAM_N} questions`, 'q'));
    const sub = m.exam ? m.d : `${esc(m.d)} · ${m.l.length} leçons · ${read}/${m.l.length} lues`;
    const open = openMods.has(n);
    return `<div class="ac-mod${open ? ' open' : ''}"><button type="button" data-m="${n}" aria-expanded="${open}"><span class="ac-n">${String(n).padStart(2, '0')}</span><span class="ac-t"><b>${esc(m.t)}</b><span>${sub}</span></span><span class="ac-chev" aria-hidden="true">›</span></button><ul>${items.join('')}</ul></div>`;
  };
  root.innerHTML = `
  <h1>Académie Dinexo</h1>
  <div class="ac-intro">
    <p>Apprendre à trader et à investir, de zéro à ta propre méthode. ${MODS.length} modules en français simple : comment marche le marché, lire un graphique, protéger son argent, la price action avancée, puis investir sur le long terme.</p>
    <div class="ac-stats"><span><b>${total}</b> leçons</span><span><b>${nQuiz}</b> quiz</span><span><b>${Object.keys(EX).length}</b> exercices</span><span><b>1</b> examen final</span><span><b>${pct} %</b> terminé</span></div>
    <div class="ac-track" aria-hidden="true"><i style="width:${pct}%"></i></div>
  </div>
  <div class="ac-parts">${PARTS.map(p => `<section><h2>${esc(p.name)}</h2><div class="ac-mods">${p.mods.map(mod).join('')}</div></section>`).join('')}</div>
  <div class="nfa">⚠ Formation éducative, pas un conseil financier. Les cryptos sont très volatiles : n'investis que ce que tu peux te permettre de perdre.</div>`;
  root.querySelectorAll('.ac-mod > button').forEach(b => b.addEventListener('click', () => {
    const n = Number(b.dataset.m);
    if (openMods.has(n)) openMods.delete(n); else openMods.add(n);
    b.parentElement.classList.toggle('open', openMods.has(n));
    b.setAttribute('aria-expanded', String(openMods.has(n)));
  }));
}

const crumb = text => `<div class="ac-crumb"><a href="#academie">Plan du cours</a><span aria-hidden="true">›</span><span>${text}</span></div>`;

function renderLesson(root, key) {
  const [mn, li] = key.split('-').map(Number);
  const m = data.MODS[mn], les = data.L[key];
  if (!m || !les) return renderPlan(root);
  const id = 'l-' + key;
  const nx = next(id);
  root.innerHTML = `
  <article class="ac-lesson">
    ${crumb(`Module ${mn} · ${esc(m.t)}`)}
    <h1>${esc(m.l[li - 1])}</h1>
    <div class="ac-meta">Leçon ${mn}.${li} · ${les.min} min de lecture</div>
    <div class="ac-body">
      ${les.body}
      <div class="ac-box key"><h3>À retenir</h3>${les.key}</div>
      ${les.warn ? `<div class="ac-box warn"><h3>Attention</h3>${les.warn}</div>` : ''}
      ${les.site ? `<div class="ac-box site"><h3>Sur Dinexo</h3>${les.site}</div>` : ''}
    </div>
    <div class="ac-actions">
      <button type="button" class="ac-btn${done[id] ? ' ok' : ''}" id="ac-mark">${done[id] ? '✓ Leçon lue' : 'Marquer comme lue'}</button>
      <a class="ac-btn main" href="${nx.to}" id="ac-next">${nx.label} →</a>
    </div>
  </article>`;
  $('ac-mark').addEventListener('click', e => {
    done[id] = !done[id];
    save();
    e.currentTarget.className = 'ac-btn' + (done[id] ? ' ok' : '');
    e.currentTarget.textContent = done[id] ? '✓ Leçon lue' : 'Marquer comme lue';
  });
  $('ac-next').addEventListener('click', () => { if (!done[id]) { done[id] = true; save(); } });
  if (root.querySelector('#c-cap')) setupCalc();
}

// Calculette de la leçon 5.3 : taille de position = montant risqué ÷ distance du stop.
export function positionSize(capital, riskPct, stopPct) {
  if (!(capital > 0 && riskPct > 0 && stopPct > 0)) return null;
  const risk = capital * riskPct / 100;
  const size = risk / (stopPct / 100);
  return { risk, size, leverage: size > capital ? Math.ceil(size / capital) : 0 };
}

function setupCalc() {
  const f = v => v.toLocaleString('fr-FR', { maximumFractionDigits: 0 });
  const run = () => {
    const r = positionSize(Number($('c-cap').value), Number($('c-risk').value), Number($('c-stop').value));
    const out = $('c-out');
    if (!r) { out.textContent = 'Remplis les trois cases avec des nombres plus grands que zéro.'; return; }
    const lev = r.leverage ? ` Elle est plus grosse que ton capital : il faudrait un levier d'au moins ${r.leverage}.` : ' Pas besoin de levier.';
    out.innerHTML = `Tu risques <b>${f(r.risk)} €</b>. Taille de position : <b>${f(r.size)} €</b>.${lev}`;
  };
  ['c-cap', 'c-risk', 'c-stop'].forEach(i => $(i).addEventListener('input', run));
  run();
}

// 30 questions tirées au hasard parmi tous les quiz.
export function examQuestions(QUIZ, n = EXAM_N, rand = Math.random) {
  const pool = Object.values(QUIZ).flat();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}

// Quiz, exercice ou examen : mêmes questions à toucher, avec l'explication juste après la réponse.
function renderTest(root, kind, n) {
  const { MODS, QUIZ, EX } = data;
  const m = kind === 'exam' ? MODS[MODS.length - 1] : MODS[n];
  const qs = kind === 'q' ? QUIZ[n] : kind === 'x' ? EX[n]?.qs : examQuestions(QUIZ);
  if (!m || !qs) return renderPlan(root);
  const id = kind === 'exam' ? 'exam' : kind + n;
  const nx = next(id);
  const title = kind === 'q' ? `Quiz du module ${n}` : kind === 'x' ? m.ex : 'Examen final';
  const pass = kind === 'exam' ? Math.ceil(qs.length * 0.8) : qs.length - 1;
  const intro = kind === 'x' ? `<div class="ac-body">${EX[n].intro}</div>`
    : kind === 'exam' ? `<div class="ac-body"><p>${qs.length} questions tirées au hasard dans tous les modules. Il faut ${pass} bonnes réponses (80 %) pour réussir. Chaque nouvelle visite tire d'autres questions.</p></div>` : '';
  const answers = {};
  root.innerHTML = `
  <article class="ac-lesson">
    ${crumb(kind === 'exam' ? 'Examen final' : `Module ${n} · ${esc(m.t)}`)}
    <h1>${esc(title)}</h1>
    <div class="ac-meta">${qs.length} ${kind === 'x' ? 'situations' : 'questions'} · touche une réponse</div>
    ${intro}
    <div class="ac-qs">${qs.map((q, i) => `
      <div class="ac-q" data-i="${i}"><p>${i + 1}. ${esc(q.q)}</p><div class="ac-opts">${q.o.map((o, j) => `<button type="button" class="ac-opt" data-j="${j}">${esc(o)}</button>`).join('')}</div><div class="ac-why" hidden></div></div>`).join('')}
    </div>
    <div class="ac-actions"><span class="ac-score" id="ac-score">0 / ${qs.length}</span><a class="ac-btn main" href="${nx.to}">${nx.label} →</a></div>
  </article>`;
  root.querySelectorAll('.ac-q').forEach(el => {
    const i = Number(el.dataset.i), q = qs[i];
    el.querySelectorAll('.ac-opt').forEach(b => b.addEventListener('click', () => {
      if (i in answers) return;
      const j = Number(b.dataset.j);
      answers[i] = j;
      el.querySelectorAll('.ac-opt').forEach((x, k) => {
        x.disabled = true;
        if (k === q.a) x.classList.add('good'); else if (k === j) x.classList.add('bad');
      });
      const why = el.querySelector('.ac-why');
      why.hidden = false;
      why.textContent = (j === q.a ? 'Bonne réponse. ' : 'Pas tout à fait. ') + q.w;
      const good = Object.entries(answers).filter(([k, v]) => qs[k].a === v).length;
      const sc = $('ac-score');
      sc.textContent = `${good} / ${qs.length}`;
      if (Object.keys(answers).length === qs.length) {
        const ok = good >= pass;
        sc.textContent += ok ? (kind === 'exam' ? ' · examen réussi, bravo !' : ' · validé') : ' · relis les leçons citées';
        if (ok) { done[id] = true; save(); }
      }
    }));
  });
}

export async function renderAcademie(id = '') {
  const root = $('academie');
  if (!data) {
    root.innerHTML = '<p class="muted">Chargement de la formation…</p>';
    try { data = await import('./academie-data.js'); } catch {
      root.innerHTML = '<p class="muted">La formation n\'a pas pu se charger. Vérifie ta connexion puis recharge la page.</p>';
      return;
    }
    if (location.hash.split('/')[0] !== '#academie') return; // on a quitté l'onglet pendant le chargement
  }
  if (id.startsWith('l-')) renderLesson(root, id.slice(2));
  else if (/^[qx]\d+$/.test(id)) renderTest(root, id[0], Number(id.slice(1)));
  else if (id === 'exam') renderTest(root, 'exam');
  else renderPlan(root);
}
