/**
 * Direct imports of handshake.ts (issue #545 B9) — branch depth beyond the barrel.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SCHEMA_EPOCH,
  GATEWAY_VERSION,
} from './version.js';
import {
  buildGatewayInfoPayload,
  handshakeGateway,
  judgeGatewayInfo,
  protocolsCompatible,
  readProtocolFromInfo,
} from './handshake.js';
import { ROUTES } from './routes.js';

describe('readProtocolFromInfo', () => {
  it('prefers protocolVersion and falls back to schemaEpoch / peer=min', () => {
    expect(readProtocolFromInfo({ protocolVersion: 2, minSupportedProtocol: 1 })).toEqual({
      protocolVersion: 2,
      minSupportedProtocol: 1,
    });
    expect(readProtocolFromInfo({ schemaEpoch: 2 })).toEqual({
      protocolVersion: 2,
      minSupportedProtocol: 2,
    });
    expect(readProtocolFromInfo({})).toEqual({
      protocolVersion: null,
      minSupportedProtocol: null,
    });
    expect(readProtocolFromInfo({ protocolVersion: 2.5 })).toEqual({
      protocolVersion: null,
      minSupportedProtocol: null,
    });
  });
});

describe('judgeGatewayInfo branches', () => {
  it('malformed: non-object, missing version, missing protocol', () => {
    expect(judgeGatewayInfo(null)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(judgeGatewayInfo([])).toMatchObject({ ok: false, reason: 'malformed' });
    expect(judgeGatewayInfo({ protocolVersion: 2 })).toMatchObject({
      ok: false,
      reason: 'malformed',
      detail: expect.stringMatching(/version/),
    });
    expect(judgeGatewayInfo({ version: '1.0.0' })).toMatchObject({
      ok: false,
      reason: 'malformed',
      detail: expect.stringMatching(/protocolVersion/),
    });
  });

  it('fills default capabilities when wire map is absent or invalid', () => {
    const ok = judgeGatewayInfo({
      version: '0.1.0',
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
      capabilities: { webSessions: 'yes' },
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.info.capabilities?.webSessions).toBe(true);
    expect(ok.info.capabilities?.assistOAuth).toBe(false);
  });

  it('carries optional instanceId / clocks when present', () => {
    const ok = judgeGatewayInfo({
      version: '0.1.0',
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
      instanceId: 'i1',
      startedAt: 10,
      uptimeMs: 20,
      schemaEpoch: GATEWAY_SCHEMA_EPOCH,
    });
    expect(ok).toMatchObject({
      ok: true,
      info: { instanceId: 'i1', startedAt: 10, uptimeMs: 20 },
    });
  });

  it('protocolsCompatible is mutual (both sides must support the other)', () => {
    expect(
      protocolsCompatible({
        localProtocol: 3,
        localMin: 2,
        peerProtocol: 2,
        peerMin: 2,
      }),
    ).toBe(true);
    expect(
      protocolsCompatible({
        localProtocol: 2,
        localMin: 2,
        peerProtocol: 3,
        peerMin: 3,
      }),
    ).toBe(false);
  });
});

describe('handshakeGateway network branches', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unreachable on fetch throw and non-2xx', async () => {
    const fetchThrow = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(handshakeGateway('http://127.0.0.1:9', 't', fetchThrow as never)).resolves.toEqual(
      {
        ok: false,
        reason: 'unreachable',
        detail: 'ECONNREFUSED',
      },
    );

    const fetch404 = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    await expect(handshakeGateway('http://x', undefined, fetch404 as never)).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
      detail: 'HTTP 404',
    });
  });

  it('malformed when body is not JSON; ok when body is a valid info payload', async () => {
    const badJson = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('nope');
      },
    }));
    await expect(handshakeGateway('http://x', 'tok', badJson as never)).resolves.toMatchObject({
      ok: false,
      reason: 'malformed',
    });

    const good = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toContain(ROUTES.gatewayInfo);
      expect(init?.headers?.Authorization).toBe('Bearer tok');
      return {
        ok: true,
        status: 200,
        json: async () =>
          buildGatewayInfoPayload({
            instanceId: 'i',
            startedAt: 1,
            uptimeMs: 2,
            authenticated: true,
          }),
      };
    });
    const result = await handshakeGateway('http://gw', 'tok', good as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.version).toBe(GATEWAY_VERSION);
    expect(result.info.protocolVersion).toBe(GATEWAY_PROTOCOL_VERSION);
  });
});
