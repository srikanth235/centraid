import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCompanionRequest } from './companion-api.js';

const state = vi.hoisted(() => ({ paired: true }));
const transport = vi.hoisted(() => ({
  closeTransport: vi.fn<typeof import('./transport.js').closeTransport>(),
  // `companionJson` is generic (`<T>(...) => Promise<T>`); a typed mock erases the
  // type parameter, so `Mock<...>` stops being assignable to the export.
  // Bare `vi.fn()` is the only form that satisfies a generic signature.
  companionJson: vi.fn(),
}));
const storage = vi.hoisted(() => ({
  purgeCompanionState: vi.fn<typeof import('./storage.js').purgeCompanionState>(),
}));

vi.mock(import('./transport.js'), () => ({
  ...transport,
  // `appRead` is generic (`<T>(...) => Promise<T>`); a typed mock erases the
  // type parameter, so `Mock<...>` stops being assignable to the export.
  // Bare `vi.fn()` is the only form that satisfies a generic signature.
  appRead: vi.fn(),
  // `appWrite` is generic (`<T>(...) => Promise<T>`); a typed mock erases the
  // type parameter, so `Mock<...>` stops being assignable to the export.
  // Bare `vi.fn()` is the only form that satisfies a generic signature.
  appWrite: vi.fn(),
  pairOverIroh: vi.fn<typeof import('./transport.js').pairOverIroh>(),
}));
vi.mock(import('./storage.js'), () => ({
  ...storage,
  isLocked: vi.fn<typeof import('./storage.js').isLocked>(async () => false),
  loadPairing: vi.fn<typeof import('./storage.js').loadPairing>(async () =>
    state.paired
      ? {
          endpointTicket: 'ticket',
          endpointId: 'endpoint-1',
          enrollmentId: 'enrollment-1',
          vaultId: 'vault-1',
          pairedAt: '2026-07-19T00:00:00.000Z',
          grantProfile: ['locker'] as const,
        }
      : undefined,
  ),
  savePairing: vi.fn<typeof import('./storage.js').savePairing>(),
  setLocked: vi.fn<typeof import('./storage.js').setLocked>(),
}));

describe('Companion unpair', () => {
  beforeEach(() => {
    state.paired = true;
    vi.clearAllMocks();
  });

  it('revokes the exact server enrollment before deleting local identity', async () => {
    transport.companionJson.mockResolvedValueOnce({ removed: true });
    await expect(handleCompanionRequest({ type: 'unpair' }, {})).resolves.toStrictEqual({
      ok: true,
    });
    expect(transport.companionJson).toHaveBeenCalledWith(
      '/centraid/_gateway/devices/enrollment-1', // ROUTES.gatewayDevices + id
      { method: 'DELETE' },
    );
    expect(transport.closeTransport).toHaveBeenCalledOnce();
    expect(storage.purgeCompanionState).toHaveBeenCalledOnce();
  });

  it('retains the retry credential when server revocation fails offline', async () => {
    transport.companionJson.mockRejectedValueOnce(new Error('offline'));
    await expect(handleCompanionRequest({ type: 'unpair' }, {})).rejects.toThrow('offline');
    expect(storage.purgeCompanionState).not.toHaveBeenCalled();
    expect(state.paired).toBe(true);
  });

  it('accepts a lost success response when revocation handling already purged state', async () => {
    transport.companionJson.mockImplementationOnce(async () => {
      state.paired = false;
      throw new Error('revoked');
    });
    await expect(handleCompanionRequest({ type: 'unpair' }, {})).resolves.toStrictEqual({
      ok: true,
    });
  });
});
