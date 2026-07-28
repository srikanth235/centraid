import { describe, expect, it } from 'vitest';

import {
  companionHttpError,
  decodeBytes,
  encodeBytes,
  isConnectFailure,
  isDeviceRevoked,
  shouldRetryCompanionRequest,
} from './transport-core.js';

const CONNECT = 'iroh-connect-failure';
const REVOKED = 'iroh-device-revoked';

describe('byte codecs', () => {
  it('round-trips raw bytes through base64', () => {
    const bytes = new Uint8Array([0, 1, 255, 42]);
    expect(Array.from(decodeBytes(encodeBytes(bytes)))).toStrictEqual([0, 1, 255, 42]);
  });
});

describe('failure classification', () => {
  it('detects connect failure and device-revoked markers', () => {
    expect(isConnectFailure(new Error(`boom ${CONNECT}`), CONNECT)).toBe(true);
    expect(isConnectFailure('nope', CONNECT)).toBe(false);
    expect(isDeviceRevoked(new Error(REVOKED), REVOKED)).toBe(true);
    expect(isDeviceRevoked({ message: 'x' }, REVOKED)).toBe(false);
  });
});

describe(shouldRetryCompanionRequest, () => {
  it('never retries device revocation', () => {
    expect(
      shouldRetryCompanionRequest({
        attempt: 0,
        maxAttempts: 2,
        method: 'GET',
        error: new Error(REVOKED),
        connectFailureMarker: CONNECT,
        deviceRevokedMarker: REVOKED,
      }),
    ).toBe(false);
  });

  it('retries idempotent methods until maxAttempts', () => {
    expect(
      shouldRetryCompanionRequest({
        attempt: 0,
        maxAttempts: 2,
        method: 'GET',
        error: new Error('timeout'),
        connectFailureMarker: CONNECT,
        deviceRevokedMarker: REVOKED,
      }),
    ).toBe(true);
    expect(
      shouldRetryCompanionRequest({
        attempt: 2,
        maxAttempts: 2,
        method: 'GET',
        error: new Error('timeout'),
        connectFailureMarker: CONNECT,
        deviceRevokedMarker: REVOKED,
      }),
    ).toBe(false);
  });

  it('retries non-idempotent only on clear connect failures', () => {
    expect(
      shouldRetryCompanionRequest({
        attempt: 0,
        maxAttempts: 2,
        method: 'POST',
        error: new Error('other'),
        connectFailureMarker: CONNECT,
        deviceRevokedMarker: REVOKED,
      }),
    ).toBe(false);
    expect(
      shouldRetryCompanionRequest({
        attempt: 0,
        maxAttempts: 2,
        method: 'POST',
        error: new Error(CONNECT),
        connectFailureMarker: CONNECT,
        deviceRevokedMarker: REVOKED,
      }),
    ).toBe(true);
  });
});

describe(companionHttpError, () => {
  it('maps 401 to the revoked message and otherwise prefers body text', () => {
    expect(companionHttpError(401, 'ignored')).toContain('revoked');
    expect(companionHttpError(500, 'upstream down')).toBe('upstream down');
    expect(companionHttpError(502, '')).toBe('Gateway returned HTTP 502.');
  });
});
