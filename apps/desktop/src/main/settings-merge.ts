/*
 * Pure settings-patch merge, extracted from settings.ts so it's unit-testable
 * without pulling in electron (settings.ts imports `electron` at module load).
 *
 * Merge rules per field:
 *   - `undefined` in the patch  → preserve the current value
 *   - a value in the patch       → set it
 *
 * Chat-model selection no longer lives here — it moved to the gateway prefs
 * store (`model.<runnerKind>.<slot>` keys via `GET/PUT /_centraid-user/prefs`,
 * see `settingsProvidersData.ts`), so every client sharing a gateway sees the
 * same picks instead of each desktop install keeping its own.
 */

import { clampAlertSeconds } from './gateway-monitor-core.js';
import type { PersistedSettings } from './settings.js';

/** The persistable subset of a settings patch. */
export interface PersistedSettingsPatch {
  activeGatewayId?: string;
  remoteTemplatesUrl?: string;
  /**
   * Client-owned active vault per gateway (issue #289). Set as a whole map
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
  /** Launch Centraid at OS login (issue #351). Preserve-or-set boolean. */
  launchAtLogin?: boolean;
}

/** Preserve-or-set for a plain optional string field (`undefined` = preserve). */
function preserveOrSet<K extends string>(
  key: K,
  patched: string | undefined,
  currentValue: string | undefined,
): Record<K, string> | Record<string, never> {
  if (patched !== undefined) return { [key]: patched } as Record<K, string>;
  if (currentValue !== undefined) return { [key]: currentValue } as Record<K, string>;
  return {};
}

/** Compute the next persisted settings from the current value + a patch. */
export function mergePersistedSettings(
  current: PersistedSettings,
  patch: PersistedSettingsPatch,
): PersistedSettings {
  // Whole-map preserve-or-set: the vault pointer map is edited through
  // `setActiveVaultId`, so a plain `saveSettings` must carry it verbatim.
  const activeVaultByGateway = patch.activeVaultByGateway ?? current.activeVaultByGateway;
  return {
    activeGatewayId: patch.activeGatewayId?.trim() || current.activeGatewayId,
    ...preserveOrSet('remoteTemplatesUrl', patch.remoteTemplatesUrl, current.remoteTemplatesUrl),
    ...(activeVaultByGateway !== undefined && Object.keys(activeVaultByGateway).length
      ? { activeVaultByGateway }
      : {}),
    ...preserveOrSet(
      'onboardingCompletedAt',
      patch.onboardingCompletedAt,
      current.onboardingCompletedAt,
    ),
    ...(() => {
      // Preserve-or-set with write-time clamping; a garbage patch value
      // (NaN, wrong type) falls back to the current value.
      const next = clampAlertSeconds(patch.gatewayAlertSeconds) ?? current.gatewayAlertSeconds;
      return next !== undefined ? { gatewayAlertSeconds: next } : {};
    })(),
    ...(patch.gatewayAlertsEnabled !== undefined
      ? { gatewayAlertsEnabled: patch.gatewayAlertsEnabled }
      : current.gatewayAlertsEnabled !== undefined
        ? { gatewayAlertsEnabled: current.gatewayAlertsEnabled }
        : {}),
    ...preserveOrSet(
      'changelogSeenVersion',
      patch.changelogSeenVersion,
      current.changelogSeenVersion,
    ),
    ...(patch.launchAtLogin !== undefined
      ? { launchAtLogin: patch.launchAtLogin }
      : current.launchAtLogin !== undefined
        ? { launchAtLogin: current.launchAtLogin }
        : {}),
  };
}
