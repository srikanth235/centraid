import type { ServerResponse } from 'node:http';
import {
  VaultBlobAuthorizationError,
  VaultBlobBackpressureError,
  VaultBlobHashMismatchError,
  VaultBlobRemoteUnavailableError,
  VaultBlobSessionError,
  VaultDiskFullError,
} from '@centraid/vault';
import { sendJson } from './route-helpers.js';

/** Stable HTTP problem mapping for the blob transfer protocol. */
export function sendBlobRouteError(res: ServerResponse, error: unknown): true {
  // Once streaming has started there is no valid JSON error response left to
  // write. Attempting to set headers here throws ERR_HTTP_HEADERS_SENT and can
  // turn an ordinary source failure into an unhandled route rejection.
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.destroy();
    return true;
  }
  if (error instanceof VaultBlobBackpressureError) {
    res.setHeader('Retry-After', '5');
    return sendJson(res, 429, {
      error: error.code,
      message: error.message,
      retryable: true,
      ...error.details,
    });
  }
  if (error instanceof VaultBlobHashMismatchError) {
    return sendJson(res, 422, {
      error: error.code,
      message: error.message,
      expectedSha256: error.expectedSha256,
      actualSha256: error.actualSha256,
    });
  }
  if (error instanceof VaultBlobSessionError) {
    return sendJson(res, 409, {
      error: error.code,
      message: error.message,
      ...(error.expectedOffset === undefined ? {} : { expectedOffset: error.expectedOffset }),
    });
  }
  if (error instanceof VaultBlobAuthorizationError) {
    return sendJson(res, 403, { error: error.code, message: error.message });
  }
  if (error instanceof VaultBlobRemoteUnavailableError) {
    res.setHeader('Retry-After', '5');
    return sendJson(res, 503, {
      error: error.code,
      message: error.message,
      retryable: true,
      fallback: 'gateway',
    });
  }
  if (error instanceof VaultDiskFullError) {
    return sendJson(res, 507, { error: error.message });
  }
  return sendJson(res, 400, {
    error: error instanceof Error ? error.message : String(error),
  });
}
