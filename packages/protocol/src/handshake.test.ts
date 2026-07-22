import { expect, test } from 'vitest';
import {
  GATEWAY_SCHEMA_EPOCH,
  GATEWAY_VERSION,
  judgeGatewayInfo,
  buildGatewayInfoPayload,
  ROUTES,
} from './index.ts';

test('version constants exist once', () => {
  expect(GATEWAY_VERSION).toBe('0.1.0');
  expect(GATEWAY_SCHEMA_EPOCH).toBe(2);
});

test('judgeGatewayInfo: exact-match passes and fills capabilities', () => {
  const ok = judgeGatewayInfo({
    version: GATEWAY_VERSION,
    schemaEpoch: GATEWAY_SCHEMA_EPOCH,
  });
  expect(ok.ok).toBe(true);
  if (!ok.ok) return;
  expect(ok.info.capabilities?.webSessions).toBe(true);
});

test('judgeGatewayInfo: skew and malformed are refused', () => {
  expect(judgeGatewayInfo({ version: '9.9.9', schemaEpoch: GATEWAY_SCHEMA_EPOCH })).toMatchObject({
    ok: false,
    reason: 'version_mismatch',
  });
  expect(judgeGatewayInfo(null)).toMatchObject({ ok: false, reason: 'malformed' });
});

test('buildGatewayInfoPayload ships capabilities for the info route', () => {
  const payload = buildGatewayInfoPayload({
    instanceId: 'i1',
    startedAt: 1,
    uptimeMs: 2,
  });
  expect(payload.version).toBe(GATEWAY_VERSION);
  expect(payload.capabilities?.devicePairing).toBe(true);
  expect(ROUTES.gatewayInfo).toBe('/centraid/_gateway/info');
});
