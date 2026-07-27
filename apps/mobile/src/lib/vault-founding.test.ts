import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initializeMobileVault,
  prepareMobileFounding,
  rememberInitializedVault,
  restoreMobileVaults,
  verifyMobileFoundingKit,
} from './vault-founding';

const tunnel = vi.hoisted(() => ({
  generateSecretKey: vi.fn(),
  isTunnelAvailable: vi.fn(),
  startTunnel: vi.fn(),
  stopTunnel: vi.fn(),
}));
const secure = vi.hoisted(() => ({
  value: '',
  setSecure: vi.fn(),
}));
const spaces = vi.hoisted(() => ({
  addSpace: vi.fn(),
}));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('../../modules/centraid-tunnel', () => tunnel);
vi.mock('./secure-storage', () => ({
  getSecure: () => secure.value,
  setSecure: secure.setSecure,
}));
vi.mock('./spaces', () => ({
  LINK_SECRET_KEY: 'phoneLink.secretKey',
  addSpace: spaces.addSpace,
}));
vi.mock('./phone-link', () => ({ hydratePhoneLink: vi.fn() }));
vi.stubGlobal('fetch', fetchMock);

function ticket(over: Partial<{ gw: string; t: string; s: string; exp: number }> = {}): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      kind: 'centraid-gw-found',
      gw: 'relay-hint-a',
      t: 'one-time-id',
      s: 'one-time-secret',
      exp: Date.now() + 60_000,
      ...over,
    }),
  ).toString('base64url');
}

beforeEach(() => {
  secure.value = '';
  vi.clearAllMocks();
  tunnel.isTunnelAvailable.mockReturnValue(true);
  tunnel.generateSecretKey.mockResolvedValue('device-secret');
  tunnel.stopTunnel.mockResolvedValue(undefined);
  tunnel.startTunnel.mockResolvedValue({ port: 4567 });
  secure.setSecure.mockImplementation(async (_key: string, value: string) => {
    secure.value = value;
  });
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/centraid/_gateway/info')) {
      return Response.json({ status: 'uninitialized', endpointId: 'gateway-endpoint-id' });
    }
    return Response.json({ ok: true });
  });
});

describe('mobile founding journey', () => {
  it('dials with the endpoint hint but persists no one-time capability', async () => {
    const raw = ticket();
    const session = await prepareMobileFounding(raw);
    expect(tunnel.startTunnel).toHaveBeenCalledWith({
      ticket: 'relay-hint-a',
      secretKeyB64: 'device-secret',
    });
    expect(session).toEqual({
      foundingTicket: raw,
      endpointHint: 'relay-hint-a',
      gatewayId: 'gateway-endpoint-id',
      baseUrl: 'http://127.0.0.1:4567',
    });
    expect(secure.setSecure).toHaveBeenCalledWith('phoneLink.secretKey', 'device-secret');
    expect(spaces.addSpace).not.toHaveBeenCalled();
  });

  it('sends create and mandatory verification to the founding routes', async () => {
    const raw = ticket();
    const session = await prepareMobileFounding(raw);
    fetchMock.mockImplementation(async () => Response.json({ ok: true }));
    await initializeMobileVault(session, {
      name: 'Personal',
      password: 'correct horse',
      deviceName: 'iPhone',
    });
    await verifyMobileFoundingKit(session, {
      kit: { wrapped: 'ciphertext' },
      password: 'correct horse',
      lossConsent: true,
    });
    const requests = fetchMock.mock.calls.slice(1).map(([url, init]) => ({
      path: new URL(String(url)).pathname,
      body: JSON.parse(String((init as RequestInit).body)) as unknown,
    }));
    expect(requests).toEqual([
      {
        path: '/centraid/_vault/vaults:initialize',
        body: {
          ticket: raw,
          name: 'Personal',
          password: 'correct horse',
          deviceName: 'iPhone',
          platform: 'ios',
        },
      },
      {
        path: '/centraid/_vault/vaults:initialize/verify',
        body: {
          kit: { wrapped: 'ciphertext' },
          password: 'correct horse',
          lossConsent: true,
        },
      },
    ]);
  });

  it('records EndpointId as identity only after verification completes', async () => {
    const session = await prepareMobileFounding(ticket());
    await rememberInitializedVault(session, {
      vault: { vaultId: 'vault-1', name: 'Personal' },
      enrollment: { enrollmentId: 'enrollment-1' },
      kit: {},
      fingerprint: 'fp',
      recoveryScope: 'future backed-up vaults',
    });
    expect(spaces.addSpace).toHaveBeenCalledWith({
      gatewayId: 'gateway-endpoint-id',
      endpointHint: 'relay-hint-a',
      desktopName: 'Gateway',
      deviceId: 'enrollment-1',
      vaultId: 'vault-1',
      vaultName: 'Personal',
    });
    expect(JSON.stringify(spaces.addSpace.mock.calls)).not.toContain('one-time-secret');
    expect(JSON.stringify(spaces.addSpace.mock.calls)).not.toContain('one-time-id');
  });

  it('restores with the same ticket gate and provider credential outside the kit', async () => {
    const raw = ticket();
    const session = await prepareMobileFounding(raw);
    fetchMock.mockResolvedValue(
      Response.json({
        ok: true,
        reports: [{ vaultId: 'vault-1' }],
        enrollments: [{ vaultId: 'vault-1', enrollmentId: 'enrollment-1' }],
      }),
    );
    await restoreMobileVaults(session, {
      kit: { wrapped: 'ciphertext' },
      password: 'correct horse',
      apiKey: 'provider-key',
      deviceName: 'iPhone',
    });
    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      ticket: raw,
      kit: { wrapped: 'ciphertext' },
      password: 'correct horse',
      apiKey: 'provider-key',
      deviceName: 'iPhone',
      platform: 'ios',
    });
  });

  it('refuses an expired ticket before opening a tunnel', async () => {
    await expect(prepareMobileFounding(ticket({ exp: Date.now() - 1 }))).rejects.toThrow('expired');
    expect(tunnel.startTunnel).not.toHaveBeenCalled();
  });
});
