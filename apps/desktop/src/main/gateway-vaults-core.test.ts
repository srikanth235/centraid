import { describe, expect, it } from 'vitest';
import { fetchGatewayVaults, foldVaultsResponse } from './gateway-vaults-core.js';

describe('foldVaultsResponse', () => {
  it('folds a well-formed 200 response', () => {
    const result = foldVaultsResponse(200, {
      vaults: [
        { vaultId: 'v1', name: 'Personal', ownerPartyId: 'p1', color: '#5B8DEF' },
        { vaultId: 'v2', name: 'Work' },
      ],
    });
    expect(result).toEqual({
      ok: true,
      vaults: [
        { vaultId: 'v1', name: 'Personal', ownerPartyId: 'p1', color: '#5B8DEF' },
        { vaultId: 'v2', name: 'Work' },
      ],
    });
  });

  it('drops malformed entries but keeps the well-formed ones', () => {
    const result = foldVaultsResponse(200, {
      vaults: [{ vaultId: 'v1', name: 'Personal' }, { vaultId: 'v2' }, null, 'not an object', 42],
    });
    expect(result).toEqual({ ok: true, vaults: [{ vaultId: 'v1', name: 'Personal' }] });
  });

  it('returns an empty list, not an error, for an empty vaults array', () => {
    expect(foldVaultsResponse(200, { vaults: [] })).toEqual({ ok: true, vaults: [] });
  });

  it('maps 401 and 403 to auth_failed', () => {
    expect(foldVaultsResponse(401, {})).toEqual({ ok: false, error: 'auth_failed' });
    expect(foldVaultsResponse(403, {})).toEqual({ ok: false, error: 'auth_failed' });
  });

  it('maps any other non-200 status to unreachable', () => {
    expect(foldVaultsResponse(500, {})).toEqual({ ok: false, error: 'unreachable' });
    expect(foldVaultsResponse(404, {})).toEqual({ ok: false, error: 'unreachable' });
  });

  it('treats a non-object body as bad_response', () => {
    expect(foldVaultsResponse(200, null)).toEqual({ ok: false, error: 'bad_response' });
    expect(foldVaultsResponse(200, 'oops')).toEqual({ ok: false, error: 'bad_response' });
  });

  it('treats a missing/non-array vaults field as bad_response', () => {
    expect(foldVaultsResponse(200, {})).toEqual({ ok: false, error: 'bad_response' });
    expect(foldVaultsResponse(200, { vaults: 'nope' })).toEqual({
      ok: false,
      error: 'bad_response',
    });
  });
});

describe('fetchGatewayVaults', () => {
  it('sends the bearer token and folds a successful response', async () => {
    let seenHeaders: Record<string, string> | undefined;
    const result = await fetchGatewayVaults('http://127.0.0.1:4000', 'tok', async (_url, init) => {
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ vaults: [{ vaultId: 'v1', name: 'Personal' }] }), {
        status: 200,
      });
    });
    expect(result).toEqual({ ok: true, vaults: [{ vaultId: 'v1', name: 'Personal' }] });
    expect(seenHeaders?.Authorization).toBe('Bearer tok');
  });

  it('omits the Authorization header when no token is given', async () => {
    let seenHeaders: Record<string, string> | undefined;
    await fetchGatewayVaults('http://127.0.0.1:4000', undefined, async (_url, init) => {
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ vaults: [] }), { status: 200 });
    });
    expect(seenHeaders?.Authorization).toBeUndefined();
  });

  it('surfaces a network failure as unreachable', async () => {
    const result = await fetchGatewayVaults('http://127.0.0.1:4000', 'tok', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(result).toEqual({ ok: false, error: 'unreachable' });
  });

  it('surfaces a 401 as auth_failed', async () => {
    const result = await fetchGatewayVaults(
      'http://127.0.0.1:4000',
      'tok',
      async () => new Response('', { status: 401 }),
    );
    expect(result).toEqual({ ok: false, error: 'auth_failed' });
  });

  it('surfaces a non-JSON body as bad_response, not a thrown error', async () => {
    const result = await fetchGatewayVaults(
      'http://127.0.0.1:4000',
      'tok',
      async () => new Response('not json', { status: 200 }),
    );
    expect(result).toEqual({ ok: false, error: 'bad_response' });
  });
});
