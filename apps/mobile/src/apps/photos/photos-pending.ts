// Writes still on this phone, for a Photos shelf (#880). A `PhotoAsset` is a
// merged row and the fold drops its sources' pending stamps, so the shelf
// reads the outbox and states the answer once above the grid.

import { pendingOverlayCopy } from "@centraid/blueprints/apps/_shared/pending-overlay";
import type { PendingOverlayStatus } from "@centraid/blueprints/apps/_shared/pending-overlay";

import type { PendingChange } from "../../kit/replica/pending-changes";

const APP_PREFIX = "photos:";

const STATUSES: readonly PendingOverlayStatus[] = [
  "queued",
  "sending",
  "parked",
  "denied",
  "conflict",
  "failed",
  "expired",
  "cancelled",
];

/** One sentence, or `null`. An unknown status is left out, never coerced. */
export function photosPendingLine(
  pending: readonly PendingChange[]
): string | null {
  for (const change of pending) {
    if (!change.label.startsWith(APP_PREFIX)) continue;
    const status = STATUSES.find((rung) => rung === change.status);
    if (!status) continue;
    return pendingOverlayCopy({
      key: change.id,
      status,
      action: change.label.slice(APP_PREFIX.length).trim(),
      ...(change.reason ? { reason: change.reason } : {}),
    });
  }
  return null;
}
