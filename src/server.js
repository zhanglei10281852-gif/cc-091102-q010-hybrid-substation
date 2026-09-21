// 统一入口 HTTP 服务。所有写入都经过领域服务，保证三个资源视图只有一个共同结论。
import { createServer } from 'node:http';
import { Store } from './store.js';
import { createReservationService, HttpError } from './domain.js';
import { catalog, knownResourceIds } from './catalog.js';

export function createHttpServer(store = new Store(), options = {}) {
  const service = createReservationService(store, options);

  function send(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(payload);
  }

  async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 65536) throw new HttpError(413, 'payload-too-large');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid-json');
    }
  }

  const handler = async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const { pathname } = url;

    try {
      if (request.method === 'GET' && pathname === '/health') {
        return send(response, 200, { service: 'hybrid-substation-window', status: 'running' });
      }

      if (request.method === 'GET' && pathname === '/resources') {
        return send(response, 200, { resources: knownResourceIds(), lockGroups: catalog.lockGroups });
      }

      if (request.method === 'POST' && pathname === '/reservations') {
        const body = await readJson(request);
        const result = await service.reserve(body);
        // rejected 携带失败方具体阻断资源；approved 在三个视图同时落定。
        return send(response, result.decision === 'approved' ? 201 : 409, result);
      }

      const cancelMatch = pathname.match(/^\/reservations\/([^/]+)\/cancel$/);
      if (request.method === 'POST' && cancelMatch) {
        const body = await readJson(request);
        const result = await service.cancel(decodeURIComponent(cancelMatch[1]), body.reason);
        return send(response, 200, result);
      }

      const getMatch = pathname.match(/^\/reservations\/([^/]+)$/);
      if (request.method === 'GET' && getMatch) {
        return send(response, 200, service.get(decodeURIComponent(getMatch[1])));
      }

      if (request.method === 'GET' && pathname === '/views') {
        return send(response, 200, service.views());
      }

      if (request.method === 'POST' && pathname === '/admin/recover') {
        return send(response, 200, service.recover());
      }

      return send(response, 404, { code: 'not-found' });
    } catch (err) {
      if (err instanceof HttpError) {
        return send(response, err.status, { code: err.code, ...err.details });
      }
      if (err?.code === 'lock-timeout') {
        return send(response, err.status ?? 503, { code: err.code, blockers: err.blockers });
      }
      return send(response, 500, { code: 'internal-error', message: String(err?.message ?? err) });
    }
  };

  return createServer((request, response) => {
    handler(request, response).catch((err) => {
      if (!response.headersSent) send(response, 500, { code: 'internal-error', message: String(err?.message ?? err) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8080);
  createHttpServer().listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`hybrid-substation-window listening on :${port}`);
  });
}
