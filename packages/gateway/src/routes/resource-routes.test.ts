import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RouteHandler } from '../serve/build-gateway.js';
import { HealthRegistry, MAX_BACKGROUND_PAUSE_MS } from '../serve/health-registry.js';
import { PowerContextMonitor } from '../serve/power-context.js';
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
const POWER = '/centraid/_gateway/resource/power-context';

/** A monitor with a resolved no-battery probe (darwin ⇒ mains) for route tests. */
async function readyMonitor(): Promise<PowerContextMonitor> {
  const m = new PowerContextMonitor({
    platform: 'darwin',
    now: () => 0,
    probeBattery: async () => ({ present: true, percent: 90, charging: true, discharging: false }),
  });
  await m.ready;
  return m;
}

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

describe('makeResourceRouteHandler power-context', () => {
  it('POST applies a valid push and flips the monitor deferral', async () => {
    const monitor = await readyMonitor();
    const url = await startHandlerServer(makeResourceRouteHandler(new HealthRegistry(), monitor));

    expect(monitor.isDeferringBackgroundWork()).toBe(false);
    const res = await fetch(`${url}${POWER}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ onBattery: true, batteryPercent: 10 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(monitor.isDeferringBackgroundWork()).toBe(true);
    expect(monitor.snapshot().reason).toBe('low-battery');
  });

  it('DELETE clears pushed state', async () => {
    const monitor = await readyMonitor();
    monitor.applyClientPush({ onBattery: true, batteryPercent: 5 });
    const url = await startHandlerServer(makeResourceRouteHandler(new HealthRegistry(), monitor));

    const res = await fetch(`${url}${POWER}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(monitor.isDeferringBackgroundWork()).toBe(false);
  });

  it('rejects garbage bodies with 400 and never pushes', async () => {
    const monitor = await readyMonitor();
    const url = await startHandlerServer(makeResourceRouteHandler(new HealthRegistry(), monitor));

    const bad: unknown[] = [
      {}, // onBattery missing
      { onBattery: 'yes' }, // wrong type
      { onBattery: true, batteryPercent: 150 }, // out of range
      { onBattery: true, batteryPercent: 'full' }, // wrong type
      { onBattery: true, charging: 'no' }, // wrong type
      { onBattery: true, thermalPressure: 'melting' }, // not an enum member
    ];
    for (const body of bad) {
      const res = await fetch(`${url}${POWER}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(monitor.isDeferringBackgroundWork()).toBe(false);
  });

  it('accepts an explicit thermal push on mains', async () => {
    const monitor = await readyMonitor();
    const url = await startHandlerServer(makeResourceRouteHandler(new HealthRegistry(), monitor));

    const res = await fetch(`${url}${POWER}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ onBattery: false, thermalPressure: 'critical' }),
    });
    expect(res.status).toBe(200);
    expect(monitor.snapshot().reason).toBe('thermal');
  });

  it('answers 405 for GET and 503 when no monitor is wired', async () => {
    const monitor = await readyMonitor();
    const withMonitor = await startHandlerServer(
      makeResourceRouteHandler(new HealthRegistry(), monitor),
    );
    const get = await fetch(`${withMonitor}${POWER}`, { method: 'GET' });
    expect(get.status).toBe(405);

    const noMonitor = await startHandlerServer(makeResourceRouteHandler(new HealthRegistry()));
    const res = await fetch(`${noMonitor}${POWER}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ onBattery: true }),
    });
    expect(res.status).toBe(503);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const monitor = await readyMonitor();
    const url = await startHandlerServer(makeResourceRouteHandler(new HealthRegistry(), monitor));

    const res = await fetch(`${url}${POWER}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
  });
});
