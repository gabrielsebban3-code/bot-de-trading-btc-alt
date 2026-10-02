#!/usr/bin/env node
// Envoie sur Discord les nouveaux setups confirmés et les nouvelles news critiques.
// Usage : DISCORD_WEBHOOK_URL=… node scripts/send-alerts.mjs --data _site/data --previous previous [--site https://…/] [--dry-run]
// Lancé par GitHub Actions après chaque mise à jour des données, seulement sur la branche publiée.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pickAlerts, toDiscord } from './lib/alerts.mjs';

const argv = process.argv.slice(2);
const args = Object.fromEntries(argv.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true]] : [])));
const hook = process.env.DISCORD_WEBHOOK_URL;
const dry = Boolean(args['dry-run']);
const read = path => readFile(path, 'utf8').then(JSON.parse).catch(() => null);

if (!hook && !dry) {
  console.log('Pas de DISCORD_WEBHOOK_URL : aucune alerte envoyée.');
  process.exit(0);
}

const [setups, news, prevSetups, prevNews] = await Promise.all([
  read(join(args.data || 'data', 'setups.json')),
  read(join(args.data || 'data', 'news.json')),
  read(join(args.previous || 'previous', 'setups.json')),
  read(join(args.previous || 'previous', 'news.json')),
]);
const alerts = pickAlerts({ setups, news, prevSetups, prevNews });
console.log(`${alerts.length} alerte(s) à envoyer.`);

for (const alert of alerts) {
  const embed = toDiscord(alert, args.site || '');
  if (dry) { console.log(JSON.stringify(embed)); continue; }
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Dinexo', embeds: [embed] }) });
    if (res.ok) break;
    if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
    console.log(`::warning::Discord a refusé une alerte (${res.status}).`);
    break;
  }
  await new Promise(r => setTimeout(r, 600)); // Discord limite à environ 5 messages toutes les 2 secondes
}
