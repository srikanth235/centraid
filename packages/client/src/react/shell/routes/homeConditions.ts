// The vault-level conditions Home reports (#708, section A).
//
// Two of the four designed states are conditions of the VAULT rather than of a
// screen, so they belong on the front door: "out of room" and "two devices
// disagree". This module turns their signals into the components' props, and
// says plainly where a signal does not yet exist.
import { formatBytes } from "@centraid/design";

import type { LocalUsageReportDTO } from "../../../gateway-client-local-storage.js";
import type { DevicesDisagreeProps, OutOfRoomProps } from "../../ui/states.js";

/**
 * `out of room`, from the REAL local-disk budget signal
 * (`LocalUsageReportDTO.limit`, gateway-client-local-storage.ts). Returns
 * nothing while the budget is unset or comfortable — a meter nobody needs to
 * read is noise on the one screen that should be all content.
 *
 * The three lines are in the brief's order and in the brief's proportions:
 * cause, then CONSEQUENCE (the line that matters, and the one typographically
 * on top), then exactly one action.
 */
export function homeOutOfRoom(
  report: LocalUsageReportDTO | undefined,
  onManage: () => void
): OutOfRoomProps | undefined {
  const limit = report?.limit;
  if (!limit || limit.limitBytes === null) return undefined;
  // `degraded` is the owner's own warn threshold; `error` is over budget.
  if (limit.status === "ok") return undefined;
  const over = limit.status === "error";
  return {
    action: { label: "Manage storage", run: onManage },
    cause: over
      ? `Centraid has used all ${formatBytes(limit.limitBytes)} of the disk budget you set.`
      : `Centraid is close to the ${formatBytes(limit.limitBytes)} disk budget you set.`,
    // The consequence, not the percentage. "98% used" is a fact; this is news.
    consequence: over
      ? "New photos and files will stop syncing to this device."
      : "New photos and files will stop syncing once it is full.",
    fractionUsed: limit.fractionUsed ?? 1,
    limitLabel: formatBytes(limit.limitBytes),
    usedLabel: formatBytes(limit.usedBytes),
  };
}

/**
 * `two devices disagree`.
 *
 * SEAM — there is no client-readable conflict record with both versions in it.
 * What exists today:
 *
 *   • `ReplicaIntentOutcome` (packages/vault/src/replica/intents.ts) is
 *     persisted and carries `deviceId`, `createdAt`/`updatedAt` and a
 *     `conflict`.
 *   • `ReplicaConflict` (packages/client/src/replica/types.ts) carries only
 *     `entity`, `rowId`, `expectedVersion` and `actualVersion`.
 *
 * So the two competing row BODIES and the device NAME (as opposed to its id)
 * are both absent, and nothing in the client reads outcomes back. Showing a
 * disagreement without showing what each side says would be the one thing this
 * state exists to prevent, so Home reports none until the record carries them.
 * The component is built, tested and mounted; this is the list it reads.
 */
export const HOME_CONFLICTS: readonly DevicesDisagreeProps[] = [];
