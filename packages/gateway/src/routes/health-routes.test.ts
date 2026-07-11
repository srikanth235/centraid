import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RouteHandler } from '../serve/build-gateway.js';
import { HealthRegistry } from '../serve/health-registry.js';
import { makeHealthRouteHandler } from './health-routes.js';

const servers: http.Server[] = [];

function startHandlerServer(handler: RouteHandler): Promise<string> {
  const server = http.createServer((req, res) => {
    void handler(req, res).then((owned) => {
      if (!owned) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('makeHealthRouteHandler', () => {
  it('returns the aggregated snapshot', async () => {
    const registry = new HealthRegistry({ now: () => 42_000 });
    registry.reportOk('vaults', '1 vault mounted');
    registry.reportError('outbox', 'drain failed: ECONNREFUSED');
    const url = await startHandlerServer(makeHealthRouteHandler(registry));

    const res = await fetch(`${url}/centraid/_gateway/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      components: Array<{ component: string; status: string; lastError?: string }>;
      recentEvents: Array<{ component: string; level: string }>;
    };
    expect(body.status).toBe('error');
    expect(body.components).toHaveLength(2);
    expect(body.components.find((c) => c.component === 'outbox')?.lastError).toBe(
      'drain failed: ECONNREFUSED',
    );
    expect(body.recentEvents[0]).toMatchObject({ component: 'outbox', level: 'error' });
  });

  it('runs registered probes at request time', async () => {
    const registry = new HealthRegistry();
    registry.registerProbe('vaults', async () => ({ status: 'ok', detail: '3 vaults mounted' }));
    const url = await startHandlerServer(makeHealthRouteHandler(registry));

    const res = await fetch(`${url}/centraid/_gateway/health`);
    const body = (await res.json()) as {
      components: Array<{ component: string; status: string; detail?: string }>;
    };
    expect(body.components).toEqual([
      expect.objectContaining({ component: 'vaults', status: 'ok', detail: '3 vaults mounted' }),
    ]);
  });

  it('answers 405 for non-GET and ignores other paths', async () => {
    const url = await startHandlerServer(makeHealthRouteHandler(new HealthRegistry()));

    const post = await fetch(`${url}/centraid/_gateway/health`, { method: 'POST' });
    expect(post.status).toBe(405);

    const other = await fetch(`${url}/centraid/_gateway/info`);
    expect(other.status).toBe(404); // handler returned false → server 404
  });
});
