/**
 * Matrix cell web.contracts (#535 coverable-today).
 * webGatewayId is the stable identity contract for replica keying.
 */
import { describe, expect, test } from 'vitest';
import { webGatewayId, type WebConnection } from './web-state.js';

const base: WebConnection = {
  baseUrl: '',
  label: 'Gateway',
  displayName: 'Gateway',
  avatarColor: '#123456',
};

describe('webGatewayId contract', () => {
  test('direct ids strip query/hash and trailing slash', () => {
    expect(
      webGatewayId({
        ...base,
        transport: 'direct',
        baseUrl: 'https://EXAMPLE.test/root/?temporary=1#fragment',
      }),
    ).toBe('direct:https://example.test/root');
  });

  test('iroh prefers sovereign gatewayId over endpoint ticket', () => {
    expect(
      webGatewayId({
        ...base,
        transport: 'iroh',
        endpointTicket: 'ticket',
        gatewayId: 'gw-1',
      }),
    ).toBe('iroh:gw-1');
  });

  test('missing baseUrl and non-iroh yields undefined', () => {
    expect(webGatewayId({ ...base, transport: 'direct' })).toBeUndefined();
  });
});
