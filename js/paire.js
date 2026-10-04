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
const num = n => n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });

async function load(sym) {
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
    const d = await load(sym);
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
  if (live) return 'Pointillés : entrée, stop, objectif de la moitié et niveau de sortie du trade en jeu. Flèches : trades passés (vert = gain, rouge = perte).';
  if (a.radar?.trend === 'neutre' || !a.radar) return 'Courbes : moyennes 20 et 50 jours qui donnent la tendance. Flèches : trades passés (vert = gain, rouge = perte).';
  return 'Pointillés : les prix qui déclencheraient le prochain signal et le stop prévu. Courbes : moyennes 20 et 50 jours qui donnent la tendance. Flèches : trades passés (vert = gain, rouge = perte).';
}

// Les règles du signal, avec les chiffres de la paire en ce moment.
function rulesBox(a, d) {
  const data = setupsData();
  const r = a.radar;
  const days = d ? d.d1.filter(b => b[6] !== 0) : [];
  const closes = days.map(b => b[4]);
  const e20 = ema(closes, 20).at(-1), e50 = ema(closes, 50).at(-1), last = closes.at(-1);
  const ok = v => `<span class="pa-ck ${v ? 'yes' : 'no'}" aria-hidden="true">${v ? '✓' : '✗'}</span>`;
  const trendOn = r && r.trend !== 'neutre';
  const up = r?.dir === 'long';
  const trendLine = `<li>${ok(trendOn)}<div><b>Tendance journalière ${r ? esc(r.trend) : '—'}</b>
    <span>${days.length >= 50 ? `Clôture d'hier ${px(last)}, moyenne 20 jours ${px(e20)}, moyenne 50 jours ${px(e50)}. ` : ''}Haussière quand la clôture et la moyenne 20 jours sont au-dessus de la moyenne 50 jours (baissière : l'inverse).
    ${trendOn ? `On ne cherche donc que des <b>${up ? 'longs' : 'shorts'}</b>.` : 'Sinon, pas de trade.'}</span></div></li>`;
  const word = up ? 'au-dessus du plus haut' : 'sous le plus bas';
  const lv = key => r?.levels?.find(l => l.key === key);
  const levelText = l => {
    if (!l) return '';
    const dist = l.price / a.price - 1;
    const passed = up ? dist <= 0 : dist >= 0;
    return passed ? ` Le prix est déjà ${up ? 'au-dessus' : 'en dessous'} (${px(l.price)}) : il faudra un nouveau ${up ? 'plus haut' : 'plus bas'}.` : ` En ce moment : <b>${px(l.price)}</b> (${plainPct(dist)}).`;
  };
  const triggers = trendOn ? `
      <li><b>${esc(data.detectors.range20)}</b> : une bougie 4h clôture ${word} des 20 derniers jours.${levelText(lv('range20'))}</li>
      <li><b>${esc(data.detectors.range10)}</b> : une bougie 4h clôture ${word} des 60 dernières bougies 4h.${levelText(lv('range10'))}</li>
      <li><b>${esc(data.detectors.macd)}</b> : l'histogramme MACD 4h (12, 26, 9) repasse ${up ? 'au-dessus' : 'en dessous'} de zéro.
        ${r.macdReady ? `En ce moment il est ${up ? 'sous' : 'au-dessus de'} zéro : son retour de l'autre côté donnerait le signal.` : `En ce moment il est déjà ${up ? 'au-dessus' : 'en dessous'} de zéro : il doit d'abord repasser de l'autre côté.`}</li>`
    : `<li>Cassure 20 jours, cassure 10 jours ou MACD 4h, dans le sens de la tendance : rien à surveiller tant qu'elle est neutre.</li>`;
  return `<div class="box"><h2>Comment le signal se déclenche</h2><ol class="pa-rules">
    ${trendLine}
    <li>${ok(trendOn)}<div><b>Un des 3 déclencheurs, sur une bougie 4h fermée</b><ul>${triggers}</ul></div></li>
    <li>${ok(true)}<div><b>De la place devant</b><span>Le signal est ignoré si un niveau important (plus haut ou plus bas récent, chiffre rond, zone de gros volume) est à moins de 2 × ${num(data.rules.roomAtr ?? 1.5)} ATR 4h du prix d'entrée.</span></div></li>
    <li>${ok(!liveOf(a.symbol))}<div><b>Un seul trade à la fois sur ${esc(a.symbol)}</b><span>${liveOf(a.symbol) ? 'Un trade est déjà en jeu : pas de nouveau signal avant sa sortie.' : 'Aucun trade en jeu : la paire est libre.'}</span></div></li>
  </ol><p class="txt muted">Environ deux signaux par mois sur les 4 paires : c'est rare exprès.</p></div>`;
}

function manageBox(a, d, live) {
  const data = setupsData();
  const r = a.radar;
  const stopPct = r?.atrD ? data.rules.stopAtr * r.atrD / a.price : null;
  const short = (live?.dir ?? r?.dir) === 'short';
  const days = d ? d.d1.filter(b => b[6] !== 0).slice(-(data.rules.exitDays ?? 7)) : [];
  const exitNow = days.length ? (short ? Math.max(...days.map(b => b[2])) : Math.min(...days.map(b => b[3]))) : null;
  return `<div class="box"><h2>Gestion du trade</h2><ol class="txt">
    <li>On risque ${fmt(data.rules.riskPct ?? 1, 0)} % du capital : le stop de départ est à ${num(data.rules.stopAtr)} ATR journalier${stopPct ? `, soit environ <b>${fmt(stopPct * 100, 1)} %</b> du prix sur ${esc(a.symbol)} en ce moment` : ''}.</li>
    <li>À ${fmt(data.rules.partialR ?? 5, 0)} fois le risque (+${fmt((data.rules.partialR ?? 5) * (data.rules.riskPct ?? 1), 0)} % du capital), on prend la moitié et on remonte le stop au prix d'entrée.</li>
    <li>Le reste est gardé tant que la tendance tient : sortie quand une journée clôture ${short ? 'au-dessus du plus haut' : 'sous le plus bas'} des ${data.rules.exitDays ?? 7} derniers jours${exitNow ? ` (${px(exitNow)} en ce moment)` : ''}.</li>
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
  const rows = list.map(s => `<tr>
      <td class="l muted">${parisDay(s.time)}</td>
      <td class="l">${esc(data.detectors[s.detector])}</td>
      <td class="l">${dirTag(s.dir)}</td>
      <td class="n">${px(s.entry)}</td>
      <td class="n">${px(s.sl)}</td>
      <td class="l"><span class="tag ${outcomeCls(s)}">${OUTCOME[s.outcome][0]}</span></td>
      <td class="n ${s.r > 0 ? 'up' : s.r < 0 ? 'down' : ''}">${s.outcome === 'open' ? '—' : cap(s.r)}</td>
    </tr>`).join('');
  return `<h2 class="section">Trades passés sur ${esc(a.symbol)}</h2>
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
    for (const l of r.levels) if ((l.price - a.price) * s > 0) levels.push({ v: l.price, label: data.detectors[l.key], cls: 'acc' });
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
