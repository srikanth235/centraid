import { expect, test } from 'vitest';
import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SCHEMA_EPOCH,
  GATEWAY_VERSION,
  judgeGatewayInfo,
  buildGatewayInfoPayload,
  protocolsCompatible,
  ROUTES,
} from './index.ts';

test('version constants: product string + protocol ints', () => {
  expect(GATEWAY_VERSION).toBe('0.1.0');
  expect(GATEWAY_PROTOCOL_VERSION).toBe(2);
  expect(GATEWAY_MIN_PROTOCOL_VERSION).toBe(2);
  expect(GATEWAY_SCHEMA_EPOCH).toBe(2);
  expect(GATEWAY_SCHEMA_EPOCH).toBe(GATEWAY_PROTOCOL_VERSION);
});

test('protocolsCompatible enforces mutual support window', () => {
  expect(
    protocolsCompatible({
      localProtocol: 2,
      localMin: 2,
      peerProtocol: 2,
      peerMin: 2,
    }),
  ).toBe(true);
  // peer too old for local min
  expect(
    protocolsCompatible({
      localProtocol: 3,
      localMin: 3,
      peerProtocol: 2,
      peerMin: 2,
    }),
  ).toBe(false);
  // local too old for peer min
  expect(
    protocolsCompatible({
      localProtocol: 2,
      localMin: 2,
      peerProtocol: 3,
      peerMin: 3,
    }),
  ).toBe(false);
  // peer newer but still supports our protocol
  expect(
    protocolsCompatible({
      localProtocol: 2,
      localMin: 2,
      peerProtocol: 5,
      peerMin: 2,
    }),
  ).toBe(true);
});

test('judgeGatewayInfo: product version skew is allowed when protocol matches', () => {
  const ok = judgeGatewayInfo({
    version: '9.9.9',
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
  });
  expect(ok.ok).toBe(true);
  if (!ok.ok) return;
  expect(ok.info.version).toBe('9.9.9');
  expect(ok.info.protocolVersion).toBe(GATEWAY_PROTOCOL_VERSION);
  expect(ok.info.capabilities?.webSessions).toBe(true);
});

test('judgeGatewayInfo: schemaEpoch fallback when protocolVersion omitted', () => {
  const ok = judgeGatewayInfo({
    version: '0.0.1',
    schemaEpoch: GATEWAY_PROTOCOL_VERSION,
  });
  expect(ok.ok).toBe(true);
});

test('judgeGatewayInfo: protocol mismatch refused (not product)', () => {
  const bad = judgeGatewayInfo({
    version: GATEWAY_VERSION,
    protocolVersion: 99,
    minSupportedProtocol: 99,
  });
  expect(bad).toMatchObject({ ok: false, reason: 'protocol_mismatch' });
  expect(judgeGatewayInfo(null)).toMatchObject({ ok: false, reason: 'malformed' });
});

test('buildGatewayInfoPayload ships product + protocol fields', () => {
  const payload = buildGatewayInfoPayload({
    instanceId: 'i1',
    startedAt: 1,
    uptimeMs: 2,
  });
  expect(payload.version).toBe(GATEWAY_VERSION);
  expect(payload.protocolVersion).toBe(GATEWAY_PROTOCOL_VERSION);
  expect(payload.minSupportedProtocol).toBe(GATEWAY_MIN_PROTOCOL_VERSION);
  expect(payload.schemaEpoch).toBe(GATEWAY_SCHEMA_EPOCH);
  expect(payload.capabilities?.devicePairing).toBe(true);
  expect(ROUTES.gatewayInfo).toBe('/centraid/_gateway/info');
});
