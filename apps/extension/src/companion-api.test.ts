import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ paired: true }));
const transport = vi.hoisted(() => ({
  closeTransport: vi.fn(),
  companionJson: vi.fn(),
}));
const storage = vi.hoisted(() => ({ purgeCompanionState: vi.fn() }));

vi.mock('./transport.js', () => ({
  ...transport,
  appRead: vi.fn(),
  appWrite: vi.fn(),
  pairOverIroh: vi.fn(),
}));
vi.mock('./storage.js', () => ({
  ...storage,
  isLocked: vi.fn(async () => false),
  loadPairing: vi.fn(async () =>
    state.paired
      ? {
          endpointTicket: 'ticket',
          endpointId: 'endpoint-1',
          enrollmentId: 'enrollment-1',
          vaultId: 'vault-1',
          pairedAt: '2026-07-19T00:00:00.000Z',
          grantProfile: ['locker'],
        }
      : undefined,
  ),
  savePairing: vi.fn(),
  setLocked: vi.fn(),
}));

import { handleCompanionRequest } from './companion-api.js';

describe('Companion unpair', () => {
  beforeEach(() => {
    state.paired = true;
    vi.clearAllMocks();
  });

  it('revokes the exact server enrollment before deleting local identity', async () => {
    transport.companionJson.mockResolvedValueOnce({ removed: true });
    await expect(handleCompanionRequest({ type: 'unpair' }, {})).resolves.toEqual({ ok: true });
    expect(transport.companionJson).toHaveBeenCalledWith(
      '/centraid/_gateway/devices/enrollment-1',
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
    await expect(handleCompanionRequest({ type: 'unpair' }, {})).resolves.toEqual({ ok: true });
  });
});
