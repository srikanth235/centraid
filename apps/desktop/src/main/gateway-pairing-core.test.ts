import { describe, expect, it } from 'vitest';
import {
  decodePairingTicket,
  findReusableProfile,
  foldHttpPairResponse,
  foldIrohPairResponse,
  isFoldError,
  isTicketExpired,
  type PairingTicketPayload,
} from './gateway-pairing-core.js';

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

const validPayload: PairingTicketPayload = {
  v: 1,
  kind: 'centraid-gw-pair',
  gw: 'endpoint-ticket-string',
  t: 'ticket-id',
  s: 'one-time-secret',
  vaultName: 'Personal',
  exp: Date.now() + 60_000,
};

describe('decodePairingTicket', () => {
  it('decodes a well-formed token', () => {
    expect(decodePairingTicket(encode(validPayload))).toEqual(validPayload);
  });

  it('tolerates surrounding whitespace (paste artifact)', () => {
    expect(decodePairingTicket(`  ${encode(validPayload)}\n`)).toEqual(validPayload);
  });

  it('rejects non-base64url garbage', () => {
    expect(decodePairingTicket('not a valid token')).toBeUndefined();
  });

  it('rejects valid base64url that is not JSON', () => {
    expect(decodePairingTicket(Buffer.from('hello', 'utf8').toString('base64url'))).toBeUndefined();
  });

  it('rejects a wrong version', () => {
    expect(decodePairingTicket(encode({ ...validPayload, v: 2 }))).toBeUndefined();
  });

  it('rejects a wrong kind (e.g. the phone-pairing QR shape)', () => {
    expect(
      decodePairingTicket(encode({ v: 1, kind: 'centraid-pair', ticket: 'x', code: 'y' })),
    ).toBeUndefined();
  });

  it.each(['gw', 't', 's'] as const)('rejects a missing/empty %s field', (field) => {
    expect(decodePairingTicket(encode({ ...validPayload, [field]: '' }))).toBeUndefined();
    const rest: Record<string, unknown> = { ...validPayload };
    delete rest[field];
    expect(decodePairingTicket(encode(rest))).toBeUndefined();
  });

  it('rejects a non-numeric exp', () => {
    expect(decodePairingTicket(encode({ ...validPayload, exp: 'soon' }))).toBeUndefined();
  });

  it('accepts an empty vaultName (still a string)', () => {
    expect(decodePairingTicket(encode({ ...validPayload, vaultName: '' }))).toEqual({
      ...validPayload,
      vaultName: '',
    });
  });
});

describe('isTicketExpired', () => {
  it('is false strictly before expiry', () => {
    expect(isTicketExpired({ exp: 1000 }, 999)).toBe(false);
  });

  it('is true at or after expiry (server burns on ANY redemption attempt)', () => {
    expect(isTicketExpired({ exp: 1000 }, 1000)).toBe(true);
    expect(isTicketExpired({ exp: 1000 }, 1001)).toBe(true);
  });

  it('defaults `now` to the current clock', () => {
    expect(isTicketExpired({ exp: Date.now() + 60_000 })).toBe(false);
    expect(isTicketExpired({ exp: Date.now() - 1 })).toBe(true);
  });
});

describe('foldIrohPairResponse', () => {
  it('folds a successful response', () => {
    const folded = foldIrohPairResponse({
      ok: true,
      vaultId: 'v1',
      vaultName: 'Personal',
      gatewayName: 'Home',
    });
    expect(isFoldError(folded)).toBe(false);
    expect(folded).toEqual({ vaultId: 'v1', vaultName: 'Personal', gatewayName: 'Home' });
  });

  it('defaults vaultName to empty string when the gateway omits it', () => {
    const folded = foldIrohPairResponse({ ok: true, vaultId: 'v1' });
    expect(folded).toEqual({ vaultId: 'v1', vaultName: '' });
  });

  it('maps ok:false + error:ticket_expired to the stable expired code', () => {
    const folded = foldIrohPairResponse({ ok: false, error: 'ticket_expired' });
    expect(isFoldError(folded)).toBe(true);
    expect(folded).toEqual({ error: 'ticket_expired', message: 'This pairing code has expired.' });
  });

  it('maps any other rejection to invalid_ticket', () => {
    const folded = foldIrohPairResponse({ ok: false, error: 'bad_secret' });
    expect(folded).toEqual({ error: 'invalid_ticket', message: 'bad_secret' });
  });

  it('treats ok:true with no vaultId as a malformed response', () => {
    const folded = foldIrohPairResponse({ ok: true });
    expect(folded).toEqual({
      error: 'bad_response',
      message: 'Gateway did not return a vault id.',
    });
  });
});

describe('foldHttpPairResponse', () => {
  it('folds a successful 200 response', () => {
    const folded = foldHttpPairResponse(200, {
      ok: true,
      deviceToken: 'tok',
      deviceKey: 'key',
      vaultId: 'v1',
      vaultName: 'Personal',
    });
    expect(folded).toEqual({
      deviceToken: 'tok',
      deviceKey: 'key',
      vaultId: 'v1',
      vaultName: 'Personal',
    });
  });

  it('omits deviceKey when the gateway does not send one', () => {
    const folded = foldHttpPairResponse(200, {
      ok: true,
      deviceToken: 'tok',
      vaultId: 'v1',
      vaultName: 'Personal',
    });
    expect(folded).toEqual({ deviceToken: 'tok', vaultId: 'v1', vaultName: 'Personal' });
  });

  it('maps 403 {error:"ticket_expired"} to the expired code', () => {
    expect(foldHttpPairResponse(403, { ok: false, error: 'ticket_expired' })).toEqual({
      error: 'ticket_expired',
      message: 'This pairing code has expired.',
    });
  });

  it('maps 403 {error:"ticket_invalid"} (and any other 403 body) to invalid_ticket', () => {
    expect(foldHttpPairResponse(403, { ok: false, error: 'ticket_invalid' })).toEqual({
      error: 'invalid_ticket',
      message: 'That pairing code is not valid.',
    });
    expect(foldHttpPairResponse(403, {})).toEqual({
      error: 'invalid_ticket',
      message: 'That pairing code is not valid.',
    });
  });

  it('maps a non-200/403 status to unreachable with the status code', () => {
    expect(foldHttpPairResponse(503, {})).toEqual({ error: 'unreachable', message: 'HTTP 503' });
  });

  it('treats a non-object 200 body as bad_response', () => {
    expect(foldHttpPairResponse(200, 'not an object')).toEqual({
      error: 'bad_response',
      message: 'Gateway returned a malformed pairing response.',
    });
    expect(foldHttpPairResponse(200, null)).toEqual({
      error: 'bad_response',
      message: 'Gateway returned a malformed pairing response.',
    });
  });

  it('treats {ok:false} on a 200 as invalid_ticket', () => {
    expect(foldHttpPairResponse(200, { ok: false })).toEqual({
      error: 'invalid_ticket',
      message: 'That pairing code is not valid.',
    });
  });

  it('treats a missing/empty deviceToken as bad_response', () => {
    expect(foldHttpPairResponse(200, { ok: true, vaultId: 'v1' })).toEqual({
      error: 'bad_response',
      message: 'Gateway did not return a device token.',
    });
    expect(foldHttpPairResponse(200, { ok: true, deviceToken: '', vaultId: 'v1' })).toEqual({
      error: 'bad_response',
      message: 'Gateway did not return a device token.',
    });
  });

  it('treats a missing/empty vaultId as bad_response', () => {
    expect(foldHttpPairResponse(200, { ok: true, deviceToken: 'tok' })).toEqual({
      error: 'bad_response',
      message: 'Gateway did not return a vault id.',
    });
  });
});

describe('findReusableProfile', () => {
  const profiles = [
    { id: 'a', transport: 'iroh' as const, endpointTicket: 'ticket-a' },
    { id: 'b', transport: 'direct' as const, url: 'https://gw.example' },
    { id: 'c', transport: 'local' as const },
  ];

  it('finds an existing iroh profile by endpointTicket', () => {
    expect(findReusableProfile(profiles, { endpointTicket: 'ticket-a' })?.id).toBe('a');
  });

  it('finds an existing direct profile by url', () => {
    expect(findReusableProfile(profiles, { url: 'https://gw.example' })?.id).toBe('b');
  });

  it('does not cross-match transports (an iroh ticket never matches a direct url slot)', () => {
    expect(findReusableProfile(profiles, { endpointTicket: 'https://gw.example' })).toBeUndefined();
  });

  it('returns undefined when nothing matches — the caller mints a new profile', () => {
    expect(findReusableProfile(profiles, { endpointTicket: 'never-seen' })).toBeUndefined();
    expect(findReusableProfile(profiles, { url: 'https://never-seen.example' })).toBeUndefined();
  });
});
