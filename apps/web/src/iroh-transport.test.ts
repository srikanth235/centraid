/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const wasm = vi.hoisted(() => {
  const connectFailureMarker = 'IROH_CONNECT_FAILURE';
  class BrowserEndpoint {
    static spawn = vi.fn(async (_key?: Uint8Array, _relays?: string[]) => new BrowserEndpoint());
    secret_key = vi.fn(() => new Uint8Array([1, 2, 3]));
    endpoint_id = vi.fn(() => 'endpoint-web-1');
    pair_gateway = vi.fn(async () =>
      JSON.stringify({
        ok: true,
        gatewayId: 'gw-1',
        vaultId: 'vault-1',
        vaultName: 'Personal',
      }),
    );
    request = vi.fn();
    close = vi.fn(async () => undefined);
  }
  return {
    connectFailureMarker,
    BrowserEndpoint,
    initWasm: vi.fn(async () => undefined),
    connect_failure_marker: () => connectFailureMarker,
  };
});

vi.mock('./generated/centraid_web_iroh.js', () => ({
  default: wasm.initWasm,
  BrowserEndpoint: wasm.BrowserEndpoint,
  connect_failure_marker: wasm.connect_failure_marker,
}));

vi.mock('./web-state.js', () => ({
  loadConnection: vi.fn(() => ({
    endpointTicket: 'ticket-abc',
    endpointId: 'gw-1',
    vaultId: 'vault-1',
    label: 'Web',
    displayName: 'Web',
    avatarColor: '#6f5bf6',
    rememberDevice: true,
  })),
  webGatewayId: vi.fn(() => 'gw-1'),
}));

import {
  irohBridgeIdForConsent,
  irohFetch,
  moveIrohDeviceKeyForConsent,
  pairGatewayOverIroh,
  purgeIrohDeviceState,
} from './iroh-transport.js';
import { loadConnection } from './web-state.js';

const DEVICE_KEY = 'centraid.web.v1.iroh-device-key';
const BRIDGE_KEY = 'centraid.web.v1.iroh-bridge';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  // Drop the memoized endpoint promise between tests.
  purgeIrohDeviceState();
  wasm.BrowserEndpoint.spawn.mockImplementation(async () => new wasm.BrowserEndpoint());
  (loadConnection as ReturnType<typeof vi.fn>).mockReturnValue({
    endpointTicket: 'ticket-abc',
    endpointId: 'gw-1',
    vaultId: 'vault-1',
    label: 'Web',
    displayName: 'Web',
    avatarColor: '#6f5bf6',
    rememberDevice: true,
  });
});

describe('Iroh remember-device boundaries', () => {
  test('moves one stable device key between session and durable storage', () => {
    sessionStorage.setItem(DEVICE_KEY, 'stable-key');
    expect(moveIrohDeviceKeyForConsent(true)).toBe('stable-key');
    expect(localStorage.getItem(DEVICE_KEY)).toBe('stable-key');
    expect(sessionStorage.getItem(DEVICE_KEY)).toBeNull();

    expect(moveIrohDeviceKeyForConsent(false)).toBe('stable-key');
    expect(sessionStorage.getItem(DEVICE_KEY)).toBe('stable-key');
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
  });

  test('marks only remembered bridge scopes as durable-cache eligible', () => {
    const scope = '00000000-0000-4000-8000-000000000001';
    expect(irohBridgeIdForConsent(true, scope)).toBe(`d-${scope}`);
    expect(irohBridgeIdForConsent(false, scope)).toBe(`e-${scope}`);
  });
});

describe('pairGatewayOverIroh', () => {
  test('spawns an endpoint, pairs, and returns gateway identity', async () => {
    const result = await pairGatewayOverIroh({
      endpointTicket: 'ticket-abc',
      ticketId: 't1',
      secret: 's1',
      deviceName: 'Browser',
      rememberDevice: true,
    });
    expect(result.endpointId).toBe('endpoint-web-1');
    expect(result.response).toMatchObject({ ok: true, gatewayId: 'gw-1', vaultId: 'vault-1' });
    expect(wasm.BrowserEndpoint.spawn).toHaveBeenCalledTimes(1);
    // encodeBytes([1,2,3]) is deterministic base64 'AQID'.
    expect(localStorage.getItem(DEVICE_KEY)).toBe('AQID');
  });

  test('propagates WASM spawn failures and clears the memoized endpoint', async () => {
    wasm.BrowserEndpoint.spawn.mockRejectedValueOnce(new Error('wasm init failed'));
    await expect(
      pairGatewayOverIroh({
        endpointTicket: 'ticket-abc',
        ticketId: 't1',
        secret: 's1',
        deviceName: 'Browser',
        rememberDevice: false,
      }),
    ).rejects.toThrow('wasm init failed');
    // A subsequent call must re-spawn rather than reuse the failed promise.
    wasm.BrowserEndpoint.spawn.mockImplementation(async () => new wasm.BrowserEndpoint());
    await expect(
      pairGatewayOverIroh({
        endpointTicket: 'ticket-abc',
        ticketId: 't1',
        secret: 's1',
        deviceName: 'Browser',
        rememberDevice: false,
      }),
    ).resolves.toMatchObject({ endpointId: 'endpoint-web-1' });
  });
});

describe('irohFetch', () => {
  test('throws when no iroh connection is configured', async () => {
    (loadConnection as ReturnType<typeof vi.fn>).mockReturnValue({
      label: 'Web',
      displayName: 'Web',
      avatarColor: '#6f5bf6',
    });
    await expect(irohFetch('/centraid/_gateway/health')).rejects.toThrow(
      'No Iroh gateway is connected.',
    );
  });

  test('returns a Response from a successful stream and retries connect failures on GET', async () => {
    const node = new wasm.BrowserEndpoint();
    let attempts = 0;
    node.request = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error(`dial ${wasm.connectFailureMarker}`);
      return {
        status: 200,
        headers_json: JSON.stringify({ 'content-type': 'application/json' }),
        take_body: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":true}'));
              controller.close();
            },
          }),
      };
    });
    wasm.BrowserEndpoint.spawn.mockResolvedValueOnce(node);

    const response = await irohFetch('/centraid/_gateway/health', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(attempts).toBe(2);
  });

  test('does not retry non-idempotent failures that are not connect failures', async () => {
    const node = new wasm.BrowserEndpoint();
    node.request = vi.fn(async () => {
      throw new Error('stream reset mid-body');
    });
    wasm.BrowserEndpoint.spawn.mockResolvedValueOnce(node);

    await expect(irohFetch('/centraid/_apps', { method: 'POST', body: '{}' })).rejects.toThrow(
      'stream reset mid-body',
    );
    expect(node.request).toHaveBeenCalledTimes(1);
  });
});

describe('purgeIrohDeviceState', () => {
  test('clears device key + bridge scope from both storage buckets', () => {
    localStorage.setItem(DEVICE_KEY, 'k');
    localStorage.setItem(BRIDGE_KEY, '{"id":"d-1"}');
    sessionStorage.setItem(DEVICE_KEY, 'k2');
    sessionStorage.setItem(BRIDGE_KEY, '{"id":"e-1"}');
    purgeIrohDeviceState();
    expect(localStorage.getItem(DEVICE_KEY)).toBeNull();
    expect(localStorage.getItem(BRIDGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(DEVICE_KEY)).toBeNull();
    expect(sessionStorage.getItem(BRIDGE_KEY)).toBeNull();
  });
});
