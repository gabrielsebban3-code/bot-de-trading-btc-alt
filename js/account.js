// Onglet Mon compte : watchlist, connexion sans mot de passe (Google, ou code / lien reçu par e-mail, via Supabase),
// watchlist synchronisée entre appareils, liste des inscrits pour l'admin.
import { esc, pct, price } from './format.js';
import { SUPABASE } from './config.js';
import { clean, MAX, merge, normalize, star, valid, watchlist } from './watchlist.js';

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
const setPending = email => local.set(PENDING, email ? JSON.stringify({ email, at: Date.now() }) : null);
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
  watchlist.subscribe((list, source) => {
    renderWatchlist();
    if (source === 'user') queueSave();
  });
  renderAccount();
  renderWatchlist();
  if (accountsOn) connect();
}

// Données chargées ou prix du ticker mis à jour : symboles proposés à l'ajout et lignes de la watchlist.
export function refreshAccount(symbols) {
  if (symbols) $('wl-symbols').innerHTML = symbols.map(s => `<option value="${esc(s)}">`).join('');
  renderWatchlist();
}

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
  renderAccount();
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
      <p class="txt">Connecte-toi pour retrouver ta watchlist sur tous tes appareils. Pas de mot de passe.</p>
      ${SUPABASE.google ? '<div class="links"><button type="button" class="btn primary" data-act="google">Continuer avec Google</button></div>' : ''}
      <form class="login" id="login-email"><label for="login-mail">${SUPABASE.google ? 'Ou reçois' : 'Reçois'} ${SUPABASE.code ? 'un code' : 'un lien'} de connexion par e-mail</label>
        <span class="field"><input id="login-mail" name="email" type="email" required autocomplete="email" placeholder="ton@email.com"><button class="btn primary">${SUPABASE.code ? 'Recevoir un code' : 'Envoyer le lien'}</button></span></form>
      ${note}`;
  }
  $('admin').hidden = !admin;
  if (admin) renderAdmin();
  renderMe();
}

// Bouton en haut à droite : « Connexion » tant qu'on n'est pas connecté, sinon l'initiale et « Mon compte ».
function renderMe() {
  const el = $('me');
  el.classList.toggle('in', Boolean(user));
  el.href = user ? '#compte' : '#compte/connexion';
  el.title = user ? `Connecté : ${user.email}` : 'Se connecter';
  el.innerHTML = user ? `<span class="av" aria-hidden="true">${esc((user.email || '?')[0])}</span>Mon compte` : 'Connexion';
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
