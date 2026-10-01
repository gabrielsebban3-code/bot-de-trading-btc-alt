// Remplace fetch par les réponses fictives de fixtures.mjs.
// Usage : node --import ./tests/mock-fetch.mjs scripts/build-data.mjs --out data --sample
import { fixtures, route } from './fixtures.mjs';

const routes = fixtures();
globalThis.fetch = async url => {
  const body = route(routes, String(url));
  return {
    ok: body !== undefined,
    status: body !== undefined ? 200 : 404,
    headers: new Headers(),
    json: async () => structuredClone(body),
  };
};
