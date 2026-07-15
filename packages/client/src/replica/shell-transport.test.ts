import { describe, expect, it, vi } from 'vitest';
import { ReplicaRebootstrapRequiredError } from './errors.js';
import { fetchReplicaChanges, fetchReplicaIntentOutcomes } from './shell-transport.js';

vi.mock('../gateway-client-core.js', () => ({
  authHeaders: (token?: string) => (token ? { Authorization: `Bearer ${token}` } : {}),
  doFetch: vi.fn(),
  GatewayClientError: class GatewayClientError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'GatewayClientError';
    }
  },
}));

const gatewayAuth = {
  baseUrl: 'https://gateway.test',
  token: 'secret',
  vaultId: 'vault-a',
};

describe('fetchReplicaChanges', () => {
  it('attests the sorted, deduplicated persisted shape ids on every pull', async () => {
    const fetcher = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            schemaEpoch: '1',
            from: { epoch: 'epoch-a', seq: 4 },
            to: { epoch: 'epoch-a', seq: 5 },
            changes: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await fetchReplicaChanges(
      gatewayAuth,
      { epoch: 'epoch-a', seq: 4 },
      new AbortController().signal,
      ['shape-z', 'shape-a', 'shape-z'],
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toBe(
      '/centraid/_vault/changes?since=epoch-a%3A4&shapeIds=shape-a%2Cshape-z',
    );

    await fetchReplicaChanges(
      gatewayAuth,
      { epoch: 'epoch-a', seq: 5 },
      new AbortController().signal,
      [],
      fetcher,
    );
    expect(fetcher.mock.calls[1]?.[1]).toBe('/centraid/_vault/changes?since=epoch-a%3A5&shapeIds=');
  });

  it('turns a stale shape attestation conflict into a typed rebootstrap', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'replica_rebootstrap_required', reason: 'shape-changed' }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      );

    await expect(
      fetchReplicaChanges(
        gatewayAuth,
        { epoch: 'epoch-a', seq: 4 },
        new AbortController().signal,
        ['shape-stale'],
        fetcher,
      ),
    ).rejects.toBeInstanceOf(ReplicaRebootstrapRequiredError);
  });
});

describe('fetchReplicaIntentOutcomes', () => {
  it('batches exact pending ids behind the bootstrap watermark', async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `intent-${index}`);
    const through = { epoch: 'epoch-a', seq: 42 };
    const fetcher = vi.fn().mockImplementation(async (_baseUrl, pathname, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        intentIds: string[];
        through: { epoch: string; seq: number };
      };
      expect(pathname).toBe('/centraid/_vault/replica/outcomes');
      expect(body.through).toEqual(through);
      return new Response(
        JSON.stringify({
          outcomes: body.intentIds.map((intentId) => ({ intentId, status: 'executed' })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const outcomes = await fetchReplicaIntentOutcomes(
      gatewayAuth,
      [...ids, ids[0]!],
      through,
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(outcomes).toHaveLength(501);
    expect(outcomes.at(-1)).toEqual({ intentId: 'intent-500', status: 'executed' });
  });
});
