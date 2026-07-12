/*
 * `GatewayPaths` — the on-disk slots a gateway runtime reads/writes.
 *
 * The caller (Electron desktop, the standalone daemon, or a test) is
 * responsible for *deriving* these paths from its own root layout. This
 * package never reaches for Electron's `app.getPath('userData')` or any
 * env-var convention; it just consumes absolute paths.
 *
 * Issue #280 — the vault is the unit. Everything personal lives INSIDE a
 * vault's directory (`<vaultDir>/<vaultId>/`): the sovereign pair
 * (`vault.db` + `journal.db` — the journal carrying both the audit stream
 * and the conversation ledger + run rollup, the old `transcripts.db`
 * folded in), the per-app data dirs (`apps/`), the app code store
 * (`code/` — a bare git repo + worktrees), and the chat runner scratch
 * (`runner-sessions/`). What remains at the gateway level is plumbing:
 * the vault registry root, a device-prefs JSON file, the model catalog,
 * and the template cache.
 *
 * All paths are absolute. None need to exist before `serve()` is called —
 * the registry bootstraps a default vault and the store providers open
 * their files lazily on first use.
 */

export interface GatewayPaths {
  /**
   * The personal-vault root (duaility §12, #280). The gateway mounts the
   * vault registry here: each vault lives in its own subdirectory holding
   * BOTH the sovereign pair (`vault.db` + `journal.db`) and the vault's
   * workspace (`apps/`, `code/`; the conversation ledger rides the journal
   * file); exactly one vault is active at a time (pointer in
   * `<vaultDir>/vaults.json`). The chat runner scratch (`runner-sessions/`)
   * does NOT live here — it is disposable cache under `cacheDir`. Required —
   * post-#280 the app surface IS vault-scoped, so a gateway without vaults
   * has nothing to serve.
   */
  vaultDir: string;

  /**
   * Optional root for the per-vault DISPOSABLE runner cache
   * (`<cacheDir>/<vaultId>/runner-sessions/`) — the embedded chat runner's
   * per-conversation resume files and scratch cwd. Kept OUTSIDE `vaultDir` so
   * the sovereign vault tree holds only `vault.db` + `journal.db`, app data,
   * and code; journal.db is the authoritative conversation ledger and this
   * cache is derived, safe to wipe, and never backed up with the vault. Omit
   * to default to a `-cache` sibling of `vaultDir`; a host may point it at an
   * OS cache location instead.
   */
  cacheDir?: string;

  /**
   * Device-prefs JSON file (`prefs.json`) — runner choice, binary path,
   * UI theme for this host. The old `identity.sqlite` (users + user_prefs)
   * is gone (#280): the vault owner is the user, and what's left at the
   * gateway is device configuration.
   */
  prefsFile: string;

  /**
   * Optional per-gateway template cache dir (issue #141). When set, the
   * `GET /centraid/_templates` route resolves bundle-or-cache, letting a
   * newer template pulled from a remote URL shadow the bundled copy. Omit
   * for bundle-only resolution (the standalone daemon / tests).
   */
  templatesCacheDir?: string;

  /**
   * Optional remote template manifest URL (issue #141, Phase 5). When set
   * alongside `templatesCacheDir`, the gateway refreshes the cache from this
   * URL once on startup (best-effort, never throws) so newer remote
   * templates shadow the bundle. Omit for bundle/cache-only resolution.
   */
  remoteTemplatesUrl?: string;

  /**
   * Optional path to the gateway-owned model catalog (`model-catalog.json`,
   * issue #188). When set, the default `runnerStatus` reporter persists the
   * chat picker's per-runner model list here and re-enumerates it on Refresh.
   * Omit to enumerate without persistence; there is no hardcoded default seed.
   */
  modelCatalogFile?: string;

  /**
   * Optional root for the offsite backup engine's own state
   * (`keyring.json`, `state.json`, `staging/`) — kept OUTSIDE `vaultDir` so
   * a raw copy of the vault tree never carries the backup keyring (the
   * data-encryption key for every snapshot, FORMAT.md § Key custody).
   * Required for `buildGateway` to construct a `BackupService` when
   * `BuildGatewayOptions.backup?.enabled` — omit to default to a `backup`
   * sibling of `vaultDir`.
   */
  backupDir?: string;

  /**
   * Optional directory for rotated JSONL persistence of the gateway's
   * log ring (issue #351 — "logs don't survive restart, exactly when
   * you want a post-mortem"). Unlike `backupDir`, this has NO implicit
   * default sibling: omitting it keeps `GatewayLogStore` in-memory-only
   * (today's behavior), which is what tests and disposable embeds want.
   * A host opts in by pointing this at a real directory (e.g. a
   * `gateway-logs` sibling of `vaultDir`).
   */
  logsDir?: string;

  /**
   * Optional root for gateway-level storage state (issue #367 §C1/§C10):
   * the `storage-connections` entity (`connections.json` + its dedicated
   * seal key, `storage-connections.ts`) and the recovery-kit confirmation
   * flag (`recovery-kit.json`, generalized off the backup-only field it
   * started as). Kept OUTSIDE `vaultDir` for the same reason `backupDir`
   * is — this is gateway plumbing, not vault content, and must never ride
   * a raw copy of a vault directory. Omit to default to a `storage`
   * sibling of `vaultDir`.
   */
  storageDir?: string;
}
