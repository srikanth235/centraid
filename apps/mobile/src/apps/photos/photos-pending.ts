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
