// Onglet Mon compte : watchlist, connexion sans mot de passe (Google, ou code / lien reçu par e-mail, via Supabase),
// watchlist synchronisée entre appareils, liste des inscrits pour l'admin.
// Réservé aux membres : Historique, lien du Discord (alertes), « Quoi de neuf pour toi » et alertes de prix.
import { ago, esc, pct, price } from './format.js';
import { SUPABASE } from './config.js';
import { clean, MAX, merge, normalize, star, valid, watchlist } from './watchlist.js';
import { since, whatsNew } from './whatsnew.js';
import { MAX_ALERTS, checkAlerts, guessDir, normalizeAlerts, parsePrice } from './pricealerts.js';

const $ = id => document.getElementById(id);
export const accountsOn = Boolean(SUPABASE.url && SUPABASE.key);
// Compte dont la watchlist a déjà été reprise sur cet appareil : à la première connexion on fusionne les deux listes,
// ensuite c'est la liste du compte qui fait foi (elle a pu changer sur un autre appareil).
const SYNCED = 'dinexo-watchlist-account';
// Adresse à qui un code vient d'être envoyé : gardée une heure, pour que la saisie du code reste affichée
// si le navigateur recharge la page pendant qu'on va lire l'e-mail (fréquent sur iPhone).
const PENDING = 'dinexo-login-pending';
const PENDING_MS = 3_600_000;

let sb = null; // client Supabase, chargé seulement quand les comptes sont branchés
let user = null;
let admin = false;
let notice = '';
let info = () => ({}); // nom, prix et lien d'un actif : fourni par js/app.js
let saveTimer = null;
let discord = null; // lien d'invitation, lu dans Supabase : seuls les membres connectés peuvent le lire
let from = null; // début de « Quoi de neuf » : la visite précédente du membre
let feed = null; // setups, actu et projets chargés par js/app.js
let badgeSeen = false; // le membre a ouvert Résumé ou Mon compte : plus de pastille
let alerts = null; // alertes de prix du compte ; null tant qu'elles ne sont pas lues (ou colonne absente dans Supabase)
let alertsUnseen = 0; // alertes déclenchées depuis le dernier passage sur Mon compte

const local = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
};
function pending() {
  if (!SUPABASE.code) return null;
  try {
    const p = JSON.parse(local.get(PENDING));
    return p && typeof p.email === 'string' && Date.now() - p.at < PENDING_MS ? p.email : null;
  } catch { return null; }
}
// Lien d'invitation Discord accepté : discord.gg/… ou discord.com/invite/…
const discordUrl = u => (/^https:\/\/(discord\.gg|(www\.)?discord\.com\/invite)\/[\w-]+\/?$/.test(u || '') ? u : null);
const setPending = email => local.set(PENDING, email ? JSON.stringify({ email, at: Date.now() }) : null);
const PERKS = `<ul class="perks">
  <li><b>Quoi de neuf pour toi</b> : ce qui a bougé sur tes actifs depuis ta dernière visite</li>
  <li><b>Historique</b> complet des setups, avec leur bilan</li>
  <li><b>Discord</b> : les nouveaux setups et les news critiques en notification</li>
  <li><b>Alertes de prix</b> sur n'importe quel actif</li>
  <li>Ta <b>watchlist</b> sur tous tes appareils</li></ul>`;
const row = (k, v) => `<dt>${k}</dt><dd class="txt">${v}</dd>`;
const day = iso => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Paris' });

export function initAccount(assetInfo) {
  info = assetInfo;
  $('wl-add').addEventListener('submit', e => {
    e.preventDefault();
    const s = clean($('wl-input').value);
    const msg = !valid(s) ? 'Symbole invalide : des lettres et des chiffres, comme BTC ou CL.'
      : watchlist.has(s) ? `${s} est déjà dans ta watchlist.`
        : watchlist.get().length >= MAX ? `${MAX} actifs au maximum.` : '';
    $('wl-msg').textContent = msg;
    if (msg) return;
    watchlist.set([...watchlist.get(), s]);
    $('wl-input').value = '';
  });
  $('account').addEventListener('submit', e => {
    if (e.target.id === 'login-email') sendLink(e);
    else if (e.target.id === 'login-code') verifyCode(e);
  });
  $('account').addEventListener('click', onAction);
  $('alerts').addEventListener('submit', addAlert);
  $('alerts').addEventListener('input', e => { if (e.target.name === 'target' || e.target.name === 'symbol') suggestDir(); });
  $('alerts').addEventListener('click', onAlertAction);
  $('toast').addEventListener('click', e => { if (e.target.closest('button')) $('toast').hidden = true; });
  watchlist.subscribe((list, source) => {
    renderWatchlist();
    if (source === 'user') queueSave();
  });
  renderAccount();
  renderWatchlist();
  window.addEventListener('hashchange', seenBadge);
  seenBadge();
  if (accountsOn) connect();
}

// Données du site chargées : de quoi calculer « Quoi de neuf ».
export function setFeed(setups, news, projects) {
  const bySlug = new Map((projects?.projects || []).map(p => [p.id, p]));
  feed = { setups, news, projectSymbol: id => bySlug.get(id)?.symbol?.toUpperCase() ?? null };
  renderNew();
  renderMe();
}

function seenBadge() {
  const page = location.hash.slice(1).split('/')[0] || 'resume';
  if (user && ['resume', 'compte'].includes(page)) badgeSeen = true;
  if (page === 'compte') alertsUnseen = 0;
  renderMe();
}

// Données chargées ou prix du ticker mis à jour : symboles proposés à l'ajout et lignes de la watchlist.
export function refreshAccount(symbols) {
  if (symbols) $('wl-symbols').innerHTML = symbols.map(s => `<option value="${esc(s)}">`).join('');
  renderWatchlist();
  checkHits();
}

// Actifs des alertes actives : le ticker demande aussi leur prix à OKX.
export const alertSymbols = () => (alerts || []).filter(a => !a.hit).map(a => a.symbol);

async function connect() {
  try {
    // Version fixée : une nouvelle version de la librairie ne peut pas casser la connexion sans qu'on l'ait testée.
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm');
    sb = createClient(SUPABASE.url, SUPABASE.key, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } });
  } catch {
    notice = 'La connexion est indisponible pour le moment. Ta watchlist reste gardée sur cet appareil.';
    renderAccount();
    return;
  }
  // Pas d'appel à Supabase directement dans ce rappel (blocage connu de la librairie) : on passe au tour suivant.
  sb.auth.onAuthStateChange((event, session) => setTimeout(() => onSession(session), 0));
  // Retour d'un lien de connexion ou de Google : ?code=… dans l'adresse. getSession attend que la librairie
  // l'ait échangé contre une session, puis on nettoie l'adresse et on ouvre Mon compte.
  // Le code ne s'échange que dans le navigateur qui a demandé le lien : ouvert sur un autre appareil, il ne donne rien.
  const params = new URLSearchParams(location.search);
  const { data } = await sb.auth.getSession();
  if (params.has('code') || params.has('error')) {
    if (params.get('error_code') === 'otp_expired') notice = 'Ce lien a expiré ou a déjà servi : demandes-en un nouveau.';
    else if (!data?.session) notice = 'La connexion n\'a pas abouti. Ouvre le lien sur l\'appareil et dans le navigateur où tu l\'as demandé, ou demandes-en un nouveau.';
    history.replaceState(null, '', `${location.pathname}#compte`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
  renderAccount();
}

async function onSession(session) {
  const next = session?.user ?? null;
  if ((next?.id ?? null) === (user?.id ?? null)) return; // jeton rafraîchi, onglet revenu au premier plan…
  user = next;
  admin = false;
  discord = null;
  from = null;
  alerts = null;
  alertsUnseen = 0;
  badgeSeen = false;
  if (user) setPending(null);
  if (!user) {
    local.set(SYNCED, null);
    renderAccount();
    return;
  }
  renderAccount();
  try {
    // Première connexion : la ligne du compte est créée (adresse et watchlist vide).
    await sb.from('profiles').upsert({ id: user.id, email: user.email }, { onConflict: 'id', ignoreDuplicates: true });
    const { data, error } = await sb.from('profiles').select('watchlist').eq('id', user.id).single();
    if (error) throw error;
    const saved = normalize(data.watchlist);
    const first = local.get(SYNCED) !== user.id;
    const list = first ? merge(saved, watchlist.get()) : saved;
    watchlist.set(list, 'account');
    local.set(SYNCED, user.id);
    if (list.join() !== saved.join()) await save();
    admin = Boolean((await sb.rpc('is_admin')).data);
  } catch {
    notice = 'Ta watchlist n\'a pas pu être lue dans ton compte. Celle de cet appareil reste affichée.';
  }
  await memberData();
  seenBadge();
  renderAccount();
}

// Visite précédente (dans le compte, sinon sur cet appareil), puis on enregistre celle-ci. Lien du Discord.
// Chaque lecture est indépendante : si une colonne ou une table manque dans Supabase, le reste marche.
async function memberData() {
  const key = `dinexo-seen-${user.id}`;
  const now = new Date().toISOString();
  let prev = local.get(key);
  const { data: seen, error } = await sb.from('profiles').select('last_seen').eq('id', user.id).single();
  if (!error && seen?.last_seen) prev = seen.last_seen;
  from = since(prev);
  local.set(key, now);
  if (!error) await sb.from('profiles').update({ last_seen: now }).eq('id', user.id);
  const { data: al, error: alErr } = await sb.from('profiles').select('alerts').eq('id', user.id).single();
  alerts = alErr ? null : normalizeAlerts(al?.alerts);
  const { data: links } = await sb.from('member_links').select('name, url');
  discord = discordUrl(links?.find(l => l.name === 'discord')?.url);
}

function queueSave() {
  if (!user || !sb) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
}

async function save() {
  const { error } = await sb.from('profiles').update({ watchlist: watchlist.get(), updated_at: new Date().toISOString() }).eq('id', user.id);
  if (!error) return;
  notice = 'Ta watchlist n\'a pas pu être enregistrée dans ton compte. Elle reste gardée sur cet appareil.';
  renderAccount();
}

const redirect = () => `${location.origin}${location.pathname}`;

// L'e-mail contient un code à taper ici (il marche sur n'importe quel appareil) et un lien (seulement dans ce navigateur).
async function sendLink(e) {
  e.preventDefault();
  if (!sb) return;
  const email = (e.target.email?.value ?? pending() ?? '').trim();
  const button = e.target.querySelector('button');
  button.disabled = true;
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect() } });
  button.disabled = false;
  if (!error && SUPABASE.code) setPending(email);
  notice = !error ? (SUPABASE.code ? '' : `Lien envoyé à ${email}. Ouvre-le sur cet appareil, dans ce navigateur, pour te connecter.`)
    : error.status === 429 ? 'Trop de demandes. Attends un peu avant de redemander un code.'
    : 'L\'e-mail n\'a pas pu être envoyé. Vérifie l\'adresse, ou réessaie plus tard.';
  renderAccount();
  if (!error) $('login-token')?.focus();
}

async function verifyCode(e) {
  e.preventDefault();
  const email = pending();
  const token = e.target.token.value.replace(/\D/g, '');
  if (!sb || !email) return;
  if (token.length < 6) { notice = 'Le code fait 6 chiffres.'; renderAccount(); return; }
  const button = e.target.querySelector('button');
  button.disabled = true;
  const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
  button.disabled = false;
  // Réussi : onAuthStateChange ouvre la session et affiche le compte.
  if (!error) { notice = ''; return; }
  notice = error.status === 429 ? 'Trop d\'essais. Attends un peu, puis réessaie.'
    : 'Ce code est faux ou a expiré. Vérifie le dernier e-mail reçu, ou demande un nouveau code.';
  renderAccount();
}

async function onAction(e) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !sb) return;
  if (act === 'google') {
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirect() } });
    if (error) { notice = 'La connexion avec Google est indisponible pour le moment.'; renderAccount(); }
  } else if (act === 'change') {
    setPending(null);
    notice = '';
    renderAccount();
  } else if (act === 'logout') {
    notice = '';
    await sb.auth.signOut();
  } else if (act === 'delete') {
    if (!confirm('Supprimer ton compte ? Ta watchlist restera sur cet appareil, mais ne sera plus synchronisée.')) return;
    const { error } = await sb.rpc('delete_my_account');
    if (error) { notice = 'La suppression n\'a pas marché. Réessaie plus tard.'; renderAccount(); return; }
    notice = 'Ton compte est supprimé.';
    await sb.auth.signOut({ scope: 'local' });
  }
}

function renderAccount() {
  const el = $('account');
  const note = notice ? `<p class="txt note">${esc(notice)}</p>` : '';
  if (!accountsOn) {
    el.innerHTML = '<h2>Connexion</h2><p class="txt">La connexion arrive bientôt. En attendant, ta watchlist est gardée sur cet appareil.</p>';
  } else if (!sb) {
    el.innerHTML = `<h2>Connexion</h2>${note || '<p class="txt muted">Chargement…</p>'}`;
  } else if (user) {
    el.innerHTML = `<h2>Connecté</h2><dl>${row('Adresse', esc(user.email))}${row('Watchlist', 'la même sur tous tes appareils')}</dl>${note}
      <div class="links"><button type="button" class="btn" data-act="logout">Se déconnecter</button><button type="button" class="btn danger" data-act="delete">Supprimer mon compte</button></div>`;
  } else if (pending()) {
    el.innerHTML = `<h2>Connexion</h2>
      <p class="txt">Un e-mail est parti à <b>${esc(pending())}</b>. Tape le code à 6 chiffres qu'il contient.</p>
      <form class="login" id="login-code"><label for="login-token">Code reçu par e-mail</label>
        <span class="field"><input id="login-token" name="token" class="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="12" required placeholder="123456"><button class="btn primary">Se connecter</button></span></form>
      ${note}
      <p class="txt muted">Rien reçu ? Regarde dans les indésirables. Tu peux aussi ouvrir le lien de l'e-mail, mais seulement dans ce navigateur.</p>
      <form class="links" id="login-email"><button class="btn">Renvoyer un code</button><button type="button" class="btn" data-act="change">Changer d'adresse</button></form>`;
  } else {
    el.innerHTML = `<h2>Connexion</h2>
      <p class="txt">Crée ton compte gratuit, sans mot de passe :</p>
      ${PERKS}
      ${SUPABASE.google ? '<div class="links"><button type="button" class="btn primary" data-act="google">Continuer avec Google</button></div>' : ''}
      <form class="login" id="login-email"><label for="login-mail">${SUPABASE.google ? 'Ou reçois' : 'Reçois'} ${SUPABASE.code ? 'un code' : 'un lien'} de connexion par e-mail</label>
        <span class="field"><input id="login-mail" name="email" type="email" required autocomplete="email" placeholder="ton@email.com"><button class="btn primary">${SUPABASE.code ? 'Recevoir un code' : 'Envoyer le lien'}</button></span></form>
      ${note}`;
  }
  $('admin').hidden = !admin;
  if (admin) renderAdmin();
  // Sans comptes branchés, rien n'est réservé.
  document.body.classList.toggle('member', Boolean(user) || !accountsOn);
  renderDiscord();
  renderNew();
  renderAlerts();
  renderMe();
}

// Alertes de prix --------------------------------------------------------------------------------------------

async function saveAlerts() {
  const { error } = await sb.from('profiles').update({ alerts }).eq('id', user.id);
  if (error) { notice = 'Tes alertes n\'ont pas pu être enregistrées. Réessaie plus tard.'; renderAccount(); }
}

function suggestDir() {
  const f = $('alert-form');
  const target = parsePrice(f.target.value);
  const last = info(clean(f.symbol.value)).last;
  if (target && last != null) f.dir.value = guessDir(target, last);
}

function addAlert(e) {
  e.preventDefault();
  const f = e.target;
  const symbol = clean(f.symbol.value);
  const target = parsePrice(f.target.value);
  const msg = !valid(symbol) ? 'Symbole invalide : des lettres et des chiffres, comme BTC.'
    : !target ? 'Prix invalide : par exemple 90 000 ou 0,45.'
      : alerts.filter(a => !a.hit).length >= MAX_ALERTS ? `${MAX_ALERTS} alertes actives au maximum.` : '';
  $('alert-msg').textContent = msg;
  if (msg) return;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  alerts = [{ id, symbol, dir: f.dir.value, price: target, created: Date.now(), hit: null }, ...alerts].slice(0, MAX_ALERTS);
  f.target.value = '';
  saveAlerts();
  renderAlerts();
  window.dispatchEvent(new Event('dinexo-alerts')); // le ticker va chercher le prix de ce nouvel actif
}

function onAlertAction(e) {
  const b = e.target.closest('[data-alert]');
  if (b?.dataset.act === 'notify') { Notification.requestPermission().then(renderAlerts); return; }
  if (!b) return;
  const id = b.dataset.alert;
  alerts = b.dataset.act === 'again' ? alerts.map(a => (a.id === id ? { ...a, hit: null, created: Date.now() } : a)) : alerts.filter(a => a.id !== id);
  saveAlerts();
  renderAlerts();
}

const phrase = a => `${a.symbol} ${a.dir === 'above' ? 'au-dessus de' : 'sous'} ${price(a.price)}`;

// Appelé à chaque mise à jour des prix du ticker.
function checkHits() {
  if (!user || !alerts?.length) return;
  const { alerts: next, hits } = checkAlerts(alerts, s => info(s).last);
  if (!hits.length) return;
  alerts = next;
  saveAlerts();
  if (!location.hash.startsWith('#compte')) alertsUnseen += hits.length;
  const text = hits.map(h => `${phrase(h)} : ${price(h.at)}`).join(' · ');
  $('toast').innerHTML = `<span>🔔 ${esc(text)}</span><a href="#compte">Mes alertes</a><button type="button" aria-label="Fermer">×</button>`;
  $('toast').hidden = false;
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('Dinexo : alerte de prix', { body: text }); } catch { /* notifications indisponibles (iPhone hors écran d'accueil) */ }
  }
  renderAlerts();
  renderMe();
}

function renderAlerts() {
  const el = $('alerts');
  el.hidden = !user || alerts === null;
  if (el.hidden) return;
  const notify = 'Notification' in window && Notification.permission === 'default'
    ? '<div class="links"><button type="button" class="btn" data-alert="" data-act="notify">Recevoir aussi une notification du navigateur</button></div>' : '';
  const line = a => {
    const last = info(a.symbol).last;
    const gap = last != null && !a.hit ? ` <span class="muted">· à ${fmtGap(a.price / last - 1)}</span>` : '';
    return `<div class="row al${a.hit ? ' hit' : ''}"><span class="d"><span class="wn mono">${esc(phrase(a))}</span>
      <span class="muted">${a.hit ? `Déclenchée ${ago(new Date(a.hit).toISOString())}` : `Active${last != null ? ` · prix actuel ${price(last)}` : ''}`}${gap}</span></span>
      ${a.hit ? `<button type="button" class="btn" data-alert="${a.id}" data-act="again">Réactiver</button>` : ''}
      <button type="button" class="btn" data-alert="${a.id}" data-act="delete" aria-label="Supprimer l'alerte ${esc(phrase(a))}">×</button></div>`;
  };
  const keep = id => $(id)?.value ?? '';
  const [sym, target, dir] = [keep('alert-symbol'), keep('alert-target'), $('alert-form')?.dir.value || 'above'];
  el.innerHTML = `<h2>Alertes de prix <span class="muted">${alerts.filter(a => !a.hit).length} / ${MAX_ALERTS}</span></h2>
    <form class="login" id="alert-form"><label for="alert-symbol">Préviens-moi quand</label>
      <span class="field"><input id="alert-symbol" name="symbol" list="wl-symbols" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16" placeholder="BTC" class="sym">
        <select name="dir" aria-label="Sens"><option value="above">passe au-dessus de</option><option value="below">passe sous</option></select></span>
      <span class="field"><input id="alert-target" name="target" inputmode="decimal" autocomplete="off" placeholder="Prix, ex. 90 000"><button class="btn primary">Créer l'alerte</button></span>
      <span class="msg" id="alert-msg" role="status"></span></form>
    ${alerts.map(line).join('') || '<div class="soon">Aucune alerte. Elles sont vérifiées toutes les minutes tant que Dinexo est ouvert.</div>'}
    ${notify}`;
  $('alert-symbol').value = sym;
  $('alert-target').value = target;
  $('alert-form').dir.value = dir;
}

const fmtGap = r => `${r >= 0 ? '+' : ''}${(r * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;

function renderDiscord() {
  const el = $('discord');
  el.hidden = !user || (!discord && !admin);
  if (el.hidden) return;
  el.innerHTML = discord ? `<h2>Discord Dinexo</h2>
      <p class="txt">Les nouveaux setups confirmés et les news critiques y arrivent en direct, avec une notification sur ton téléphone.</p>
      <div class="links"><a class="buy" href="${esc(discord)}" target="_blank" rel="noopener">Rejoindre le Discord</a></div>`
    : `<h2>Discord Dinexo <span class="muted">admin</span></h2>
      <p class="txt">Les membres ne voient pas encore de lien : ajoute le lien d'invitation dans Supabase (table member_links), comme dans le guide.</p>`;
}

function newItems() {
  return user && feed && from ? whatsNew({ ...feed, list: watchlist.get(), from }) : [];
}

function renderNew() {
  const items = newItems();
  const date = from ? new Date(from).toLocaleString('fr-FR', { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '';
  const rows = list => list.map(i => `<a class="row" href="${i.href}"><span class="tag ${i.tone}">${i.kind === 'setup' ? 'Setup' : 'Actu'}</span>
      <span class="d"><span class="wn">${esc(i.title)}</span><span class="muted">${esc(i.detail)}</span></span><span class="r muted">${ago(new Date(i.time).toISOString())}</span></a>`).join('')
    || '<div class="soon">Rien de nouveau sur les actifs de ta watchlist depuis ta dernière visite.</div>';
  // Résumé : les 5 plus récentes, la liste complète est dans Mon compte.
  const head = more => `<h2><span>Quoi de neuf pour toi <span class="muted">depuis ${esc(date)}</span></span>${more ? '<a href="#compte">Tout voir →</a>' : ''}</h2>`;
  for (const id of ['new-resume', 'new-compte']) {
    $(id).hidden = !user || !feed || !from;
    if ($(id).hidden) continue;
    const short = id === 'new-resume' && items.length > 5;
    $(id).innerHTML = head(short) + rows(short ? items.slice(0, 5) : items);
  }
}

// Bouton en haut à droite : « Connexion » tant qu'on n'est pas connecté, sinon l'initiale et « Mon compte ».
function renderMe() {
  const el = $('me');
  el.classList.toggle('in', Boolean(user));
  el.href = user ? '#compte' : '#compte/connexion';
  el.title = user ? `Connecté : ${user.email}` : 'Se connecter';
  const n = (badgeSeen ? 0 : newItems().length) + alertsUnseen;
  el.innerHTML = user ? `<span class="av" aria-hidden="true">${esc((user.email || '?')[0])}</span>Mon compte${n ? `<span class="badge" title="${n} nouveauté${n > 1 ? 's' : ''} sur ta watchlist">${n}</span>` : ''}` : 'Connexion';
}

function renderWatchlist() {
  const list = watchlist.get();
  $('wl-count').textContent = `${list.length} / ${MAX}`;
  $('wl-list').innerHTML = list.map(s => {
    const a = info(s);
    const quote = a.last == null ? '' : `<span class="num">${price(a.last)}</span> ${a.change == null ? '' : pct(a.change)}`;
    return `<div class="row wl">${star(s)}<span class="t mono">${esc(s)}</span><span class="d">${esc(a.name || '')}</span>
      <span class="r">${quote}</span>${a.href ? `<a class="go" href="${a.href}">${a.hrefLabel} →</a>` : ''}</div>`;
  }).join('') || '<div class="soon">Ta watchlist est vide. Ajoute un actif avec l\'étoile, sur un projet ou un setup, ou ci-dessus.</div>';
}

async function renderAdmin() {
  const el = $('admin');
  const { data, error } = await sb.from('profiles').select('email, watchlist, created_at').order('created_at', { ascending: false });
  if (error) { el.innerHTML = '<h2>Admin</h2><p class="txt">La liste des inscrits est indisponible pour le moment.</p>'; return; }
  const counts = new Map();
  for (const p of data) for (const s of p.watchlist) counts.set(s, (counts.get(s) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10);
  el.innerHTML = `<h2>Admin <span class="muted">${data.length} inscrit${data.length > 1 ? 's' : ''}</span></h2>
    ${top.length ? `<p class="txt">Les plus suivis : ${top.map(([s, n]) => `<b class="mono">${esc(s)}</b> ${n}`).join(' · ')}</p>` : ''}
    <div class="wrap flat"><table class="static">
      <thead><tr><th class="l">Adresse</th><th class="l">Inscrit le</th><th>Actifs suivis</th></tr></thead>
      <tbody>${data.map(p => `<tr><td class="l">${esc(p.email || '—')}</td><td class="l muted">${day(p.created_at)}</td><td class="n">${p.watchlist.length}</td></tr>`).join('')}</tbody>
    </table></div>`;
}
