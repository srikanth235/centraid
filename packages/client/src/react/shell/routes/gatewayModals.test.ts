import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectGateway, friendlyGatewayError } from './gatewayModals.js';

const redeemGatewayPairing = vi.fn();
const addGateway = vi.fn();
const setActiveGateway = vi.fn(() => Promise.resolve());

beforeEach(() => {
  redeemGatewayPairing.mockReset();
  addGateway.mockReset();
  setActiveGateway.mockClear();
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
    addGateway,
    redeemGatewayPairing,
    setActiveGateway,
  };
});

describe('friendlyGatewayError', () => {
  it('maps known stable codes to friendly copy', () => {
    expect(friendlyGatewayError('ticket_expired', 'raw')).toBe(
      'This ticket has expired — ask for a new one.',
    );
    expect(friendlyGatewayError('unreachable', 'raw')).toMatch(/Couldn't reach/);
  });

  it('falls back to the raw message for an unrecognized code', () => {
    expect(friendlyGatewayError('some_new_code', 'raw server text')).toBe('raw server text');
  });
});

describe('connectGateway', () => {
  it('ticket: redeems with just the ticket + label, mode omitted', async () => {
    redeemGatewayPairing.mockResolvedValue({
      gatewayId: 'gw1',
      ok: true,
      vaultId: 'v1',
      vaultName: 'Home',
    });
    const result = await connectGateway({ kind: 'ticket', label: 'Mine', ticket: 't.icket' });
    expect(redeemGatewayPairing).toHaveBeenCalledWith({ label: 'Mine', ticket: 't.icket' });
    expect(result).toEqual({ gatewayId: 'gw1', label: 'Home', ok: true, vaultId: 'v1' });
  });

  it('ticket: falls back to a generic label when vaultName is empty', async () => {
    redeemGatewayPairing.mockResolvedValue({
      gatewayId: 'gw1',
      ok: true,
      vaultId: 'v1',
      vaultName: '',
    });
    const result = await connectGateway({ kind: 'ticket', ticket: 't' });
    expect(result).toMatchObject({ label: 'your vault', ok: true });
  });

  it('ticket-url: redeems with url + mode:http', async () => {
    redeemGatewayPairing.mockResolvedValue({
      gatewayId: 'gw1',
      ok: true,
      vaultId: 'v1',
      vaultName: 'Office',
    });
    await connectGateway({ kind: 'ticket-url', ticket: 't', url: 'https://gw.example' });
    expect(redeemGatewayPairing).toHaveBeenCalledWith({
      label: undefined,
      mode: 'http',
      ticket: 't',
      url: 'https://gw.example',
    });
  });

  it('ticket flows map a stable error code through friendlyGatewayError', async () => {
    redeemGatewayPairing.mockResolvedValue({
      error: 'ticket_expired',
      message: 'server said expired',
      ok: false,
    });
    const result = await connectGateway({ kind: 'ticket', ticket: 't' });
    expect(result).toEqual({
      message: 'This ticket has expired — ask for a new one.',
      ok: false,
    });
  });

  it('token: adds the gateway then switches active, label from the profile', async () => {
    addGateway.mockResolvedValue({ displayName: 'Landlord box', id: 'gw2', label: 'Landlord box' });
    const result = await connectGateway({
      kind: 'token',
      label: 'Landlord box',
      token: 'sekret',
      url: 'https://landlord.example',
    });
    expect(addGateway).toHaveBeenCalledWith({
      label: 'Landlord box',
      token: 'sekret',
      url: 'https://landlord.example',
    });
    expect(setActiveGateway).toHaveBeenCalledWith({ id: 'gw2' });
    expect(result).toEqual({ gatewayId: 'gw2', label: 'Landlord box', ok: true });
  });

  it('token: a thrown addGateway error becomes ok:false with the error message', async () => {
    addGateway.mockRejectedValue(new Error('Gateway label cannot be empty.'));
    const result = await connectGateway({ kind: 'token', label: '', token: 't', url: 'https://x' });
    expect(setActiveGateway).not.toHaveBeenCalled();
    expect(result).toEqual({ message: 'Gateway label cannot be empty.', ok: false });
  });
});
