import type { RegistryEntry } from "../types.js";

/** App folder id: alnum/`-`/`_` slug only — no separators, dots, dots-dots, or `_` prefix (plugin-internal). Shared identity gate for ledger, automation, blob store. */
export function isValidAppId(id: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  if (id.startsWith("_")) return false;
  return /^[A-Za-z0-9_-]+$/u.test(id);
}

/** Assistant's reserved conversation + blob-CAS scope. Real ids never start with `_`, so collision-free by construction. Lives here (not `conversation/history.ts`) so the blob store can gate it via `isValidAppId` without a circular import. */
export const ASSISTANT_APP_ID = "_assistant";

/** `isValidAppId` plus the one reserved exception: `_assistant`. Use wherever an app id gates a per-app resource the assistant shares. */
export function isValidAppOrAssistantId(id: string): boolean {
  return id === ASSISTANT_APP_ID || isValidAppId(id);
}

/** Persistent runtime state (`logs.jsonl`, settings, attachment CAS) at `<appsDir>/<id>/`, kept separate from the git-store worktree (#137). App DATA lives in the vault (#286). */
export function appDataDir(entry: RegistryEntry): string {
  return entry.path;
}
