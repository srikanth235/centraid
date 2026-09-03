import { formatBytes } from "@centraid/design";

import type { LocalUsageReportDTO } from "../../../gateway-client-local-storage.js";
import type { DevicesDisagreeProps, OutOfRoomProps } from "../../ui/states.js";

export function homeOutOfRoom(
  report: LocalUsageReportDTO | undefined,
  onManage: () => void
): OutOfRoomProps | undefined {
  const limit = report?.limit;
  if (!limit || limit.limitBytes === null) return undefined;
  if (limit.status === "ok") return undefined;
  const over = limit.status === "error";
  return {
    action: { label: "Manage storage", run: onManage },
    cause: over
      ? `Centraid has used all ${formatBytes(limit.limitBytes)} of the disk budget you set.`
      : `Centraid is close to the ${formatBytes(limit.limitBytes)} disk budget you set.`,
    consequence: over
      ? "New photos and files will stop syncing to this device."
      : "New photos and files will stop syncing once it is full.",
    fractionUsed: limit.fractionUsed ?? 1,
    limitLabel: formatBytes(limit.limitBytes),
    usedLabel: formatBytes(limit.usedBytes),
  };
}

export const HOME_CONFLICTS: readonly DevicesDisagreeProps[] = [];
