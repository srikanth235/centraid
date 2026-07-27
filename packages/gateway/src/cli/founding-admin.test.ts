import { tempDir } from '@centraid/test-kit/temp-dir';
import { buildGatewayInfoPayload, ROUTES } from '@centraid/protocol';
import { endpointIdForSecret } from '@centraid/tunnel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { commandInitTicket } from './founding-admin.js';
import { daemonKeyStore } from './key-store.js';
import { landlordBearerForEndpointSecret } from './landlord-auth.js';
import { daemonLayoutFor } from './paths.js';

class CliFailError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'CliFailError';
  }
}

const fail = (message: string, code = 1): never => {
  throw new CliFailError(message, code);
};

let dataDir: string;
let stdout: string[];

beforeEach(async () => {
  dataDir = await tempDir('founding-admin-');
  stdout = [];
});

afterEach(async () => {
  await fs.rm(dataDir, { force: true, recursive: true });
});

async function capture(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown): boolean => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return stdout.join('');
}

function daemonFetch(
  secret: Buffer,
  ticketResponse: Response = Response.json({
    expiresAt: '2030-01-02T03:04:05.000Z',
    ok: true,
    ticket: 'centraid-founding-ticket',
  }),
): { calls: Array<{ init?: RequestInit; url: URL }>; fetchImpl: typeof fetch } {
  const calls: Array<{ init?: RequestInit; url: URL }> = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? String(input) : input.url,
    );
    calls.push({ init, url });
    if (url.pathname === ROUTES.gatewayInfo) {
      // Mirror production #568 item C: dial tickets only for authenticated callers.
      const headers = new Headers(init?.headers);
      const authorized =
        headers.get('authorization') === `Bearer ${landlordBearerForEndpointSecret(secret)}`;
      return Response.json(
        buildGatewayInfoPayload({
          endpointId: endpointIdForSecret(secret),
          ...(authorized ? { endpointTicket: 'live-endpoint-ticket' } : {}),
          instanceId: 'daemon',
          startedAt: Date.now(),
          uptimeMs: 10,
        }),
      );
    }
    return ticketResponse;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function storeEndpointSecret(): Promise<Buffer> {
  const secret = Buffer.alloc(32, 19);
  daemonKeyStore(daemonLayoutFor(dataDir).keysDir).store('endpoint-key.bin', secret);
  return secret;
}

describe('init-ticket admin command', () => {
  it('mints authenticated text, JSON, and QR output from the matching daemon', async () => {
    const secret = await storeEndpointSecret();
    const textDaemon = daemonFetch(secret);
    const text = await capture(() =>
      commandInitTicket(['--data-dir', dataDir, '--port', '48123'], fail, textDaemon.fetchImpl),
    );
    expect(text).toContain('One-time gateway founding ticket');
    expect(text).toContain('centraid-founding-ticket');
    expect(textDaemon.calls.at(-1)).toMatchObject({
      init: {
        headers: { Authorization: `Bearer ${landlordBearerForEndpointSecret(secret)}` },
        method: 'POST',
      },
    });
    expect(textDaemon.calls.at(-1)?.url.pathname).toBe(ROUTES.gatewayFoundingTicket);

    stdout = [];
    const json = await capture(() =>
      commandInitTicket(
        ['--data-dir', dataDir, '--port', '48123', '--json'],
        fail,
        daemonFetch(secret).fetchImpl,
      ),
    );
    expect(JSON.parse(json)).toEqual({
      expiresAt: '2030-01-02T03:04:05.000Z',
      ok: true,
      ticket: 'centraid-founding-ticket',
    });

    stdout = [];
    const qr = await capture(() =>
      commandInitTicket(
        ['--data-dir', dataDir, '--port', '48123', '--qr'],
        fail,
        daemonFetch(secret).fetchImpl,
      ),
    );
    expect(qr).toContain('centraid-founding-ticket');
    expect(qr).toContain('\u2588');
  });

  it('rejects invalid flags and emits the JSON failure contract', async () => {
    await expect(capture(() => commandInitTicket(['--port', '0'], fail))).rejects.toMatchObject({
      code: 2,
    });
    await expect(capture(() => commandInitTicket(['--port'], fail))).rejects.toMatchObject({
      code: 2,
    });
    await expect(capture(() => commandInitTicket(['--wat'], fail))).rejects.toMatchObject({
      code: 2,
    });

    stdout = [];
    await expect(capture(() => commandInitTicket(['--json', '--wat'], fail))).rejects.toMatchObject(
      { code: 2 },
    );
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      error: 'usage',
      message: 'unknown flag "--wat"',
      ok: false,
    });
  });

  it('fails closed for stopped, mismatched, unready, and refusing daemons', async () => {
    const secret = await storeEndpointSecret();
    await expect(
      capture(() =>
        commandInitTicket(['--data-dir', dataDir, '--port', '48123'], fail, async () => {
          throw new Error('refused');
        }),
      ),
    ).rejects.toThrow(/daemon not running/);

    const mismatch = daemonFetch(Buffer.alloc(32, 20));
    await expect(
      capture(() =>
        commandInitTicket(['--data-dir', dataDir, '--port', '48123'], fail, mismatch.fetchImpl),
      ),
    ).rejects.toThrow(/identity is not ready/);

    const unreadyFetch = (async (): Promise<Response> =>
      Response.json(
        buildGatewayInfoPayload({
          endpointId: endpointIdForSecret(secret),
          instanceId: 'daemon',
          startedAt: Date.now(),
          uptimeMs: 10,
        }),
      )) as typeof fetch;
    await expect(
      capture(() =>
        commandInitTicket(['--data-dir', dataDir, '--port', '48123'], fail, unreadyFetch),
      ),
    ).rejects.toThrow(/identity is not ready/);

    const refused = daemonFetch(
      secret,
      Response.json({ message: 'already initialized' }, { status: 409 }),
    );
    await expect(
      capture(() =>
        commandInitTicket(['--data-dir', dataDir, '--port', '48123'], fail, refused.fetchImpl),
      ),
    ).rejects.toThrow(/already initialized/);
  });

  it('reports a daemon that stops between handshake and mint', async () => {
    const secret = await storeEndpointSecret();
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? String(input) : input.url,
      );
      if (url.pathname === ROUTES.gatewayInfo) {
        return Response.json(
          buildGatewayInfoPayload({
            endpointId: endpointIdForSecret(secret),
            endpointTicket: 'live-endpoint-ticket',
            instanceId: 'daemon',
            startedAt: Date.now(),
            uptimeMs: 10,
          }),
        );
      }
      throw new Error('stopped');
    }) as typeof fetch;

    await expect(
      capture(() => commandInitTicket(['--data-dir', dataDir, '--port', '48123'], fail, fetchImpl)),
    ).rejects.toThrow(/stopped before/);
  });
});
