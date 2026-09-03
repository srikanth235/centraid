import type { RegistryEntry } from "../types.js";

export function isValidAppId(id: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  if (id.startsWith("_")) return false;
  return /^[A-Za-z0-9_-]+$/u.test(id);
}

export const ASSISTANT_APP_ID = "_assistant";

export function isValidAppOrAssistantId(id: string): boolean {
  return id === ASSISTANT_APP_ID || isValidAppId(id);
}

export function appDataDir(entry: RegistryEntry): string {
  return entry.path;
}
