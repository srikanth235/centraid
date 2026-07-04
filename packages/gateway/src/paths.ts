/*
 * `GatewayPaths` — the on-disk slots a gateway runtime reads/writes.
 *
 * The caller (Electron desktop, the standalone daemon, or a test) is
 * responsible for *deriving* these paths from its own root layout. This
 * package never reaches for Electron's `app.getPath('userData')` or any
 * env-var convention; it just consumes absolute paths.
 *
 * Issue #280 — the vault is the unit. Everything personal lives INSIDE a
 * vault's directory (`<vaultDir>/<vaultId>/`): the ontology pair
 * (`vault.db` + `journal.db`), the conversation ledger + run rollup
 * (`transcripts.db`), the per-app data dirs (`apps/`), the app code store
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
   * workspace (`transcripts.db`, `apps/`, `code/`, `runner-sessions/`);
   * exactly one vault is active at a time (pointer in
   * `<vaultDir>/vaults.json`). Required — post-#280 the app surface IS
   * vault-scoped, so a gateway without vaults has nothing to serve.
   */
  vaultDir: string;

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
   * Omit to enumerate without persistence (e.g. the OpenClaw plugin, which
   * supplies its own `runnerStatus`); there is no hardcoded default seed.
   */
  modelCatalogFile?: string;
}
