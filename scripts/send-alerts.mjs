#!/usr/bin/env node
// Envoie sur Discord les nouveaux setups confirmés et les nouvelles news critiques, chaque matin un résumé et le dimanche soir un bilan de la semaine.
// Usage : DISCORD_WEBHOOK_URL=… node scripts/send-alerts.mjs --data _site/data --previous previous [--site https://…/] [--dry-run]
// Lancé par GitHub Actions après chaque mise à jour des données, seulement sur la branche publiée.
// Au premier passage avec le lien, un message de bienvenue montre que le branchement marche ; alerts.json retient qu'il est parti.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pickAlerts, toDiscord, welcome } from './lib/alerts.mjs';
import { buildDigest, digestDue } from './lib/digest.mjs';
import { buildWeekly, logWeek, weeklyDue } from './lib/weekly.mjs';
import { agendaAlert, agendaEvents, dueAgenda, markSent, todayAgenda } from './lib/agenda.mjs';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true]] : [])));
const hook = process.env.DISCORD_WEBHOOK_URL;
const dry = Boolean(args['dry-run']);
const data = args.data || 'data';
const previous = args.previous || 'previous';
const read = path => readFile(path, 'utf8').then(JSON.parse).catch(() => null);
const now = Number(args.now) || Date.now(); // --now : heure imposée, pour les tests
const wait = ms => new Promise(r => setTimeout(r, ms));

// L'état est republié à chaque passage, même sans lien : la bienvenue ne part qu'une fois.
const state = (await read(join(previous, 'alerts.json'))) || {};
async function save() {
  if (!state.connected) return;
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'alerts.json'), JSON.stringify(state));
}
await save();

if (!hook && !dry) {
  console.log('Pas de DISCORD_WEBHOOK_URL : aucune alerte envoyée.');
  process.exit(0);
}

// Un message Discord (un ou plusieurs blocs) ; vrai s'il est arrivé.
async function post(embed) {
  const embeds = Array.isArray(embed) ? embed : [embed];
  if (dry) { console.log(JSON.stringify(embeds)); return false; }
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await wait(2000); // trop de messages d'un coup : Discord demande d'attendre
    res = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Dinexo', embeds }) }).catch(() => null);
    if (res?.status !== 429) break;
  }
  await wait(600); // Discord limite à environ 5 messages toutes les 2 secondes
  if (res?.ok) return true;
  const why = res ? `${res.status} ${(await res.json().catch(() => ({}))).message || ''}`.trim() : 'pas de réponse';
  console.log(`::warning::Discord a refusé un message (${why}).`);
  return false;
}

if (!state.connected) {
  if (await post(welcome(args.site || ''))) {
    state.connected = new Date().toISOString();
    await save();
    console.log('Message de bienvenue envoyé : le lien Discord marche.');
  } else if (!dry) console.log('::warning::Bienvenue non envoyée, nouvel essai au prochain passage. Si ça dure, vérifie le secret DISCORD_WEBHOOK_URL.');
}

const [setups, news, prevSetups, prevNews, marche] = await Promise.all([
  read(join(data, 'setups.json')),
  read(join(data, 'news.json')),
  read(join(previous, 'setups.json')),
  read(join(previous, 'news.json')),
  read(join(data, 'marche.json')),
]);
// Agenda économique de l'onglet Marché (absent tant que l'onglet ne le publie pas).
const events = agendaEvents(marche);
const alerts = pickAlerts({ setups, news, prevSetups, prevNews, now });
console.log(`${alerts.length} alerte(s) à envoyer.`);
for (const alert of alerts) await post(toDiscord(alert, args.site || ''));

// Annonce économique dans moins de 30 min : une alerte, une seule fois.
if (state.connected || dry) {
  const due = dueAgenda(events, state.agendaSent, now);
  const sent = [];
  for (const e of due) if (await post(agendaAlert(e, now))) sent.push(e);
  if (sent.length) {
    state.agendaSent = markSent(state.agendaSent, sent);
    await save();
    console.log(`${sent.length} alerte(s) agenda envoyée(s).`);
  }
}

// Résumé du matin : une fois par jour, au premier passage après 7 h (heure de Paris), si le lien marche.
if ((state.connected || dry) && (digestDue(state, now) || args['digest-now'])) {
  const digest = buildDigest({ setups, news, agenda: marche?.agenda ? todayAgenda(events, now) : null, siteUrl: args.site || '', now });
  if (await post(digest.embeds)) {
    state.digest = digest.day;
    await save();
    console.log(`Résumé du ${digest.day} envoyé.`);
  } else if (!dry) console.log('::warning::Résumé non envoyé, nouvel essai au prochain passage.');
}

// Bilan du dimanche : le journal des news de la semaine est tenu à chaque passage, le bilan part une fois après 19 h.
state.week = logWeek(state.week, news, now);
await save();
if ((state.connected || dry) && (weeklyDue(state, now) || args['weekly-now'])) {
  const weekly = buildWeekly({ setups, log: state.week, agenda: events, siteUrl: args.site || '', now });
  if (await post(weekly.embeds)) {
    state.weekly = weekly.day;
    await save();
    console.log(`Bilan de la semaine du ${weekly.day} envoyé.`);
  } else if (!dry) console.log('::warning::Bilan de la semaine non envoyé, nouvel essai au prochain passage.');
}
