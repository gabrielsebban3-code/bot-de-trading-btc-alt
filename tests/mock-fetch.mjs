// Remplace fetch par les réponses fictives de fixtures.mjs, setups-fixtures.mjs, news-fixtures.mjs et marche-fixtures.mjs.
// Usage : node --import ./tests/mock-fetch.mjs scripts/build-data.mjs --out data --sample
import { fixtures, route } from './fixtures.mjs';
import { routeSetups, setupRoutes } from './setups-fixtures.mjs';
import { routeNews } from './news-fixtures.mjs';
import { marcheRoutes, routeMarche } from './marche-fixtures.mjs';

const routes = fixtures();
const setups = setupRoutes();
const marche = marcheRoutes();
globalThis.fetch = async url => {
  const body = routeMarche(marche, String(url)) ?? routeNews(String(url)) ?? routeSetups(setups, String(url)) ?? route(routes, String(url));
  return {
    ok: body !== undefined,
    status: body !== undefined ? 200 : 404,
    headers: new Headers(),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : structuredClone(body)),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
};
