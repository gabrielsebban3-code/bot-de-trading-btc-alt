// Référencement : pages fixes par crypto, sitemap.xml, robots.txt, llms.txt (agents IA), et adresse du site dans index.html.
// Usage : node scripts/build-seo.mjs --dir _site --site https://…  (lit _site/data/marche.json et _site/data/crypto/)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { siteUrl, coinPage, listPage, sitemap, robots, homePage, llms } from './lib/seo.mjs';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const dir = arg('dir') ?? '_site';
const site = siteUrl(arg('site'));
if (!/^https:\/\//.test(site)) throw new Error(`Adresse du site manquante ou invalide : « ${site} »`);

const json = async f => { try { return JSON.parse(await readFile(join(dir, f), 'utf8')); } catch { return null; } };
const marche = await json('data/marche.json');
const coins = (marche?.top ?? []).filter(c => c?.id && /^[a-z0-9-]+$/.test(c.id) && c.name && c.symbol);
const trends = new Map(((await json('data/crypto/index.json'))?.coins ?? []).map(c => [c.id, c.trend]));
const generatedAt = marche?.generatedAt ?? new Date().toISOString();

for (const coin of coins) {
  const fiche = await json(`data/crypto/${coin.id}.json`);
  await mkdir(join(dir, 'crypto', coin.id), { recursive: true });
  await writeFile(join(dir, 'crypto', coin.id, 'index.html'),
    coinPage({ site, coin, trend: trends.get(coin.id), about: fiche?.about, coins, generatedAt }));
}
if (coins.length) await writeFile(join(dir, 'crypto', 'index.html'), listPage({ site, coins, generatedAt }));
await writeFile(join(dir, 'sitemap.xml'), sitemap({ site, coins: coins.length ? coins : [], generatedAt }));
await writeFile(join(dir, 'robots.txt'), robots(site));
await writeFile(join(dir, 'llms.txt'), llms({ site, coins }));
const home = join(dir, 'index.html');
await writeFile(home, homePage(await readFile(home, 'utf8'), { site, coins }));
console.log(`Référencement : ${coins.length} fiche(s) crypto, sitemap.xml, robots.txt et llms.txt pour ${site}.`);
