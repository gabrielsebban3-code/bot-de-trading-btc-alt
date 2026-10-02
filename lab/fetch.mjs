// Télécharge l'historique OKX (4h et 1D) des paires du swing pour les tests hors ligne.
import { mkdir, writeFile } from 'node:fs/promises';
const OKX = 'https://www.okx.com/api/v5';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(path) {
  for (let k = 0; k < 5; k++) {
    await sleep(150);
    const r = await fetch(OKX + path).then(r => r.json()).catch(e => ({ code: 'net', msg: e.message }));
    if (r.code === '0') return r.data;
    console.warn(path, r.msg || r.code); await sleep(2000);
  }
  throw new Error(path);
}
const toBar = row => ({ t: Number(row[0]), o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[7]), closed: row[8] === '1' });
async function series(instId, bar, maxPages) {
  const rows = await get(`/market/candles?instId=${instId}&bar=${bar}&limit=300`);
  for (let p = 0; p < maxPages && rows.length; p++) {
    const older = await get(`/market/history-candles?instId=${instId}&bar=${bar}&limit=100&after=${rows.at(-1)[0]}`);
    if (!older.length) break;
    rows.push(...older);
  }
  return rows.map(toBar).sort((a, b) => a.t - b.t);
}
const inst = await get('/public/instruments?instType=SWAP');
for (const i of inst.filter(i => /^(BZ|CL|BRENT|WTI|OIL|XBR|XTI)/.test(i.instId) || /OIL|BRENT/i.test(i.instFamily || ''))) console.log('instrument', i.instId, i.listTime && new Date(Number(i.listTime)).toISOString(), i.state, i.settleCcy);
await mkdir('lab/data', { recursive: true });
for (const sym of ['BTC', 'ETH', 'SOL', 'BZ', 'CL']) {
  const id = `${sym}-USDT-SWAP`;
  try {
    const h4 = await series(id, '4H', 75), d1 = await series(id, '1Dutc', 12);
    console.log(sym, h4.length, new Date(h4[0].t).toISOString(), d1.length, new Date(d1[0].t).toISOString());
    await writeFile(`lab/data/${sym}.json`, JSON.stringify({ h4, d1 }));
  } catch (e) { console.warn(sym, e.message); }
}
