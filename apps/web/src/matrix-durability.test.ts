/**
 * Matrix cell web.durability (#535 coverable-today).
 * Identity derivation is pure and stable across equivalent connection shapes.
 */
import { describe, expect, test } from 'vitest';
import { webGatewayId, type WebConnection } from './web-state.js';

const base: WebConnection = {
  baseUrl: 'https://gateway.example/api/',
  label: 'Gateway',
  displayName: 'Gateway',
  avatarColor: '#123456',
  transport: 'direct',
};

describe('webGatewayId durability', () => {
  test('repeated derivation returns the same id', () => {
    const a = webGatewayId(base);
    const b = webGatewayId({ ...base });
    const c = webGatewayId({ ...base, baseUrl: 'https://gateway.example/api' });
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toBe('direct:https://gateway.example/api');
  });

  test('iroh identity survives ticket-only then gatewayId upgrade path', () => {
    const ticketOnly = webGatewayId({
      ...base,
      transport: 'iroh',
      baseUrl: '',
      endpointTicket: 'ticket-1',
    });
    const upgraded = webGatewayId({
      ...base,
      transport: 'iroh',
      baseUrl: '',
      endpointTicket: 'ticket-1',
      gatewayId: 'gw-sovereign',
    });
    expect(ticketOnly).toBe('iroh:ticket-1');
    expect(upgraded).toBe('iroh:gw-sovereign');
  });
});
