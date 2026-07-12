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
 * The vault assistant's reserved conversation + blob-CAS scope. Real app
 * ids can never start with `_` (see `isValidAppId` above), so this
 * namespace is structurally collision-free: the assistant's threads and
 * attachment bytes ride the same per-vault ledger, blob CAS and HTTP
 * surface as app chats, scoped under this id. Lives here (rather than
 * `conversation/history.ts`, which re-exports it for back-compat) so the
 * blob store — which has no other reason to depend on the conversation
 * module — can allow it through its own `isValidAppId` gate without a
 * circular import.
 */
export const ASSISTANT_APP_ID = '_assistant';

/**
 * `isValidAppId`, plus the one reserved exception: the vault assistant's
 * `_assistant` scope. Used anywhere an app id gates a per-app resource
 * (blob CAS, conversation ledger) that the assistant also shares.
 */
export function isValidAppOrAssistantId(id: string): boolean {
  return id === ASSISTANT_APP_ID || isValidAppId(id);
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
