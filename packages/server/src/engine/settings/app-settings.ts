import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const APP_SETTINGS_FILE = "settings.json";

export const RUNTIME_KEY_PREFIX = "__";

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
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeAll(appDir: string, settings: Record<string, unknown>): void {
  const file = settingsFile(appDir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function readAppSettings(appDir: string): Record<string, unknown> {
  return readAll(appDir);
}

export function readAppSetting(
  appDir: string,
  key: string
): unknown | undefined {
  return readAll(appDir)[key];
}

export function writeAppSetting(
  appDir: string,
  key: string,
  value: unknown
): void {
  const settings = readAll(appDir);
  settings[key] = value;
  writeAll(appDir, settings);
}

export function deleteAppSetting(appDir: string, key: string): void {
  try {
    const settings = readAll(appDir);
    if (!(key in settings)) return;
    delete settings[key];
    writeAll(appDir, settings);
  } catch {
    // Intentionally empty.
  }
}
