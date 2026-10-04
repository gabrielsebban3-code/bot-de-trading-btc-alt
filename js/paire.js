// Fiche d'une paire de l'onglet Setups (#paire/<symbole>) : où en est le signal, graphique avec les niveaux
// qui le déclencheraient et les trades passés, règles expliquées avec les chiffres du moment, bilan de la paire.
import { ago, esc, fmt, pct } from './format.js';
import { drawCandles } from './candles.js';
import { macdOf } from './crypto-lib.js';
import { star } from './watchlist.js';
import { OUTCOME, TREND, cap, dirTag, lastTradeOf, liveOf, okxUrl, outcomeCls, parisDay, plainPct, px, radarBody, setupsData } from './setups.js';

const $ = id => document.getElementById(id);
const DAY = 86_400_000;
const PERIODS = [['1 mois · 4 h', 'h4', 180], ['3 mois · 4 h', 'h4', 540], ['1 an · jour', 'd1', 365]];
const CRYPTO = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana' }; // fiches de l'onglet Marché
const STORE = 'dinexo-paire';
const state = (() => { try { return { period: '1 mois · 4 h', ...JSON.parse(localStorage.getItem(STORE)) }; } catch { return { period: '1 mois · 4 h' }; } })();
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* stockage indisponible */ } };
const cache = new Map(); // fiches déjà chargées, gardées 10 minutes
let current = null;

// Même moyenne exponentielle que le calcul des signaux (amorcée sur la première clôture).
const ema = (values, n) => { const k = 2 / (n + 1); let e = null; return values.map(v => (e = e === null ? v : v * k + e * (1 - k))); };
const row = (k, v, cls = '') => `<dt>${k}</dt><dd class="${cls}">${v}</dd>`;

export async function loadPaire(sym) {
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < 600_000) return hit.d;
  const res = await fetch(`data/paire/${encodeURIComponent(sym)}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(String(res.status));
  const d = await res.json();
  cache.set(sym, { at: Date.now(), d });
  return d;
}

export async function renderPaire(sym) {
  const el = $('paire');
  const data = setupsData();
  const a = data?.assets.find(x => x.symbol === sym);
  if (!a) {
    el.innerHTML = `<div class="box"><div class="empty">${data ? 'Cette paire n\'est pas suivie dans l\'onglet Setups.' : 'Les setups ne sont pas encore disponibles : reviens dans quelques minutes.'} <a href="#setups">Retour aux setups →</a></div></div>`;
    return;
  }
  current = { a, d: null };
  el.innerHTML = page(a, null);
  try {
    const d = await loadPaire(sym);
    if (current?.a !== a) return; // une autre fiche a été ouverte entre-temps
    current.d = d;
    el.innerHTML = page(a, d);
    chart();
  } catch {
    $('pa-chart').innerHTML = '<div class="empty">Graphique indisponible pour le moment.</div>';
  }
}

function page(a, d) {
  const data = setupsData();
  const r = a.radar;
  const live = liveOf(a.symbol);
  const others = data.assets.filter(x => x.symbol !== a.symbol);
  return `
    <div class="ph"><h1>${esc(a.name)}</h1><span class="mono muted">${esc(a.symbol)}</span>
      ${r ? `<span class="tag ${TREND[r.trend]}">Tendance ${esc(r.trend)}</span>` : ''}${star(a.symbol, { text: true })}</div>
    <div class="ind-head"><span class="v num">${px(a.price)}</span>
      <span class="chg num"><span>24 h <b>${pct(a.change24h ?? null)}</b></span></span>
      <span class="muted">perpétuel OKX · mis à jour ${ago(data.generatedAt)}</span></div>
    <div class="nfa">⚠ Ceci n'est pas un conseil financier. Fais tes propres recherches avant tout investissement.</div>
    <div class="box pa-now"><h2>En ce moment</h2><div class="pa-state">${radarBody(a)}
      ${live ? `<a class="chip" href="#setup/${encodeURIComponent(live.id)}">Voir le trade en jeu →</a>` : ''}</div></div>
    <div class="box mk cx-box">
      <div class="tools" id="pa-periods" role="group" aria-label="Période">${PERIODS.map(([l]) => `<button type="button" class="chip" data-pap="${l}" aria-pressed="${state.period === l}">${l}</button>`).join('')}</div>
      <div class="cx-chart" id="pa-chart">${d ? '' : '<div class="empty">Chargement du graphique…</div>'}</div>
      <p class="fine pa-legend">${legend(a, live)}</p>
    </div>
    <div class="detail">
      <div class="stack">
        ${rulesBox(a, d)}
        ${manageBox(a, d, live)}
      </div>
      <div class="stack">
        ${statsBox(a)}
        <div class="box"><h2>Liens</h2><div class="links">
          <a class="buy" href="${okxUrl(a.symbol)}" target="_blank" rel="noopener">Ouvrir sur OKX</a>
          ${CRYPTO[a.symbol] ? `<a class="chip" href="#crypto/${CRYPTO[a.symbol]}">Fiche ${esc(a.name)} →</a>` : a.symbol === 'BZ' ? '<a class="chip" href="#indicateur/brent">Cours du Brent →</a>' : ''}
          <a class="chip" href="#historique">Bilan de tous les setups →</a></div>
          <p class="txt muted pa-others">Autres paires : ${others.map(x => `<a href="#paire/${encodeURIComponent(x.symbol)}">${esc(x.symbol)}</a>`).join(' · ')}</p></div>
      </div>
    </div>
    ${tradesBox(a)}
    <p class="fine">Source gratuite : bougies du perpétuel ${esc(a.symbol)}-USDT sur OKX. Fiche mise à jour toutes les heures.</p>`;
}

function legend(a, live) {
  const past = 'Les flèches montrent les trades passés : vertes s\'ils ont gagné, rouges s\'ils ont perdu.';
  if (live) return `Les pointillés montrent l'entrée, le stop et l'objectif du trade en cours. ${past}`;
  if (a.radar?.trend === 'neutre' || !a.radar) return `Les deux courbes sont les moyennes des 20 et 50 derniers jours : elles montrent si le marché monte ou baisse. ${past}`;
  return `Les pointillés orange montrent le prix à dépasser pour le prochain signal, le rouge le stop prévu. Les deux courbes sont les moyennes des 20 et 50 derniers jours. ${past}`;
}

// Les règles du signal, dites simplement, avec les chiffres de la paire en ce moment.
function rulesBox(a, d) {
  const r = a.radar;
  const days = d ? d.d1.filter(b => b[6] !== 0) : [];
  const closes = days.map(b => b[4]);
  const e50 = ema(closes, 50).at(-1), last = closes.at(-1);
  // ✓ / ✗ : condition remplie ou non en ce moment ; • : vérifiée au moment du signal.
  const ok = v => `<span class="pa-ck ${v === null ? 'info' : v ? 'yes' : 'no'}" aria-hidden="true">${v === null ? '•' : v ? '✓' : '✗'}</span>`;
  const trendOn = r && r.trend !== 'neutre';
  const up = r?.dir === 'long';
  const live = liveOf(a.symbol);
  const trendText = !r ? '' : trendOn
    ? `${days.length >= 50 ? `Hier, le prix a clôturé à ${px(last)}, ${up ? 'au-dessus' : 'en dessous'} de sa moyenne des 50 derniers jours (${px(e50)}). ` : ''}Le marché ${up ? 'monte' : 'baisse'} : on ne cherche que des <b>${up ? 'achats' : 'ventes'}</b>.`
    : 'Le marché n\'a pas de direction claire : pas de trade tant que ça dure.';
  const lv = key => r?.levels?.find(l => l.key === key);
  const levelText = l => {
    if (!l) return '';
    const dist = l.price / a.price - 1;
    const passed = up ? dist <= 0 : dist >= 0;
    return passed ? ` Déjà dépassé : il faudra un nouveau ${up ? 'plus haut' : 'plus bas'}.` : ` Aujourd'hui : <b>${px(l.price)}</b> (${plainPct(dist)}).`;
  };
  const word = up ? 'dépasse son plus haut' : 'passe sous son plus bas';
  const triggers = trendOn ? `
      <li>Le prix ${word} du dernier mois.${levelText(lv('range20'))}</li>
      <li>Le prix ${word} des 10 derniers jours.${levelText(lv('range10'))}</li>
      <li>Après une petite ${up ? 'baisse' : 'hausse'}, le prix repart ${up ? 'à la hausse' : 'à la baisse'} (indicateur MACD).
        ${r.macdReady ? `C'est le moment : la petite ${up ? 'baisse' : 'hausse'} a eu lieu.` : `Pas encore : il faut d'abord une petite ${up ? 'baisse' : 'hausse'}.`}</li>`
    : '<li>Rien à surveiller tant que le marché n\'a pas de direction.</li>';
  return `<div class="box"><h2>Comment le signal se déclenche</h2><ol class="pa-rules">
    <li>${ok(trendOn)}<div><b>1. Le marché doit ${up || !trendOn ? 'monter' : 'baisser'}${trendOn ? '' : ' ou baisser'}</b><span>${trendText}</span></div></li>
    <li>${ok(trendOn ? null : false)}<div><b>2. Un signal parmi ces trois</b><span>Vérifié à la clôture de chaque bougie de 4 heures.</span><ul>${triggers}</ul></div></li>
    <li>${ok(null)}<div><b>3. Pas d'obstacle proche</b><span>Le signal est ignoré si un ancien ${up ? 'sommet' : 'creux'} ou un chiffre rond est juste ${up ? 'au-dessus' : 'en dessous'} du prix.</span></div></li>
    <li>${ok(!live)}<div><b>4. Un seul trade à la fois sur ${esc(a.symbol)}</b><span>${live ? 'Un trade est déjà en cours : pas de nouveau signal avant sa fin.' : 'Aucun trade en cours : la paire est libre.'}</span></div></li>
  </ol><p class="txt muted">Il faut les 4 en même temps : c'est rare exprès, environ deux signaux par mois sur les 4 paires.</p></div>`;
}

function manageBox(a, d, live) {
  const data = setupsData();
  const r = a.radar;
  const stopPct = r?.atrD ? data.rules.stopAtr * r.atrD / a.price : null;
  const short = (live?.dir ?? r?.dir) === 'short';
  const days = d ? d.d1.filter(b => b[6] !== 0).slice(-(data.rules.exitDays ?? 7)) : [];
  const exitNow = days.length ? (short ? Math.max(...days.map(b => b[2])) : Math.min(...days.map(b => b[3]))) : null;
  const risk = data.rules.riskPct ?? 1, P = data.rules.partialR ?? 5;
  return `<div class="box"><h2>Gestion du trade</h2><ol class="txt">
    <li><b>Stop</b> : ${stopPct ? `environ ${fmt(stopPct * 100, 1)} % sous le prix d'entrée en ce moment` : 'placé selon l\'agitation habituelle du prix'}. Si le prix y arrive, on coupe : on perd ${fmt(risk, 0)} % du capital, pas plus.</li>
    <li><b>Objectif</b> : quand le gain atteint ${fmt(P, 0)} fois cette distance, on vend la moitié (+${fmt(P * risk / 2, 1).replace(',0', '')} % du capital assuré) et le stop remonte au prix d'entrée.</li>
    <li><b>Le reste</b> : on le garde tant que le marché ${short ? 'baisse' : 'monte'}. On vend quand une journée clôture ${short ? 'au-dessus de son plus haut' : 'sous son plus bas'} des ${data.rules.exitDays ?? 7} derniers jours${exitNow ? ` (${px(exitNow)} en ce moment)` : ''}.</li>
  </ol></div>`;
}

// Trades terminés de la paire sur 12 mois (historique réservé aux membres, comme l'onglet Historique).
const doneTrades = sym => setupsData().history.filter(s => s.symbol === sym && s.outcome !== 'open' && s.at && Date.now() - s.at < 365 * DAY);

function statsBox(a) {
  const list = doneTrades(a.symbol);
  const wins = list.filter(s => s.r > 0).length;
  const total = list.reduce((t, s) => t + s.r, 0);
  const last = lastTradeOf(a.symbol);
  return `<div class="box"><h2>Bilan sur ${esc(a.symbol)} · 12 mois</h2>
    <div class="guest-only"><p class="txt">Le bilan de la paire et ses trades passés sont réservés aux membres. Le compte est gratuit et sans mot de passe.</p>
      <div class="links"><a class="buy" href="#compte/connexion">Se connecter</a></div></div>
    <dl class="members-only">
      ${row('Trades terminés', String(list.length))}
      ${row('Trades gagnants', list.length ? `${fmt(wins / list.length * 100, 0)} %` : '—')}
      ${row('Gain du capital', list.length ? cap(total) : '—', total > 0 ? 'up' : total < 0 ? 'down' : '')}
      ${row('Dernier trade', last ? `${esc(OUTCOME[last.outcome][0])} le ${parisDay(last.at)}` : '—', last ? outcomeCls(last) : '')}
    </dl></div>`;
}

function tradesBox(a) {
  const data = setupsData();
  const list = data.history.filter(s => s.symbol === a.symbol).slice(0, 40);
  const rows = list.map(s => `<tr data-trade="${esc(s.id)}" title="Voir l'explication du trade">
      <td class="l"><a href="#setup/${encodeURIComponent(s.id)}">${parisDay(s.time)}</a></td>
      <td class="l">${esc(data.detectors[s.detector])}</td>
      <td class="l">${dirTag(s.dir)}</td>
      <td class="n">${px(s.entry)}</td>
      <td class="n">${px(s.sl)}</td>
      <td class="l"><span class="tag ${outcomeCls(s)}">${OUTCOME[s.outcome][0]}</span></td>
      <td class="n ${s.r > 0 ? 'up' : s.r < 0 ? 'down' : ''}">${s.outcome === 'open' ? '—' : cap(s.r)}</td>
    </tr>`).join('');
  return `<h2 class="section">Trades passés sur ${esc(a.symbol)} <span class="muted">clique sur un trade pour son explication complète</span></h2>
    <div class="members-only"><div class="wrap"><table class="static">
      <thead><tr><th class="l">Signal</th><th class="l">Détecteur</th><th class="l">Sens</th><th>Entrée</th><th>Stop</th><th class="l">Résultat</th><th>Capital</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7"><div class="empty">Aucun trade sur cette paire pour le moment.</div></td></tr>'}</tbody>
    </table></div></div>
    <div class="box join guest-only"><p class="txt">Connecte-toi (gratuit, sans mot de passe) pour voir les trades passés sur ${esc(a.symbol)}, avec leur résultat.</p>
      <div class="links"><a class="buy" href="#compte/connexion">Se connecter</a></div></div>`;
}

// Graphique : bougies, moyennes 20 et 50 jours, niveaux du plan, trades passés ; MACD 4h sous les bougies 4h.
function chart() {
  const box = $('pa-chart');
  if (!box || !current?.d) return;
  const { a, d } = current;
  const data = setupsData();
  const W = box.clientWidth;
  if (!W) return;
  const [, kind, count] = PERIODS.find(p => p[0] === state.period) || PERIODS[0];
  const h4 = kind === 'h4';
  const base = h4 ? d.h4 : d.d1;
  const from = Math.max(0, base.length - count);
  const bars = base.slice(from);
  const unit = h4 ? 4 * 3600_000 : DAY;

  // Moyennes journalières ; en 4h, chaque bougie prend la moyenne de la dernière journée fermée.
  const days = d.d1.filter(b => b[6] !== 0);
  const closes = days.map(b => b[4]);
  const avg = { 20: ema(closes, 20), 50: ema(closes, 50) };
  const dayIdx = t => { let k = -1; for (let j = 0; j < days.length && days[j][0] + DAY <= t + (h4 ? 0 : DAY); j++) k = j; return k; };
  const idx = bars.map(b => dayIdx(b[0]));
  const overlays = [[20, 'Moy. 20 j', 'l-ma20'], [50, 'Moy. 50 j', 'l-ma50']].map(([n, label, cls]) => ({ key: `e${n}`, label, cls, vals: idx.map(k => (k >= n - 1 ? avg[n][k] : null)) }));

  const live = liveOf(a.symbol);
  const r = a.radar;
  const levels = [];
  if (live) {
    levels.push({ v: live.entry, label: 'Entrée', cls: 'fg' }, { v: live.stop ?? live.sl, label: 'Stop', cls: 'down' });
    if (!live.tpHit) levels.push({ v: live.tp[0], label: 'Moitié', cls: 'up' });
    if (live.exitAt) levels.push({ v: live.exitAt, label: 'Sortie', cls: 'mute' });
  } else if (r?.levels && r.trend !== 'neutre') {
    const s = r.dir === 'long' ? 1 : -1;
    // Les deux cassures au même prix (même plus haut sur 10 et 20 jours) : une seule ligne.
    const ahead = r.levels.filter(l => (l.price - a.price) * s > 0);
    if (ahead.length === 2 && ahead[0].price === ahead[1].price) levels.push({ v: ahead[0].price, label: 'Cassure 20 et 10 jours', cls: 'acc' });
    else for (const l of ahead) levels.push({ v: l.price, label: data.detectors[l.key], cls: 'acc' });
    if (r.trigger) levels.push({ v: r.trigger.stop, label: 'Stop prévu', cls: 'down' });
  }
  // Trades passés : flèche sur la bougie du signal (en journalier, la journée qui le contient).
  const at = t => { const k = bars.findIndex(b => b[0] <= t && t < b[0] + unit); return k; };
  const marks = data.history.filter(s => s.symbol === a.symbol).map(s => ({ i: at(s.time), dir: s.dir, cls: s.outcome === 'open' ? 'acc' : s.r > 0 ? 'up' : s.r < 0 ? 'down' : 'mute' })).filter(m => m.i >= 0);

  const panes = [];
  if (h4) {
    const mc = macdOf(base.map(b => b[4]));
    panes.push({ title: 'MACD 4h · 12 / 26 / 9', h: 90, fmt: v => Number(v.toPrecision(3)).toLocaleString('fr-FR'), kind: 'macd',
      series: [{ key: 'hist', label: 'Histo.', cls: 'l-ind', vals: mc.hist.slice(from) }, { key: 'macd', label: 'MACD', cls: 'l-macd', vals: mc.line.slice(from) }, { key: 'signal', label: 'Signal', cls: 'l-signal', vals: mc.signal.slice(from) }] });
  }
  const label = i => new Date(bars[i][0]).toLocaleString('fr-FR', h4
    ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }
    : { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
  drawCandles(box, {
    bars, label, ticks: timeTicks(bars, h4, W - 82),
    price: { title: `${a.symbol} en dollars · bougies ${h4 ? '4 h' : 'journalières'}`, h: W < 600 ? 260 : 340, fmt: px, overlays, levels, marks },
    panes,
  });
}

// Graduations : un jour sur n en 4h, le début de chaque mois en journalier.
function timeTicks(bars, h4, width) {
  const key = t => (h4 ? Math.floor(t / DAY) : new Date(t).toISOString().slice(0, 7));
  const out = [];
  bars.forEach((b, i) => { if (i && key(b[0]) !== key(bars[i - 1][0])) out.push(i); });
  const every = Math.ceil(out.length / Math.max(2, Math.floor(width / 64)));
  return out.filter((_, j) => j % every === 0).map(i => [i, new Date(bars[i][0]).toLocaleDateString('fr-FR', h4 ? { day: 'numeric', month: 'short', timeZone: 'UTC' } : { month: 'short', timeZone: 'UTC' })]);
}

document.addEventListener('click', e => {
  const b = e.target.closest('#page-paire .chip[data-pap]');
  if (!b) return;
  state.period = b.dataset.pap;
  save();
  document.querySelectorAll('#pa-periods .chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.pap === state.period)));
  chart();
});
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if ($('page-paire')?.classList.contains('on')) chart(); }, 150); });
