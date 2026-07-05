import type { RegistryEntry } from '../types.js';

/**
 * Validate an app folder id. A filesystem-safe slug — alnum / `-` / `_`,
 * no path separators, no dots, and no `_`-prefixed (plugin-internal) ids.
 * Automation apps are no longer distinguished by a dotted `auto.` prefix
 * (that is now the manifest's `kind` field), so the id grammar is a plain
 * slug again and `..` is impossible by construction.
 *
 * This is general app-identity — shared by the agent-run ledger
 * (`chat-history`), the automation domain (`automation-ref`,
 * `scaffold-automation`), and anything else that keys on an app folder.
 */
export function isValidAppId(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (id.startsWith('_')) return false;
  return /^[A-Za-z0-9_-]+$/.test(id);
}

/**
 * Resolve where an app's persistent runtime state lives: logs.jsonl,
 * settings.json, and the attachment blob CAS at `<appsDir>/<id>/` — the
 * stable per-app dir, kept separate from the git-store code worktree
 * (#137). App DATA lives in the vault (issue #286 phase 2).
 */
export function appDataDir(entry: RegistryEntry): string {
  return entry.path;
}
