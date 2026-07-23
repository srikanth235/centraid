import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { handleRequest } from './index.js';

const NOW = Date.UTC(2026, 6, 23, 10, 0, 0);
const STATE = `w.${'A'.repeat(43)}`;
const VERIFIER = 'v'.repeat(43);
const CODE = 'google-authorization-code';
const BROWSER_BINDING = 'b'.repeat(43);

function environment(): Env {
  return {
    APP_ORIGIN: 'https://app.centraid.dev',
    CALLBACK_URL: 'https://oauth.centraid.dev/callback',
    CALLBACK_RECEIPT_SECRET: 'receipt-secret-with-at-least-thirty-two-bytes',
    EXCHANGE_ENABLED: 'true',
    GLOBAL_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    GOOGLE_CLIENT_ID: 'shared.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'worker-only-google-secret',
    IP_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    METRICS: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
    RESTRICTED_SCOPES_ENABLED: 'false',
  };
}

const context = {} as ExecutionContext;

afterEach(() => {
  vi.restoreAllMocks();
});

async function bindCookie(
  env: Env,
  origin = 'https://oauth.centraid.dev',
  now = NOW,
): Promise<string> {
  const response = await handleRequest(
    new Request(`${origin}/bind`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.7',
      },
      body: JSON.stringify({ state: STATE, browser_binding: BROWSER_BINDING }),
    }),
    env,
    context,
    { fetch, now: () => now },
  );
  expect(response.status).toBe(204);
  return response.headers.get('set-cookie')!.split(';', 1)[0]!;
}

async function callbackReceipt(env: Env, now = NOW): Promise<string> {
  const cookie = await bindCookie(env, 'https://oauth.centraid.dev', now);
  const response = await handleRequest(
    new Request(
      `https://oauth.centraid.dev/callback?state=${encodeURIComponent(STATE)}&code=${encodeURIComponent(CODE)}`,
      { headers: { cookie, 'cf-connecting-ip': '203.0.113.7' } },
    ),
    env,
    context,
    { fetch, now: () => now },
  );
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location')!);
  expect(location.origin + location.pathname).toBe('https://app.centraid.dev/oauth/finish');
  const fragment = new URLSearchParams(location.hash.slice(1));
  expect(fragment.get('state')).toBe(STATE);
  expect(fragment.get('code')).toBe(CODE);
  return fragment.get('receipt')!;
}

function exchangeRequest(receipt?: string, bodyPatch: Record<string, unknown> = {}): Request {
  return new Request('https://oauth.centraid.dev/exchange', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.7',
    },
    body: JSON.stringify({
      provider: 'google',
      code: CODE,
      code_verifier: VERIFIER,
      redirect_uri: 'https://oauth.centraid.dev/callback',
      state: STATE,
      browser_binding: BROWSER_BINDING,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      ...(receipt ? { receipt } : {}),
      ...bodyPatch,
    }),
  });
}

describe('Centraid Assist Worker', () => {
  test('deployment has no durable-storage binding or alternate public hostname', () => {
    const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    expect(config).toContain('"workers_dev": false');
    expect(config).toContain('"preview_urls": false');
    expect(config).toContain('"invocation_logs": false');
    expect(config).toContain('"traces": {\n      "enabled": false');
    expect(config).toContain('"logs": {\n      "enabled": false');
    expect(config).not.toMatch(
      /kv_namespaces|d1_databases|durable_objects|r2_buckets|queues|hyperdrive|browser/,
    );
  });

  test('start page scrubs its fragment before binding and contains no ceremony material', async () => {
    const response = await handleRequest(
      new Request('https://oauth.centraid.dev/start'),
      environment(),
      context,
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(html.indexOf('history.replaceState')).toBeLessThan(html.indexOf("fetch('/bind'"));
    expect(html).not.toContain(CODE);
    expect(html).not.toContain(BROWSER_BINDING);
  });

  test('callback mints a short-lived receipt and exchange attaches the Worker-only secret', async () => {
    const env = environment();
    const receipt = await callbackReceipt(env);
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('client_id')).toBe(env.GOOGLE_CLIENT_ID);
      expect(form.get('client_secret')).toBe(env.GOOGLE_CLIENT_SECRET);
      expect(form.get('code_verifier')).toBe(VERIFIER);
      return Response.json({
        access_token: 'ya29.gateway-only',
        refresh_token: '1//gateway-only',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/calendar.readonly',
      });
    });
    const response = await handleRequest(exchangeRequest(receipt), env, context, {
      fetch: upstream as typeof fetch,
      now: () => NOW,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: 'ya29.gateway-only',
      refresh_token: '1//gateway-only',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('strict-transport-security')).toContain('includeSubDomains');
  });

  test('callback telemetry is aggregate-only and desktop HTML exposes no tokens', async () => {
    const env = environment();
    const log = vi.spyOn(console, 'info');
    const desktopState = `d.${'D'.repeat(43)}`;
    const desktopBinding = 'd'.repeat(43);
    const bindResponse = await handleRequest(
      new Request('https://oauth.centraid.dev/bind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: desktopState, browser_binding: desktopBinding }),
      }),
      env,
      context,
      { fetch, now: () => NOW },
    );
    const cookie = bindResponse.headers.get('set-cookie')!.split(';', 1)[0]!;
    const response = await handleRequest(
      new Request(
        `https://oauth.centraid.dev/callback?state=${desktopState}&code=${encodeURIComponent(CODE)}`,
        { headers: { cookie } },
      ),
      env,
      context,
      { fetch, now: () => NOW },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain('centraid://oauth/finish#');
    expect(html).not.toContain('ya29.');
    expect(log).not.toHaveBeenCalled();
    expect(env.METRICS.writeDataPoint).toHaveBeenCalledWith({
      blobs: ['callback', 'success'],
      doubles: [200, 1],
    });
  });

  test('browser binding plus missing, forged, and expired receipts fail before Google is called', async () => {
    const env = environment();
    const upstream = vi.fn();
    const unboundCallback = await handleRequest(
      new Request(
        `https://oauth.centraid.dev/callback?state=${encodeURIComponent(STATE)}&code=${encodeURIComponent(CODE)}`,
      ),
      env,
      context,
      { fetch: upstream as typeof fetch, now: () => NOW },
    );
    expect(unboundCallback.status).toBe(400);
    expect(await unboundCallback.text()).not.toContain(CODE);
    const missing = await handleRequest(exchangeRequest(), env, context, {
      fetch: upstream as typeof fetch,
      now: () => NOW,
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'invalid_body' });

    const receipt = await callbackReceipt(env);
    const forged = `${receipt.slice(0, -1)}${receipt.endsWith('A') ? 'B' : 'A'}`;
    const forgedResponse = await handleRequest(exchangeRequest(forged), env, context, {
      fetch: upstream as typeof fetch,
      now: () => NOW,
    });
    expect(await forgedResponse.json()).toEqual({ error: 'invalid_receipt' });

    const wrongBrowser = await handleRequest(
      exchangeRequest(receipt, { browser_binding: 'x'.repeat(43) }),
      env,
      context,
      { fetch: upstream as typeof fetch, now: () => NOW },
    );
    expect(await wrongBrowser.json()).toEqual({ error: 'invalid_receipt' });

    const expired = await handleRequest(exchangeRequest(receipt), env, context, {
      fetch: upstream as typeof fetch,
      now: () => NOW + 121_000,
    });
    expect(await expired.json()).toEqual({ error: 'expired_receipt' });
    expect(upstream).not.toHaveBeenCalled();
  });

  test('invalid body shape and PKCE verifier are rejected before any upstream call', async () => {
    const env = environment();
    const upstream = vi.fn();
    const nonObject = new Request('https://oauth.centraid.dev/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });
    expect(
      (
        await handleRequest(nonObject, env, context, {
          fetch: upstream as typeof fetch,
          now: () => NOW,
        })
      ).status,
    ).toBe(400);
    const receipt = await callbackReceipt(env);
    const weakPkce = await handleRequest(
      exchangeRequest(receipt, { code_verifier: 'too-short' }),
      env,
      context,
      { fetch: upstream as typeof fetch, now: () => NOW },
    );
    expect(await weakPkce.json()).toEqual({ error: 'invalid_body' });
    const restricted = await handleRequest(
      exchangeRequest(receipt, {
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      }),
      env,
      context,
      { fetch: upstream as typeof fetch, now: () => NOW },
    );
    expect(await restricted.json()).toEqual({ error: 'invalid_body' });
    expect(upstream).not.toHaveBeenCalled();
  });

  test('Google must return the exact requested allowlisted scope set', async () => {
    const env = environment();
    const receipt = await callbackReceipt(env);
    const upstream = vi.fn(async () =>
      Response.json({
        access_token: 'ya29.must-not-leave-worker',
        refresh_token: '1//must-not-leave-worker',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      }),
    );
    const response = await handleRequest(exchangeRequest(receipt), env, context, {
      fetch: upstream as typeof fetch,
      now: () => NOW,
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'invalid_upstream_response' });
  });

  test('refresh is stateless and returns only allowlisted OAuth fields', async () => {
    const env = environment();
    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe('1//stored-on-gateway');
      expect(form.get('client_secret')).toBe(env.GOOGLE_CLIENT_SECRET);
      return Response.json({
        access_token: 'ya29.refreshed',
        expires_in: 3600,
        id_token: 'must-not-leave-worker',
      });
    });
    const response = await handleRequest(
      new Request('https://oauth.centraid.dev/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'google',
          refresh_token: '1//stored-on-gateway',
        }),
      }),
      env,
      context,
      { fetch: upstream as typeof fetch, now: () => NOW },
    );
    expect(await response.json()).toEqual({
      access_token: 'ya29.refreshed',
      expires_in: 3600,
      token_type: 'Bearer',
    });
  });

  test('kill switch and rate limits fail closed without contacting Google', async () => {
    const disabled = {
      ...environment(),
      EXCHANGE_ENABLED: 'false',
    } as unknown as Env;
    const upstream = vi.fn();
    const response = await handleRequest(exchangeRequest('v1.0000000000.bad'), disabled, context, {
      fetch: upstream as typeof fetch,
      now: () => NOW,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'assist_disabled' });
    expect(upstream).not.toHaveBeenCalled();

    const limited = environment();
    limited.IP_LIMITER = { limit: async () => ({ success: false }) } as RateLimit;
    const limitedResponse = await handleRequest(
      exchangeRequest('v1.0000000000.bad'),
      limited,
      context,
      { fetch: upstream as typeof fetch, now: () => NOW },
    );
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get('retry-after')).toBe('60');
    expect(upstream).not.toHaveBeenCalled();
  });

  test('fixed public origins and environment invariants fail closed', async () => {
    const env = environment();
    expect(
      (
        await handleRequest(
          new Request('https://centraid-oauth.workers.dev/callback'),
          env,
          context,
        )
      ).status,
    ).toBe(421);
    expect(
      (
        await handleRequest(
          new Request('https://oauth.centraid.dev/callback'),
          { ...env, APP_ORIGIN: 'https://evil.example' } as unknown as Env,
          context,
        )
      ).status,
    ).toBe(503);

    const allowed = await handleRequest(
      new Request('https://oauth.centraid.dev/exchange', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.centraid.dev' },
      }),
      env,
      context,
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-methods')).toBe('GET');
    const denied = await handleRequest(
      new Request('https://oauth.centraid.dev/exchange', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      }),
      env,
      context,
    );
    expect(denied.status).toBe(403);
  });

  test('separate local Testing credentials can run on an exact loopback callback', async () => {
    const env = {
      ...environment(),
      APP_ORIGIN: 'http://127.0.0.1:4173',
      CALLBACK_URL: 'http://127.0.0.1:8787/callback',
    } as unknown as Env;
    const cookie = await bindCookie(env, 'http://127.0.0.1:8787');
    const response = await handleRequest(
      new Request(`http://127.0.0.1:8787/callback?state=${STATE}&code=${CODE}`, {
        headers: { cookie },
      }),
      env,
      context,
      { fetch, now: () => NOW },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toMatch(/^http:\/\/127\.0\.0\.1:4173\/oauth\/finish#/);

    const wrongPort = await handleRequest(
      new Request(`http://127.0.0.1:8788/callback?state=${STATE}&code=${CODE}`),
      {
        ...env,
        CALLBACK_URL: 'http://127.0.0.1:8788/callback',
      } as unknown as Env,
      context,
      { fetch, now: () => NOW },
    );
    expect(wrongPort.status).toBe(421);
  });
});
