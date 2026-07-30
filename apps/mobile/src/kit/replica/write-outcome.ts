import { Alert } from "react-native";

import type { NativeWriteResult } from "../../lib/replica/native-session";

export interface SurfaceWriteOutcomeOptions {
  failureTitle?: string;
  /** Replaces the default parked Alert (e.g. navigate to Approvals). */
  onParked?: () => void;
  queuedMessage?: string;
  /** Replaces the default queued Alert (e.g. an in-line pending banner). */
  onQueued?: () => void;
  /** Replaces the default in-flight Alert. */
  onInFlight?: () => void;
}

/**
 * Turns every native intent admission outcome into an immediate user-visible
 * result. Executed writes are already visible through their optimistic
 * mutation; every other state needs an explicit affordance.
 *
 * Returns whether the caller may continue an optimistic success flow (for
 * example, close a modal, extract `output`, or navigate away).
 */
export function surfaceWriteOutcome(
  result: NativeWriteResult,
  options: SurfaceWriteOutcomeOptions = {}
): boolean {
  if (result.status === "executed") return true;
  if (result.status === "parked") {
    if (options.onParked) options.onParked();
    else
      Alert.alert(
        "Awaiting approval",
        result.reason ?? "This change is ready for owner approval."
      );
    return false;
  }
  if (result.status === "queued") {
    if (options.onQueued) options.onQueued();
    else
      Alert.alert(
        "Saved offline",
        options.queuedMessage ??
          "This change will sync automatically when the gateway reconnects."
      );
    return true;
  }
  if (result.status === "in-flight") {
    if (options.onInFlight) options.onInFlight();
    else
      Alert.alert(
        "Saving",
        "This change is queued on the gateway. Its final status remains visible in sync status."
      );
    return true;
  }
  Alert.alert(
    options.failureTitle ?? "Change not applied",
    result.reason ?? "The vault rejected this change."
  );
  return false;
}

export function surfaceWriteFailure(
  error: unknown,
  failureTitle = "Change failed"
): void {
  Alert.alert(
    failureTitle,
    error instanceof Error ? error.message : "Please try again."
  );
}

/** Extract the executed/queued command output bag when present. */
export function nativeWriteOutput(
  result: NativeWriteResult | undefined
): Record<string, unknown> | undefined {
  if (!result || !("output" in result) || !result.output) return undefined;
  return result.output as Record<string, unknown>;
}
