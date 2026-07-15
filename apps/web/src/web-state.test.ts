import { describe, expect, test } from 'vitest';

import { webGatewayId, type WebConnection } from './web-state.js';

const base: WebConnection = {
  baseUrl: '',
  label: 'Gateway',
  displayName: 'Gateway',
  avatarColor: '#123456',
};

describe('web gateway identity', () => {
  test('uses the sovereign Iroh endpoint ticket instead of a loopback transport URL', () => {
    expect(
      webGatewayId({
        ...base,
        transport: 'iroh',
        endpointTicket: 'endpoint-ticket',
        gatewayId: 'gateway-endpoint',
      }),
    ).toBe('iroh:gateway-endpoint');
  });

  test('falls back to the Iroh ticket before a server EndpointId is known', () => {
    expect(
      webGatewayId({
        ...base,
        transport: 'iroh',
        endpointTicket: 'endpoint-ticket',
      }),
    ).toBe('iroh:endpoint-ticket');
  });

  test('normalizes a direct gateway URL', () => {
    expect(
      webGatewayId({
        ...base,
        transport: 'direct',
        baseUrl: 'https://EXAMPLE.test/root/?temporary=1#fragment',
      }),
    ).toBe('direct:https://example.test/root');
  });
});
