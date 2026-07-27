import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetGatewayAuthCache } from './gateway-client-core.js';
import {
  getGatewayFoundingStatus,
  initializeGatewayVault,
  restoreGatewayVault,
  verifyGatewayFoundingKit,
} from './gateway-client-founding.js';

const fetchMock = vi.hoisted(() => vi.fn<(url: string, init: RequestInit) => Response>());

vi.hoisted(() => {
  (window as unknown as { CentraidApi: Record<string, unknown> }).CentraidApi = {
    onGatewayChanged: () => () => undefined,
    onVaultChanged: () => () => undefined,
    getGatewayAuth: async () => ({
      baseUrl: 'https://gateway.test',
      token: 'host-proof',
    }),
  };
  vi.stubGlobal('fetch', fetchMock);
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requests(): Array<{ path: string; method: string; body: unknown }> {
  return fetchMock.mock.calls.map((call) => {
    const [url, init] = call as [string, RequestInit];
    return {
      path: new URL(url).pathname,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
  });
}

describe('gateway-client-founding', () => {
  beforeEach(() => {
    resetGatewayAuthCache();
    fetchMock.mockReset().mockImplementation((url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/info')) return json({ status: 'uninitialized', endpointId: 'ep-1' });
      if (path.endsWith('/founding/ticket')) return json({ ticket: 'local-ticket' });
      if (path.endsWith('/vaults:initialize/verify')) {
        return json({ ok: true, vaultId: 'vault-1', fingerprint: 'fp' });
      }
      if (path.endsWith('/vaults:initialize')) {
        return json({
          vault: { vaultId: 'vault-1', name: 'Personal' },
          kit: { format: 'centraid-recovery-kit/2' },
          fingerprint: 'fp',
          recoveryScope: 'future-backed-vaults',
        });
      }
      return json({ ok: true, report: { vaultId: 'vault-1' }, reports: [] });
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('gateway founding client', () => {
    it('reads the public zero-vault status without inventing a vault identity', async () => {
      await expect(getGatewayFoundingStatus()).resolves.toStrictEqual({
        status: 'uninitialized',
        endpointId: 'ep-1',
      });
      expect(requests()).toContainEqual({
        path: '/centraid/_gateway/info',
        method: 'GET',
        body: undefined,
      });
    });

    it('mints a host-only ticket before local initialization', async () => {
      await initializeGatewayVault({ name: 'Personal', password: 'correct horse' });
      expect(requests()).toStrictEqual([
        {
          path: '/centraid/_gateway/founding/ticket',
          method: 'POST',
          body: undefined,
        },
        {
          path: '/centraid/_vault/vaults:initialize',
          method: 'POST',
          body: { name: 'Personal', password: 'correct horse', ticket: 'local-ticket' },
        },
      ]);
    });

    it('uses a scanned remote ticket directly and never mints another', async () => {
      await restoreGatewayVault({
        ticket: 'scanned-ticket',
        kit: { format: 'centraid-recovery-kit/2' },
        password: 'correct horse',
        apiKey: 'provider-key',
      });
      expect(requests()).toStrictEqual([
        {
          path: '/centraid/_vault/vaults:restore',
          method: 'POST',
          body: {
            ticket: 'scanned-ticket',
            kit: { format: 'centraid-recovery-kit/2' },
            password: 'correct horse',
            apiKey: 'provider-key',
          },
        },
      ]);
    });

    it('sends the reselected wrapped kit and explicit loss consent for verification', async () => {
      await verifyGatewayFoundingKit({
        kit: { wrapped: 'ciphertext' },
        password: 'correct horse',
        lossConsent: true,
      });
      expect(requests()).toStrictEqual([
        {
          path: '/centraid/_vault/vaults:initialize/verify',
          method: 'POST',
          body: {
            kit: { wrapped: 'ciphertext' },
            password: 'correct horse',
            lossConsent: true,
          },
        },
      ]);
    });
  });
});
