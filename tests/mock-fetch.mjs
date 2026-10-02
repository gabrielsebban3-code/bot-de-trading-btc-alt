// Remplace fetch par les réponses fictives de fixtures.mjs et setups-fixtures.mjs.
// Usage : node --import ./tests/mock-fetch.mjs scripts/build-data.mjs --out data --sample
import { fixtures, route } from './fixtures.mjs';
import { routeSetups, setupRoutes } from './setups-fixtures.mjs';

const routes = fixtures();
const setups = setupRoutes();
globalThis.fetch = async url => {
  const body = routeSetups(setups, String(url)) ?? route(routes, String(url));
  return {
    ok: body !== undefined,
    status: body !== undefined ? 200 : 404,
    headers: new Headers(),
    json: async () => structuredClone(body),
  };
};
