import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RouteHandler } from '../serve/build-gateway.js';
import { HealthRegistry, MAX_BACKGROUND_PAUSE_MS } from '../serve/health-registry.js';
import { makeResourceRouteHandler } from './resource-routes.js';

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

const PAUSE = '/centraid/_gateway/resource/pause';

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('makeResourceRouteHandler', () => {
  it('POST with no body pauses indefinitely and flips the pause signal', async () => {
    const registry = new HealthRegistry();
    const url = await startHandlerServer(makeResourceRouteHandler(registry));

    const res = await fetch(`${url}${PAUSE}`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paused: true, until: null });
    expect(registry.shouldPauseBackgroundWork()).toBe(true);
  });

  it('POST with a valid durationMs returns an ISO until', async () => {
    const registry = new HealthRegistry({ now: () => 1_000 });
    const url = await startHandlerServer(makeResourceRouteHandler(registry));

    const res = await fetch(`${url}${PAUSE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ durationMs: 5_000 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paused: true, until: new Date(6_000).toISOString() });
  });

  it('rejects non-positive, non-integer, oversized, and non-numeric durations with 400', async () => {
    const registry = new HealthRegistry();
    const url = await startHandlerServer(makeResourceRouteHandler(registry));

    for (const durationMs of [0, -1, 1.5, MAX_BACKGROUND_PAUSE_MS + 1, 'soon']) {
      const res = await fetch(`${url}${PAUSE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ durationMs }),
      });
      expect(res.status, `durationMs=${durationMs}`).toBe(400);
    }
    // A rejected request never pauses.
    expect(registry.shouldPauseBackgroundWork()).toBe(false);
  });

  it('accepts the exact 24h ceiling', async () => {
    const registry = new HealthRegistry();
    const url = await startHandlerServer(makeResourceRouteHandler(registry));

    const res = await fetch(`${url}${PAUSE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ durationMs: MAX_BACKGROUND_PAUSE_MS }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const registry = new HealthRegistry();
    const url = await startHandlerServer(makeResourceRouteHandler(registry));

    const res = await fetch(`${url}${PAUSE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('DELETE resumes', async () => {
    const registry = new HealthRegistry();
    registry.pauseBackgroundWork();
    const url = await startHandlerServer(makeResourceRouteHandler(registry));

    const res = await fetch(`${url}${PAUSE}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paused: false });
    expect(registry.shouldPauseBackgroundWork()).toBe(false);
  });

  it('answers 405 for other methods and ignores other paths', async () => {
    const url = await startHandlerServer(makeResourceRouteHandler(new HealthRegistry()));

    const get = await fetch(`${url}${PAUSE}`, { method: 'GET' });
    expect(get.status).toBe(405);

    const other = await fetch(`${url}/centraid/_gateway/resource/other`);
    expect(other.status).toBe(404);
  });
});
