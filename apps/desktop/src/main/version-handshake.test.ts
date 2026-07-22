import { expect, test } from 'vitest';
import {
  EXPECTED_GATEWAY_VERSION,
  EXPECTED_PROTOCOL_VERSION,
  EXPECTED_SCHEMA_EPOCH,
  handshakeGateway,
  judgeGatewayInfo,
} from './version-handshake.js';

test('judgeGatewayInfo: protocol match allows product skew', () => {
  const ok = judgeGatewayInfo({
    version: EXPECTED_GATEWAY_VERSION,
    schemaEpoch: EXPECTED_SCHEMA_EPOCH,
  });
  expect(ok.ok).toBe(true);

  const productSkew = judgeGatewayInfo({
    version: '9.9.9',
    schemaEpoch: EXPECTED_SCHEMA_EPOCH,
  });
  expect(productSkew.ok).toBe(true);

  const badProtocol = judgeGatewayInfo({
    version: EXPECTED_GATEWAY_VERSION,
    schemaEpoch: EXPECTED_SCHEMA_EPOCH + 1,
  });
  expect(badProtocol).toMatchObject({ ok: false, reason: 'protocol_mismatch' });
});

test('judgeGatewayInfo: malformed payloads are rejected, not guessed', () => {
  expect(judgeGatewayInfo(null)).toMatchObject({ ok: false, reason: 'malformed' });
  expect(judgeGatewayInfo({ version: '0.1.0' })).toMatchObject({ ok: false, reason: 'malformed' });
  expect(judgeGatewayInfo({ schemaEpoch: 1 })).toMatchObject({ ok: false, reason: 'malformed' });
});

test('handshakeGateway: network failure → unreachable; 200 payload is judged', async () => {
  const unreachable = await handshakeGateway('http://127.0.0.1:1', undefined, () => {
    throw new Error('ECONNREFUSED');
  });
  expect(unreachable).toMatchObject({ ok: false, reason: 'unreachable' });

  const good = await handshakeGateway(
    'http://gw',
    'tok',
    async () =>
      new Response(
        JSON.stringify({
          version: EXPECTED_GATEWAY_VERSION,
          protocolVersion: EXPECTED_PROTOCOL_VERSION,
          schemaEpoch: EXPECTED_SCHEMA_EPOCH,
        }),
        { status: 200 },
      ),
  );
  expect(good.ok).toBe(true);

  const notOk = await handshakeGateway(
    'http://gw',
    undefined,
    async () =>
      new Response('', {
        status: 503,
      }),
  );
  expect(notOk).toMatchObject({ ok: false, reason: 'unreachable' });
});
