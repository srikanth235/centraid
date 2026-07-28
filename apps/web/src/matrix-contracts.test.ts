/**
 * Matrix cell web.contracts (#535): EndpointId is the sole gateway identity.
 */
import { describe, expect, test } from 'vitest';

import { webGatewayId, type WebConnection } from './web-state.js';

const base: WebConnection = {
  label: 'Gateway',
  displayName: 'Gateway',
  avatarColor: '#123456',
};

describe('webGatewayId contract', () => {
  test('uses the sovereign EndpointId', () => {
    expect(webGatewayId({ ...base, endpointId: 'gw-1', endpointTicket: 'ticket-a' })).toBe('gw-1');
  });

  test('a relay-bearing ticket is never identity', () => {
    expect(webGatewayId({ ...base, endpointTicket: 'ticket-a' })).toBeUndefined();
  });
});
