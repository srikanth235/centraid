/*
 * Pure settings-patch merge. Keep it electron-free so it stays unit-testable —
 * settings.ts imports `electron` at module load.
 *
 * Merge rules per field:
 *   - `undefined` in the patch  → preserve the current value
 *   - a value in the patch       → set it
 *
 * Chat-model selection does not belong here: it lives in the gateway prefs
 * store (`model.<harnessKind>.<slot>` keys via `GET/PUT /_centraid-user/prefs`,
 * see `settingsHarnessesData.ts`), so every client sharing a gateway sees the
 * same picks rather than each desktop install keeping its own.
 */

import { clampAlertSeconds } from "./gateway-monitor-core.js";
import type { PersistedSettings } from "./settings.js";

/** The persistable subset of a settings patch. */
export interface PersistedSettingsPatch {
  activeGatewayId?: string;
  /**
   * Client-owned active vault per gateway (#289). Set as a whole map
   * (preserve when `undefined`). The dedicated `setActiveVaultId` path
   * writes it directly; this merge just carries it through so an unrelated
   * `saveSettings` never wipes it.
   */
  activeVaultByGateway?: Record<string, string>;
  onboardingCompletedAt?: string;
  /** Gateway down-alert threshold in seconds — clamped on write. */
  gatewayAlertSeconds?: number;
  /** Master switch for the gateway down alert. */
  gatewayAlertsEnabled?: boolean;
  /** Changelog version last shown by "What's new" (preserve-or-set string). */
  changelogSeenVersion?: string;
  /** Launch Centraid at OS login. Preserve-or-set boolean. */
  launchAtLogin?: boolean;
  /**
   * Offer OS service install for the detached gateway (H5).
   * Preserve-or-set boolean; default off when never set.
   */
  offerGatewayService?: boolean;
}

/** Preserve-or-set for a plain optional string field (`undefined` = preserve). */
function preserveOrSet<K extends string>(
  key: K,
  patched: string | undefined,
  currentValue: string | undefined
): Record<K, string> | Record<string, never> {
  if (patched !== undefined) return { [key]: patched } as Record<K, string>;
  if (currentValue !== undefined)
    return { [key]: currentValue } as Record<K, string>;
  return {};
}

/** Compute the next persisted settings from the current value + a patch. */
export function mergePersistedSettings(
  current: PersistedSettings,
  patch: PersistedSettingsPatch
): PersistedSettings {
  // Whole-map preserve-or-set: the vault pointer map is edited through
  // `setActiveVaultId`, so a plain `saveSettings` must carry it verbatim.
  const activeVaultByGateway =
    patch.activeVaultByGateway ?? current.activeVaultByGateway;
  return {
    activeGatewayId: patch.activeGatewayId?.trim() || current.activeGatewayId,
    ...(activeVaultByGateway !== undefined &&
    Object.keys(activeVaultByGateway).length
      ? { activeVaultByGateway }
      : {}),
    ...preserveOrSet(
      "onboardingCompletedAt",
      patch.onboardingCompletedAt,
      current.onboardingCompletedAt
    ),
    ...(() => {
      // Preserve-or-set with write-time clamping; a garbage patch value
      // (NaN, wrong type) falls back to the current value.
      const next =
        clampAlertSeconds(patch.gatewayAlertSeconds) ??
        current.gatewayAlertSeconds;
      return next === undefined ? {} : { gatewayAlertSeconds: next };
    })(),
    ...(patch.gatewayAlertsEnabled === undefined
      ? current.gatewayAlertsEnabled === undefined
        ? {}
        : { gatewayAlertsEnabled: current.gatewayAlertsEnabled }
      : { gatewayAlertsEnabled: patch.gatewayAlertsEnabled }),
    ...preserveOrSet(
      "changelogSeenVersion",
      patch.changelogSeenVersion,
      current.changelogSeenVersion
    ),
    ...(patch.launchAtLogin === undefined
      ? current.launchAtLogin === undefined
        ? {}
        : { launchAtLogin: current.launchAtLogin }
      : { launchAtLogin: patch.launchAtLogin }),
    ...(patch.offerGatewayService === undefined
      ? current.offerGatewayService === undefined
        ? {}
        : { offerGatewayService: current.offerGatewayService }
      : { offerGatewayService: patch.offerGatewayService }),
  };
}
