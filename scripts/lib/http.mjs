// Requêtes HTTP avec délai max, nouvelles tentatives et respect des limites (429).

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function fetchJson(url, options = {}) {
  return request(url, options, 'application/json', res => res.json());
}

// Pour les flux RSS, Atom et les pages HTML.
export function fetchText(url, options = {}) {
  return request(url, options, '*/*', res => res.text());
}

async function request(url, { headers = {}, timeout = 30_000, retries = 3, method = 'GET', body } = {}, accept, parse) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': 'Monexo/1.0 (+github pages dashboard)', Accept: accept, ...headers },
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        lastError = new Error(`HTTP ${res.status} ${url}`);
        if (attempt < retries) await sleep(retryAfter > 0 ? Math.min(retryAfter, 90) * 1000 : 2000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { fatal: true });
      return await parse(res);
    } catch (err) {
      lastError = err;
      if (err.fatal) throw err;
      if (attempt < retries) await sleep(2000 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

// Exécute fn sur chaque élément avec au plus `limit` appels en parallèle.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// Appelle fn et renvoie { ok, value } ou { ok: false, error } sans lever d'exception.
export async function attempt(label, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    console.warn(`⚠ ${label} : ${err.message}`);
    return { ok: false, error: err.message };
  }
}
