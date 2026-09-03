import { pendingOverlayCopy } from "@centraid/blueprints/apps/_shared/pending-overlay";

import type { NativeWriteResult } from "../../lib/replica/native-session";
import { postStatus } from "../components/status-line";

const CONFLICT_ROUTE = "Open Pending changes to retry or discard.";

export interface SurfaceWriteOutcomeOptions {
  failureTitle?: string;
  onParked?: () => void;
  onConflict?: () => void;
  queuedMessage?: string;
  onQueued?: () => void;
  onInFlight?: () => void;
}

export function surfaceWriteOutcome(
  result: NativeWriteResult,
  options: SurfaceWriteOutcomeOptions = {}
): boolean {
  if (result.status === "executed") return true;
  if (result.status === "parked") {
    if (options.onParked) options.onParked();
    else
      postStatus(result.reason ?? "This change is ready for owner approval.");
    return false;
  }
  if (result.status === "queued") {
    if (options.onQueued) options.onQueued();
    else
      postStatus(
        options.queuedMessage ??
          "Saved offline — it will sync when the gateway reconnects."
      );
    return true;
  }
  if (result.status === "conflict") {
    if (options.onConflict) options.onConflict();
    else
      postStatus(
        `${pendingOverlayCopy({
          key: result.intentId,
          status: "conflict",
          action: "",
          ...(result.reason ? { reason: result.reason } : {}),
          ...("conflict" in result && result.conflict
            ? {
                expectedVersion: result.conflict.expectedVersion,
                actualVersion: result.conflict.actualVersion,
              }
            : {}),
        })} ${CONFLICT_ROUTE}`
      );
    return false;
  }
  if (result.status === "in-flight") {
    if (options.onInFlight) options.onInFlight();
    else
      postStatus("Saving — the final status remains visible in sync status.");
    return true;
  }
  postStatus(
    `${options.failureTitle ?? "Change not applied"}: ${result.reason ?? "The vault rejected this change."}`
  );
  return false;
}

export function surfaceWriteFailure(
  error: unknown,
  failureTitle = "Change failed"
): void {
  postStatus(
    `${failureTitle}: ${error instanceof Error ? error.message : "Please try again."}`
  );
}

export function nativeWriteOutput(
  result: NativeWriteResult | undefined
): Record<string, unknown> | undefined {
  if (!result || !("output" in result) || !result.output) return undefined;
  return result.output as Record<string, unknown>;
}
