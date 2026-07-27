/*
 * Roster predicates over the device DTO (issue #599).
 *
 * A leaf on purpose: `gateway-client-devices.ts` registers gateway listeners
 * at module load through `gateway-client-core.ts`, so a React screen that
 * only needs to ask "is this row a tombstone?" must not have to import the
 * whole HTTP client to find out.
 */

import type { CentraidGatewayDevice } from './gateway-client-devices.js';

/**
 * Is this row a tombstone rather than a live binding? Revoking a device no
 * longer deletes its row — it survives at the `revoked` pseudo-role so past
 * attribution still resolves to the device that made the write. Every live
 * count, grouping, and action has to skip these.
 */
export function isRevokedDevice(device: CentraidGatewayDevice): boolean {
  return device.role === 'revoked';
}
