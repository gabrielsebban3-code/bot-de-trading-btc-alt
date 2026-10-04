// Référencement : une vraie page HTML par crypto (/crypto/<id>/), une page liste (/crypto/), le plan du site
// (sitemap.xml) et robots.txt. Le site lui-même est une seule page à onglets (#marche, #crypto/<id>…) :
// Google ignore tout ce qui suit le #, il ne voit donc qu'une adresse. Ces pages fixes lui donnent du texte
// à lire et une adresse par crypto, et renvoient vers la fiche complète du site.
import { esc, money, pct } from '../../js/format.js';
import { priceText } from '../../js/crypto-lib.js';

// Adresse du site sans « / » final : https://gabrielsebban3-code.github.io/bot-de-trading-btc-alt ou https://dinexo.fr
export const siteUrl = s => String(s ?? '').trim().replace(/\/+$/, '');

const when = iso => new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

// Haut et bas communs aux pages fixes. `root` : chemin relatif vers la racine du site (« ../../ » ou « ../ »).
function page({ site, root, title, description, canonical, body }) {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Dinexo">
  <meta property="og:locale" content="fr_FR">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:image" content="${esc(site)}/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#0c0d10">
  <link rel="icon" href="${root}icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="${root}apple-touch-icon.png">
  <link rel="stylesheet" href="${root}css/style.css">
</head>
<body class="seo">
  <a class="skip" href="#contenu">Aller au contenu</a>
  <header><div class="bar"><a class="logo" href="${root}#resume">Dinexo</a><a class="me" href="${root}#marche">Ouvrir le tableau de bord</a></div></header>
  <main id="contenu" tabindex="-1">
${body}
  </main>
  <footer><p><b>Ceci n'est pas un conseil financier.</b> Dinexo est un outil d'information gratuit. Le trading de cryptomonnaies comporte un risque élevé de perte en capital. Données : CoinGecko, OKX, DefiLlama.</p>
    <div class="legal-links" role="navigation" aria-label="Informations légales"><a href="${root}legal/mentions-legales.html">Mentions légales</a> · <a href="${root}legal/confidentialite.html">Confidentialité</a> · <a href="${root}legal/cookies.html">Cookies et stockage</a> · <a href="${root}legal/cgu.html">Conditions d'utilisation</a></div></footer>
</body>
</html>
`;
}

// Lien vers chaque fiche, pour passer d'une crypto à l'autre (et pour que Google les trouve toutes).
const others = (coins, root, skip) => coins.filter(c => c.id !== skip)
  .map(c => `<a href="${root}crypto/${esc(c.id)}/">${esc(c.name)}</a>`).join(' · ');

// « 1 signal haussier », « 4 signaux haussiers ».
const n = (k, one, many) => `${k} ${k > 1 ? many : one}`;
const trendText = t => (t?.label ? `${t.label}${t.total ? ` (${n(t.up, 'signal haussier', 'signaux haussiers')}, ${n(t.down, 'baissier', 'baissiers')}, sur ${n(t.total, 'signal', 'signaux')})` : ''}` : null);

// Page d'une crypto. `coin` : ligne du tableau Marché ; `trend` et `about` : tirés de sa fiche.
export function coinPage({ site, coin, trend, about, coins, generatedAt }) {
  const name = `${coin.name} (${coin.symbol})`;
  const canonical = `${site}/crypto/${coin.id}/`;
  const tr = trendText(trend);
  const description = `${name} : prix du jour, tendance${trend?.label ? ` (${trend.label.toLowerCase()})` : ''}, variation sur 24 h, 7 et 30 jours et présentation simple en français. Gratuit, mis à jour toutes les heures.`;
  const text = about?.lang === 'fr' && about.text ? about.text : null;
  const body = `    <article class="seo-page">
      <p class="crumbs"><a href="../../#marche">Marché</a> › <a href="../">Cryptos</a> › ${esc(coin.name)}</p>
      <h1>${esc(name)} : prix et tendance</h1>
      <div class="box seo-stats">
        <div><span class="k">Prix</span><span class="num">${priceText(coin.price)} $</span></div>
        <div><span class="k">24 h</span><span class="num">${pct(coin.change24h)}</span></div>
        <div><span class="k">7 jours</span><span class="num">${pct(coin.change7d)}</span></div>
        <div><span class="k">30 jours</span><span class="num">${pct(coin.change30d)}</span></div>
        <div><span class="k">Capitalisation</span><span class="num">${money(coin.mcap)}</span></div>
        <div><span class="k">Volume 24 h</span><span class="num">${money(coin.volume)}</span></div>
      </div>
      ${tr ? `<p><b>Tendance selon Dinexo :</b> ${esc(tr)}. Dinexo regarde plusieurs signaux simples (moyennes des prix, élan, comparaison avec le Bitcoin) et compte ceux qui vont dans chaque sens.</p>` : ''}
      ${text ? `<h2>C'est quoi, ${esc(coin.name)} ?</h2>\n      <p>${esc(text)}</p>` : ''}
      <p><a class="btn primary" href="../../#crypto/${esc(coin.id)}">Voir la fiche complète : graphique, niveaux clés, levier</a></p>
      <p class="muted">Chiffres du ${esc(when(generatedAt))} (heure de Paris).</p>
      <h2>Autres cryptos</h2>
      <p class="seo-links">${others(coins, '../../', coin.id)}</p>
    </article>`;
  return page({ site, root: '../../', title: `${name} : prix, tendance et analyse | Dinexo`, description, canonical, body });
}

// Page liste : les cryptos suivies, avec leur prix et leurs variations.
export function listPage({ site, coins, generatedAt }) {
  const rows = coins.map(c => `<tr><td class="l"><a href="${esc(c.id)}/">${esc(c.name)}</a> <span class="muted">${esc(c.symbol)}</span></td><td class="n">${priceText(c.price)} $</td><td class="n">${pct(c.change24h)}</td><td class="n">${pct(c.change7d)}</td><td class="n">${money(c.mcap)}</td></tr>`).join('\n          ');
  const body = `    <article class="seo-page">
      <p class="crumbs"><a href="../#marche">Marché</a> › Cryptos</p>
      <h1>Cours des ${coins.length} premières cryptomonnaies</h1>
      <p>Prix du jour, variation sur 24 h et 7 jours, et taille de chaque crypto (capitalisation). Clique sur une crypto pour sa tendance et sa présentation en français.</p>
      <div class="wrap"><table class="static">
        <thead><tr><th class="l">Crypto</th><th>Prix</th><th>24 h</th><th>7 jours</th><th>Capitalisation</th></tr></thead>
        <tbody>
          ${rows}
        </tbody>
      </table></div>
      <p class="muted">Chiffres du ${esc(when(generatedAt))} (heure de Paris).</p>
      <p><a class="btn primary" href="../#marche">Ouvrir l'onglet Marché en direct</a></p>
    </article>`;
  return page({
    site, root: '../', title: 'Cours des cryptomonnaies en français : prix et tendance | Dinexo',
    description: `Prix du jour et tendance des ${coins.length} premières cryptos (Bitcoin, Ethereum, Solana…), expliqués simplement en français. Gratuit, mis à jour toutes les heures.`,
    canonical: `${site}/crypto/`, body,
  });
}

// Plan du site pour Google : la page d'accueil, la liste et chaque fiche.
export function sitemap({ site, coins, generatedAt }) {
  const day = String(generatedAt).slice(0, 10);
  const urls = [`${site}/`, ...(coins.length ? [`${site}/crypto/`] : []), ...coins.map(c => `${site}/crypto/${c.id}/`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${esc(u)}</loc><lastmod>${day}</lastmod></url>`).join('\n')}
</urlset>
`;
}

// Guide du site pour les agents IA et les robots (format llms.txt : https://llmstxt.org) : ce qu'est Dinexo,
// les pages lisibles sans JavaScript et les fichiers de données publics, mis à jour toutes les heures.
export function llms({ site, coins }) {
  const list = coins.map(c => `- [${c.name} (${c.symbol})](${site}/crypto/${c.id}/)`).join('\n');
  return `# Dinexo

> Tableau de bord crypto gratuit en français : marché, setups de trading dans le sens de la tendance sur BTC, ETH, SOL et le pétrole Brent, actualité qui fait bouger les prix, projets crypto rentables et outils de simulation. Mis à jour toutes les heures. Information seulement, pas de conseil en investissement.

Le tableau de bord (${site}/) est une application en JavaScript à onglets (#marche, #setups, #actu…). Pour lire le contenu sans l'exécuter, utilise les pages fixes et les fichiers JSON ci-dessous.

## Pages lisibles sans JavaScript

- [Toutes les cryptos suivies](${site}/crypto/)
${list}

## Données publiques (JSON)

- [Marché](${site}/data/marche.json) : prix, tendance, indicateurs, agenda macro, secteurs
- [Setups](${site}/data/setups.json) : signaux de trading en cours et historique
- [Actu](${site}/data/news.json) : news classées par importance, traduites en français
- [Projets](${site}/data/projects.json) : petits projets crypto classés par revenus
- [Outils](${site}/data/outils.json) : flux des ETF, funding, ratio long / short

## Informations légales

- [Conditions d'utilisation](${site}/legal/cgu.html)
- [Confidentialité](${site}/legal/confidentialite.html)
- [Mentions légales](${site}/legal/mentions-legales.html)
`;
}

export const robots = site => `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`;

// Page d'accueil : remplace l'adresse du site dans les balises et ajoute les liens vers les fiches en bas.
export function homePage(html, { site, coins }) {
  const links = coins.length ? `<p class="seo-links">Cours des cryptos : <a href="crypto/">toutes</a> · ${others(coins, '', null)}</p>` : '';
  return html.replaceAll('%SITE%', site).replace('<!-- seo:fiches -->', links);
}
