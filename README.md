# Dinexo

Dashboard de trading public :

- **Projets** : petits projets crypto (< 1 Md$, pas encore sur Binance) qui génèrent de vrais revenus et grandissent. ✅
- **Setups 4h** : 5 détecteurs indépendants sur OKX (top 50 crypto + pétrole/gaz), avec stop, objectifs et taux de réussite de chaque détecteur. ✅
- **Actu** : géopolitique, banques centrales, OPEP, régulation, hacks, ETF, baleines, traduits en français, classés par importance avec l'impact probable par actif. Bandeau rouge sur les news critiques. ✅

Le cahier des charges complet est dans [`SPEC.md`](SPEC.md), la maquette dans [`mockup/index.html`](mockup/index.html).

> **Ceci n'est pas un conseil financier.**

## Fonctionnement

```
GitHub Actions (toutes les heures) ── scripts/build-data.mjs ──▶ data/projects.json, data/market.json
                                  ├─ scripts/build-setups.mjs ──▶ data/setups.json
                                  └─ scripts/build-news.mjs ──▶ data/news.json (aussi toutes les 15 minutes)
GitHub Pages ── index.html + css/ + js/ ──▶ lit les fichiers JSON
```

Les données sont récupérées une seule fois pour tous les visiteurs (DefiLlama, CoinGecko, Binance, OKX,
flux d'actu officiels, Google News, médias crypto, pages publiques Telegram).
Chaque partie (projets, setups, actu) est indépendante : si une de ses sources essentielles ne répond pas,
la version déjà en ligne de cette partie est republiée telle quelle, sans bloquer les autres.
L'actu n'a besoin d'aucune clé : la traduction utilise l'accès gratuit de Google Traduction (MyMemory en secours).

## Mise en ligne (une seule fois)

1. Sur GitHub : **Settings → Pages → Build and deployment → Source : GitHub Actions**.
2. Fusionner le travail dans la branche par défaut du dépôt. La publication part automatiquement, puis toutes les heures (l'actu toutes les 15 minutes).
3. Optionnel : créer une clé gratuite CoinGecko (« Demo API key ») et l'ajouter dans **Settings → Secrets and variables → Actions** sous le nom `COINGECKO_API_KEY`. Ça évite les refus quand CoinGecko est saturé.

Le site sera à l'adresse `https://<compte>.github.io/<dépôt>/`.

## En local

Il faut Node.js 20 ou plus. Aucune dépendance à installer.

```sh
npm test          # tests
npm run sample    # données d'exemple dans data/ (aucun accès réseau)
npm run data      # vraies données dans data/
npm run serve     # puis ouvrir http://localhost:8080
```
