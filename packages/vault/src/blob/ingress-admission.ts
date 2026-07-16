import type { BackupPolicy } from '../backup-policy.js';
import { VaultBlobBackpressureError } from '../errors.js';
import type { BlobCache } from './cache.js';
import type { BlobTransferState } from './transfer-state.js';
import type { RemoteTier } from './custody-types.js';
import type { RemoteBlobTransfer } from './remote-transfer.js';

const AVAILABILITY_PROBE_SHA = '0'.repeat(64);

/** A transfer interface alone is not availability; prove the provider answers a HEAD. */
export async function requireRemote(
  remote: RemoteTier | null,
  capacityError: VaultBlobBackpressureError,
  sha256?: string,
): Promise<RemoteTier & { transfer: RemoteBlobTransfer }> {
  if (!remote?.transfer) throw capacityError;
  try {
    await remote.store.stat(sha256 ?? AVAILABILITY_PROBE_SHA);
  } catch {
    throw capacityError;
  }
  return remote as RemoteTier & { transfer: RemoteBlobTransfer };
}

/** Apply both physical headroom and logical outbox-budget admission. */
export function assertSpoolAdmission(
  deps: {
    cache: BlobCache;
    state: BlobTransferState;
    policy: () => BackupPolicy;
    remoteConfigured: () => boolean;
  },
  incoming: number,
  expectedShaSupplied: boolean,
): void {
  const policy = deps.policy();
  const status = deps.state.status();
  const reserved = deps.state.reservedIngressBytes();
  const diskReserved = deps.state.reservedIngressRemainingBytes();
  const outboxAvailable = deps.remoteConfigured()
    ? Math.max(0, policy.outboxBudgetBytes - status.pendingBytes - reserved)
    : Number.MAX_SAFE_INTEGER;
  try {
    deps.cache.admit(incoming, reserved, diskReserved);
  } catch (error) {
    if (!(error instanceof VaultBlobBackpressureError)) throw error;
    throw new VaultBlobBackpressureError(error.context, error.message, {
      ...(error.details ?? {
        needBytes: incoming,
        availableBytes: 0,
        freeBytes: deps.cache.freeBytes(),
        reservedHeadroomBytes: policy.reservedHeadroomBytes,
      }),
      outboxBudgetBytes: policy.outboxBudgetBytes,
      expectedShaRequired: !expectedShaSupplied,
    });
  }
  const capacity = deps.cache.admissionCapacity(reserved, diskReserved);
  const availableBytes = Math.min(outboxAvailable, capacity.availableBytes);
  if (incoming <= availableBytes) return;
  throw new VaultBlobBackpressureError(
    'blob ingress reservation',
    `blob upload needs ${incoming} bytes but only ${availableBytes} bytes remain after ` +
      `${policy.reservedHeadroomBytes} bytes of disk headroom and the ${policy.outboxBudgetBytes}-byte outbox budget; ` +
      (expectedShaSupplied
        ? 'declared-SHA stream-through is required'
        : 'send X-Content-SHA256 to enable bounded stream-through'),
    {
      needBytes: incoming,
      availableBytes,
      freeBytes: capacity.freeBytes,
      reservedHeadroomBytes: policy.reservedHeadroomBytes,
      outboxBudgetBytes: policy.outboxBudgetBytes,
      expectedShaRequired: !expectedShaSupplied,
    },
  );
}
