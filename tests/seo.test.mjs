import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteUrl, coinPage, listPage, sitemap, robots, homePage, llms } from '../scripts/lib/seo.mjs';

const site = siteUrl('https://dinexo.fr/');
const coins = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', price: 84000, mcap: 1.7e12, volume: 2e10, change24h: -0.025, change7d: 0.01, change30d: 0.04 },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum <x>', price: 2700, mcap: 8.5e11, volume: 1e10, change24h: 0.02, change7d: 0, change30d: null },
];
const generatedAt = '2026-10-04T20:00:00Z';

test("adresse du site sans / final", () => {
  assert.equal(site, 'https://dinexo.fr');
  assert.equal(siteUrl(' https://a.github.io/repo// '), 'https://a.github.io/repo');
});

test('page crypto : titre, adresse, texte français, lien vers la fiche', () => {
  const html = coinPage({ site, coin: coins[0], trend: { label: 'Plutôt haussier', up: 4, down: 1, total: 8 }, about: { lang: 'fr', text: 'Première crypto.' }, coins, generatedAt });
  assert.match(html, /<title>Bitcoin \(BTC\) : prix, tendance et analyse \| Dinexo<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/dinexo\.fr\/crypto\/bitcoin\/">/);
  assert.match(html, /og:image" content="https:\/\/dinexo\.fr\/og-image\.png"/);
  assert.match(html, /4 signaux haussiers, 1 baissier, sur 8 signaux/);
  assert.match(html, /Première crypto\./);
  assert.match(html, /href="\.\.\/\.\.\/#crypto\/bitcoin"/);
  assert.match(html, /84\s000 \$/);
  assert.match(html, /Ethereum &lt;x&gt;/, 'les noms sont échappés');
  assert.doesNotMatch(html, /href="\.\.\/\.\.\/crypto\/bitcoin\/"/, 'pas de lien vers elle-même');
});

test("page crypto sans tendance ni texte français : pas de bloc vide", () => {
  const html = coinPage({ site, coin: coins[0], trend: null, about: { lang: 'en', text: 'First.' }, coins, generatedAt });
  assert.doesNotMatch(html, /Tendance selon Dinexo/);
  assert.doesNotMatch(html, /First\./);
});

test('page liste et plan du site', () => {
  const list = listPage({ site, coins, generatedAt });
  assert.match(list, /Cours des 2 premières cryptomonnaies/);
  assert.match(list, /href="bitcoin\/"/);
  const map = sitemap({ site, coins, generatedAt });
  assert.equal(map.match(/<loc>/g).length, 4);
  assert.match(map, /<loc>https:\/\/dinexo\.fr\/crypto\/ethereum\/<\/loc><lastmod>2026-10-04<\/lastmod>/);
  assert.equal(sitemap({ site, coins: [], generatedAt }).match(/<loc>/g).length, 1);
  assert.match(robots(site), /Sitemap: https:\/\/dinexo\.fr\/sitemap\.xml/);
});

test("accueil : adresse remplacée et liens vers les fiches", () => {
  const html = homePage('<link href="%SITE%/"><footer><!-- seo:fiches --></footer>', { site, coins });
  assert.match(html, /href="https:\/\/dinexo\.fr\/"/);
  assert.match(html, /<a href="crypto\/bitcoin\/">Bitcoin<\/a>/);
  assert.doesNotMatch(html, /%SITE%|seo:fiches/);
});

test('llms.txt : guide pour les agents IA, avec les fiches, les données et les pages légales', () => {
  const txt = llms({ site, coins });
  assert.match(txt, /^# Dinexo\n\n> /);
  assert.match(txt, /\[Bitcoin \(BTC\)\]\(https:\/\/dinexo\.fr\/crypto\/bitcoin\/\)/);
  assert.match(txt, /https:\/\/dinexo\.fr\/data\/setups\.json/);
  assert.match(txt, /https:\/\/dinexo\.fr\/legal\/cgu\.html/);
});

test('pages fixes : polices du site (pas de Google Fonts) et liens légaux', () => {
  const html = coinPage({ site, coin: coins[0], trend: null, about: null, coins, generatedAt });
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
  assert.match(html, /href="\.\.\/\.\.\/legal\/confidentialite\.html"/);
});
