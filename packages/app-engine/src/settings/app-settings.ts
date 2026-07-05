/*
 * Per-app settings reader/writer.
 *
 * Settings live in `settings.json` at the app's persistent root
 * (`<appsDir>/<id>/settings.json`) — runtime state beside `logs.jsonl`,
 * NOT owner data (that's the vault's). The per-app `data.sqlite` silo is
 * gone (issue #286 phase 2); this file is what remains of it: a flat
 * `{ key: value }` JSON object with two writers, partitioned by prefix:
 *
 *   - **App-owned keys** (no reserved prefix): per-instance customization
 *     (aesthetic knob choices). `readAppSettings` is the runtime's bulk
 *     reader, called during `app-index` to bake values into served HTML.
 *
 *   - **Runtime-owned keys** (prefix `__`): the runtime writes these
 *     directly via `writeAppSetting`. Currently only
 *     `__automation.<name>.enabled` lives here — automation toggle state,
 *     which must survive publish and die with "delete the app".
 *
 * Contract:
 *   - Missing file = empty settings, no error.
 *   - Reads are best-effort (never throw — a corrupt file must not block
 *     the app from serving). Writes throw on I/O errors so a failed
 *     toggle surfaces.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const APP_SETTINGS_FILE = 'settings.json';

/** Reserved key prefix for runtime-owned settings. Apps must not write these. */
export const RUNTIME_KEY_PREFIX = '__';

/** Build the reserved key the runtime uses to persist an automation's enable toggle. */
export function automationEnabledKey(name: string): string {
  return `__automation.${name}.enabled`;
}

function settingsFile(appDir: string): string {
  return path.join(appDir, APP_SETTINGS_FILE);
}

function readAll(appDir: string): Record<string, unknown> {
  const file = settingsFile(appDir);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeAll(appDir: string, settings: Record<string, unknown>): void {
  const file = settingsFile(appDir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * Read every setting of an app. Empty object when the file is missing or
 * malformed — best-effort, must never block index.html from serving.
 */
export function readAppSettings(appDir: string): Record<string, unknown> {
  return readAll(appDir);
}

/** Read a single setting value; `undefined` when absent. Never throws. */
export function readAppSetting(appDir: string, key: string): unknown | undefined {
  return readAll(appDir)[key];
}

/**
 * Write a single setting value (file created on demand). Throws on I/O
 * errors — this is the toggle-failed path the user needs to see.
 */
export function writeAppSetting(appDir: string, key: string, value: unknown): void {
  const settings = readAll(appDir);
  settings[key] = value;
  writeAll(appDir, settings);
}

/** Delete a single setting key. No-op when absent. Best-effort. */
export function deleteAppSetting(appDir: string, key: string): void {
  try {
    const settings = readAll(appDir);
    if (!(key in settings)) return;
    delete settings[key];
    writeAll(appDir, settings);
  } catch {
    // Best-effort — settings deletion failures shouldn't surface.
  }
}
