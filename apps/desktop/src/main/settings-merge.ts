/*
 * Pure settings-patch merge, extracted from settings.ts so it's unit-testable
 * without pulling in electron (settings.ts imports `electron` at module load).
 *
 * Merge rules per field:
 *   - `undefined` in the patch  → preserve the current value
 *   - a value in the patch       → set it
 *   - **empty-string `chatModel`** → CLEAR it (the "Gateway default" choice)
 *
 * The empty-string clear is why this isn't a plain spread: the chat picker's
 * "Gateway default" option has value `''`, and the user must be able to drop a
 * previously-pinned concrete model. `undefined` still means "leave untouched"
 * so unrelated `saveSettings({ ... })` calls never wipe the chat model.
 */

import type { PersistedSettings } from './settings.js';

/** The persistable subset of a settings patch. */
export interface PersistedSettingsPatch {
  activeGatewayId?: string;
  remoteTemplatesUrl?: string;
  /** Non-empty → set; `''` → clear ("Gateway default"); `undefined` → preserve. */
  chatModel?: string;
  onboardingCompletedAt?: string;
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
  return {
    activeGatewayId: patch.activeGatewayId?.trim() || current.activeGatewayId,
    ...preserveOrSet('remoteTemplatesUrl', patch.remoteTemplatesUrl, current.remoteTemplatesUrl),
    // chatModel: empty string clears, non-empty sets, undefined preserves.
    ...(patch.chatModel !== undefined
      ? patch.chatModel
        ? { chatModel: patch.chatModel }
        : {}
      : current.chatModel !== undefined
        ? { chatModel: current.chatModel }
        : {}),
    ...preserveOrSet(
      'onboardingCompletedAt',
      patch.onboardingCompletedAt,
      current.onboardingCompletedAt,
    ),
  };
}
