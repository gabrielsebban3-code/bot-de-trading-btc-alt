// Remplace fetch par les réponses fictives de fixtures.mjs, setups-fixtures.mjs, news-fixtures.mjs, marche-fixtures.mjs,
// outils-fixtures.mjs et crypto-fixtures.mjs. Quand les deux connaissent une adresse OKX (funding, long / short),
// les fiches crypto répondent : leur test vérifie ces valeurs. Avec DINEXO_MOCK_PRIX=1, les prix journaliers de
// prix-fixtures.mjs répondent en premier (scripts/build-prix.mjs), sans changer les réponses des autres scripts.
// Usage : node --import ./tests/mock-fetch.mjs scripts/build-data.mjs --out data --sample
import { fixtures, route } from './fixtures.mjs';
import { routeSetups, setupRoutes } from './setups-fixtures.mjs';
import { routeNews } from './news-fixtures.mjs';
import { marcheRoutes, routeMarche } from './marche-fixtures.mjs';
import { routeOutils } from './outils-fixtures.mjs';
import { cryptoRoutes, routeCrypto } from './crypto-fixtures.mjs';
import { prixRoutes, routePrix } from './prix-fixtures.mjs';

// Les scripts qui espacent leurs demandes (scripts/build-cryptos.mjs) n'attendent pas avec les réponses fictives.
process.env.DINEXO_FAST ??= '1';
const routes = fixtures();
const setups = setupRoutes();
const marche = marcheRoutes();
const crypto = cryptoRoutes();
const prix = process.env.DINEXO_MOCK_PRIX === '1' ? prixRoutes() : null;
globalThis.fetch = async url => {
  const body = (prix ? routePrix(prix, String(url)) : undefined) ?? routeCrypto(crypto, String(url)) ?? routeOutils(String(url)) ?? routeMarche(marche, String(url)) ?? routeNews(String(url)) ?? routeSetups(setups, String(url)) ?? route(routes, String(url));
  return {
    ok: body !== undefined,
    status: body !== undefined ? 200 : 404,
    headers: new Headers(),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : structuredClone(body)),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
};
