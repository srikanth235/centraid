import { beforeEach, expect, test, vi } from 'vitest';
import { installWebHost } from './web-host.js';

const pairGatewayOverIroh = vi.hoisted(() => vi.fn());
const purgeIrohDeviceState = vi.hoisted(() => vi.fn());
vi.mock('./iroh-transport.js', () => ({ pairGatewayOverIroh, purgeIrohDeviceState }));

function ticket(): string {
  return btoa(
    JSON.stringify({
      v: 1,
      kind: 'centraid-gw-pair',
      gw: 'endpoint',
      t: 'ticket',
      s: 'secret',
      vaultName: 'Personal',
      exp: Date.now() + 60_000,
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  pairGatewayOverIroh.mockReset();
  installWebHost();
});

test('ticket-only pairing enrolls the stable browser identity over Iroh', async () => {
  pairGatewayOverIroh.mockResolvedValue({
    endpointId: 'browser-endpoint',
    response: {
      ok: true,
      gatewayId: 'gateway-endpoint',
      gatewayName: 'Home gateway',
      vaultId: 'vault-1',
      vaultName: 'Personal',
    },
  });

  await expect(
    window.CentraidApi.redeemGatewayPairing({ ticket: ticket() }),
  ).resolves.toMatchObject({ ok: true, vaultId: 'vault-1', vaultName: 'Personal' });
  expect(pairGatewayOverIroh).toHaveBeenCalledWith({
    endpointTicket: 'endpoint',
    ticketId: 'ticket',
    secret: 'secret',
    deviceName: 'Web browser',
    rememberDevice: false,
  });
  const persisted = JSON.parse(
    sessionStorage.getItem('centraid.web.v1.connection') ?? '{}',
  ) as Record<string, unknown>;
  expect(persisted).toMatchObject({
    baseUrl: '',
    transport: 'iroh',
    endpointTicket: 'endpoint',
    endpointId: 'browser-endpoint',
    gatewayId: 'gateway-endpoint',
    vaultId: 'vault-1',
  });
  expect(JSON.stringify(persisted)).not.toContain('secret');
  await expect(window.CentraidApi.getGatewayAuth()).resolves.toMatchObject({
    gatewayId: 'iroh:gateway-endpoint',
    vaultId: 'vault-1',
  });
});

test('remembered pairing opts the connection into durable browser storage', async () => {
  pairGatewayOverIroh.mockResolvedValue({
    endpointId: 'browser-endpoint',
    response: { ok: true, vaultId: 'vault-1', vaultName: 'Personal' },
  });

  await expect(
    window.CentraidApi.redeemGatewayPairing({ ticket: ticket(), rememberDevice: true }),
  ).resolves.toMatchObject({ ok: true, vaultId: 'vault-1' });
  expect(pairGatewayOverIroh).toHaveBeenCalledWith(
    expect.objectContaining({ rememberDevice: true }),
  );
  expect(localStorage.getItem('centraid.web.v1.connection')).toContain('"rememberDevice":true');
  expect(sessionStorage.getItem('centraid.web.v1.connection')).toBeNull();
});

test('pairing exchanges the device bearer for an HttpOnly control session', async () => {
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          deviceToken: 'transient-device-token',
          vaultId: 'vault-1',
          vaultName: 'Personal',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

  const result = await window.CentraidApi.redeemGatewayPairing({
    ticket: ticket(),
    url: 'http://127.0.0.1:8765',
  });
  expect(result).toMatchObject({ ok: true, vaultId: 'vault-1' });
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    new URL('http://127.0.0.1:8765/centraid/_web/control'),
    expect.objectContaining({
      credentials: 'include',
      headers: { Authorization: 'Bearer transient-device-token' },
    }),
  );
  const persisted = sessionStorage.getItem('centraid.web.v1.connection') ?? '';
  expect(persisted).not.toContain('transient-device-token');
  expect(JSON.parse(persisted)).toMatchObject({ control: true, vaultId: 'vault-1' });
  await expect(window.CentraidApi.getGatewayAuth()).resolves.toMatchObject({
    gatewayId: 'direct:http://127.0.0.1:8765/',
    vaultId: 'vault-1',
  });
});

test('expired pairing tickets fail before any network request', async () => {
  const expired = btoa(
    JSON.stringify({
      v: 1,
      kind: 'centraid-gw-pair',
      gw: 'endpoint',
      t: 'ticket',
      s: 'secret',
      vaultName: 'Personal',
      exp: Date.now() - 1,
    }),
  );
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  await expect(
    window.CentraidApi.redeemGatewayPairing({
      ticket: expired,
      url: 'http://127.0.0.1:8765',
    }),
  ).resolves.toMatchObject({ ok: false, error: 'ticket_expired' });
  expect(fetchMock).not.toHaveBeenCalled();
});

test('vault previews use the canonical gateway vault-list route', async () => {
  localStorage.setItem(
    'centraid.web.v1.connection',
    JSON.stringify({
      baseUrl: 'https://gateway.example',
      label: 'Gateway',
      rememberDevice: true,
    }),
  );
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ vaults: [{ vaultId: 'v1', name: 'Personal' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(window.CentraidApi.listGatewayVaults({ gatewayId: 'web' })).resolves.toEqual({
    ok: true,
    vaults: [{ vaultId: 'v1', name: 'Personal' }],
  });
  expect(fetchMock).toHaveBeenCalledWith(
    new URL('https://gateway.example/centraid/_vault/vaults'),
    expect.any(Object),
  );
});

test('connection replacement and consent downgrade publish targeted replica purge hints', async () => {
  const changed = vi.fn();
  const off = window.CentraidApi.onGatewayChanged(changed);
  await window.CentraidApi.addGateway({
    label: 'First',
    url: 'https://one.example/',
    token: 'one',
    rememberDevice: true,
  });
  await window.CentraidApi.addGateway({
    label: 'Second',
    url: 'https://two.example',
    token: 'two',
    rememberDevice: false,
  });
  off();

  expect(changed).toHaveBeenLastCalledWith({
    activeGatewayId: 'web',
    gatewayId: 'direct:https://two.example/',
    removedGatewayId: 'direct:https://one.example/',
    purgeReplicaGatewayId: 'direct:https://two.example/',
  });
});

test('removing a remembered gateway clears durable consent and device state', async () => {
  localStorage.setItem(
    'centraid.web.v1.connection',
    JSON.stringify({
      baseUrl: 'https://gateway.example',
      label: 'Gateway',
      displayName: 'Gateway',
      avatarColor: '#123456',
      rememberDevice: true,
    }),
  );
  const changed = vi.fn();
  const off = window.CentraidApi.onGatewayChanged(changed);

  await window.CentraidApi.removeGateway({ id: 'web' });
  off();

  expect(purgeIrohDeviceState).toHaveBeenCalledOnce();
  expect(localStorage.getItem('centraid.web.v1.connection')).toBeNull();
  expect(JSON.parse(sessionStorage.getItem('centraid.web.v1.connection') ?? '{}')).toMatchObject({
    baseUrl: '',
    rememberDevice: false,
  });
  expect(changed).toHaveBeenLastCalledWith({
    activeGatewayId: 'web',
    removedGatewayId: 'direct:https://gateway.example/',
  });
});
