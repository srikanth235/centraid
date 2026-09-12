import type { BackupPolicy } from "../backup-policy.js";
import { VaultBlobBackpressureError } from "../errors.js";
import type { BlobCache } from "./cache.js";
import type { RemoteTier } from "./custody-types.js";
import type { RemoteBlobTransfer } from "./remote-transfer.js";
import type { BlobTransferState } from "./transfer-state.js";

const AVAILABILITY_PROBE_SHA = "0".repeat(64);

/** INGEST DOES NOT STOP BECAUSE CUSTODY IS DOWN (#1014, B13). The outbox
 *  budget is a bound on how far AHEAD of custody the host may run; while
 *  custody is simply unreachable that bound stops meaning anything useful and
 *  starts refusing the member's own photographs on their own disk. So a
 *  stalled provider widens the logical ceiling by this factor — never the
 *  physical one: free disk is still free disk, and `cache.admit` below is the
 *  gate that keeps saying so. */
export const UNREACHABLE_OUTBOX_BUDGET_MULTIPLIER = 4;

/** A transfer interface alone is not availability; prove the provider answers a HEAD. */
export async function requireRemote(
  remote: RemoteTier | null,
  capacityError: VaultBlobBackpressureError,
  sha256?: string
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
  expectedShaSupplied: boolean
): void {
  const policy = deps.policy();
  const status = deps.state.status();
  const reserved = deps.state.reservedIngressBytes();
  const diskReserved = deps.state.reservedIngressRemainingBytes();
  const stalled = deps.remoteConfigured() && deps.state.custodyStalled();
  const outboxBudgetBytes = stalled
    ? policy.outboxBudgetBytes * UNREACHABLE_OUTBOX_BUDGET_MULTIPLIER
    : policy.outboxBudgetBytes;
  const outboxAvailable = deps.remoteConfigured()
    ? Math.max(0, outboxBudgetBytes - status.pendingBytes - reserved)
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
      outboxBudgetBytes,
      expectedShaRequired: !expectedShaSupplied,
    });
  }
  const capacity = deps.cache.admissionCapacity(reserved, diskReserved);
  const availableBytes = Math.min(outboxAvailable, capacity.availableBytes);
  if (incoming <= availableBytes) return;
  // Name WHICH wall was hit: a member whose disk is full and a member whose
  // custody provider is down need different actions (#1014, B13).
  const wall =
    capacity.availableBytes <= outboxAvailable
      ? `${policy.reservedHeadroomBytes} bytes of disk headroom`
      : stalled
        ? `the ${outboxBudgetBytes}-byte outbox budget widened while custody is unreachable`
        : `the ${outboxBudgetBytes}-byte outbox budget`;
  throw new VaultBlobBackpressureError(
    "blob ingress reservation",
    `blob upload needs ${incoming} bytes but only ${availableBytes} bytes remain after ` +
      `${wall}; ` +
      (expectedShaSupplied
        ? "declared-SHA stream-through is required"
        : "send X-Content-SHA256 to enable bounded stream-through"),
    {
      needBytes: incoming,
      availableBytes,
      freeBytes: capacity.freeBytes,
      reservedHeadroomBytes: policy.reservedHeadroomBytes,
      outboxBudgetBytes,
      expectedShaRequired: !expectedShaSupplied,
    }
  );
}
