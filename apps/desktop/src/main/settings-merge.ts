/*
 * Pure settings-patch merge, extracted from settings.ts so it's unit-testable
 * without pulling in electron (settings.ts imports `electron` at module load).
 *
 * Merge rules per field:
 *   - `undefined` in the patch  → preserve the current value
 *   - a value in the patch       → set it
 *
 * `chatModelByRunner` is special: it's a per-runner map merged KEY-BY-KEY into
 * the current map, so saving one agent's model never disturbs another's:
 *   - `{ codex: '<model-id>' }` → set codex's model
 *   - `{ codex: '' }`           → CLEAR codex's model (back to "Gateway default")
 *   - key absent from patch      → that runner's entry is preserved
 *   - whole field `undefined`    → the entire map is preserved
 * The empty-string-clears rule is why this isn't a plain spread: the picker's
 * "Gateway default" choice for a runner has value `''`, and the user must be
 * able to drop a previously-pinned concrete model for that runner alone.
 */

import { clampAlertSeconds } from './gateway-monitor-core.js';
import type { PersistedSettings } from './settings.js';

/** The persistable subset of a settings patch. */
export interface PersistedSettingsPatch {
  activeGatewayId?: string;
  remoteTemplatesUrl?: string;
  /**
   * Per-runner chat-model patch, merged key-by-key (see file header):
   * non-empty value → set that runner; `''` → clear that runner; key absent →
   * preserve; whole field `undefined` → preserve the entire map.
   */
  chatModelByRunner?: Record<string, string>;
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

/**
 * Merge a per-runner model patch into the current map. Returns `undefined`
 * when nothing remains (so the field is dropped rather than persisted empty),
 * or `current` untouched when the patch omits the field.
 */
function mergeChatModelByRunner(
  current: Record<string, string> | undefined,
  patch: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (patch === undefined) return current; // preserve the whole map
  const next: Record<string, string> = { ...current };
  for (const [kind, value] of Object.entries(patch)) {
    if (value)
      next[kind] = value; // non-empty → set
    else delete next[kind]; // '' → clear this runner only
  }
  return Object.keys(next).length ? next : undefined;
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
  const chatModelByRunner = mergeChatModelByRunner(
    current.chatModelByRunner,
    patch.chatModelByRunner,
  );
  // Whole-map preserve-or-set: the vault pointer map is edited through
  // `setActiveVaultId`, so a plain `saveSettings` must carry it verbatim.
  const activeVaultByGateway = patch.activeVaultByGateway ?? current.activeVaultByGateway;
  return {
    activeGatewayId: patch.activeGatewayId?.trim() || current.activeGatewayId,
    ...preserveOrSet('remoteTemplatesUrl', patch.remoteTemplatesUrl, current.remoteTemplatesUrl),
    ...(chatModelByRunner !== undefined ? { chatModelByRunner } : {}),
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
