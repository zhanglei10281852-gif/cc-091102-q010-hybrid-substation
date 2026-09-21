import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { defaultConfig } from './config.js';
import { Store } from './store.js';
import { ValidationError, cancelGroup, getReservation, reserveGroup } from './domain.js';

const SERVICE = 'hybrid-substation-window';
const MAX_BODY_BYTES = 1_000_000;

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ValidationError('payload-too-large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('invalid-json');
  }
}

export function createHandler(store) {
  return async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = url.pathname;
      if (request.method === 'GET' && (path === '/' || path === '/health')) {
        return send(200, { service: SERVICE, status: 'running', ...store.stats() });
      }
      if (request.method === 'POST' && path === '/reservations') {
        const result = await reserveGroup(store, await readJson(request));
        return send(result.state === 'approved' ? 200 : 409, result);
      }
      let match = /^\/reservations\/([^/]+)$/.exec(path);
      if (match && request.method === 'GET') {
        return send(200, getReservation(store, decodeURIComponent(match[1])));
      }
      match = /^\/reservations\/([^/]+)\/cancel$/.exec(path);
      if (match && request.method === 'POST') {
        return send(200, await cancelGroup(store, decodeURIComponent(match[1])));
      }
      match = /^\/resources\/([^/]+)\/calendar$/.exec(path);
      if (match && request.method === 'GET') {
        const resource = decodeURIComponent(match[1]);
        if (!store.config.resources[resource]) {
          return send(404, { error: { code: 'not-found', message: `unknown-resource:${resource}` } });
        }
        return send(200, store.getCalendar(resource, { from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
      }
      if (request.method === 'POST' && path === '/admin/recover') {
        return send(200, store.recover());
      }
      return send(404, { error: { code: 'not-found', message: `${request.method} ${path}` } });
    } catch (err) {
      const status = err.httpStatus ?? 500;
      return send(status, { error: { code: err.code ?? 'internal', message: err.message } });
    }
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const journalPath = process.env.JOURNAL_PATH ?? 'var/journal.jsonl';
  const store = await Store.open(defaultConfig, { journalPath });
  store.startSweeper();
  const port = Number(process.env.PORT || 8080);
  createServer(createHandler(store)).listen(port, () => {
    console.log(`${SERVICE} listening on :${port} (journal: ${journalPath})`);
  });
}
