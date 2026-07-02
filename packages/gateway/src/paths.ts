/*
 * `GatewayPaths` — the on-disk slots a gateway runtime reads/writes.
 *
 * The caller (Electron desktop, the standalone daemon, or a test) is
 * responsible for *deriving* these paths from its own root layout. This
 * package never reaches for Electron's `app.getPath('userData')` or any
 * env-var convention; it just consumes absolute paths.
 *
 * All paths are absolute. None need to exist before `serve()` is called —
 * the runtime mkdirs `appsDir` on bootstrap and the store providers open
 * their SQLite files lazily on first use.
 */

export interface GatewayPaths {
  /**
   * Directory holding registered apps + `_registry.json`. The runtime
   * reads/writes app code, versions, and per-app `data.sqlite` here.
   */
  appsDir: string;

  /**
   * Identity SQLite path — users + per-user prefs (theme, density, runner
   * choice, provider config, …). Wraps a lazy provider so the file is
   * only opened when a store needs it.
   */
  identityDb: string;

  /**
   * Analytics SQLite path — one summary row per run (chat turn,
   * automation fire). Powers the Insights screen.
   */
  analyticsDb: string;

  /**
   * Scratch base dir for the chat runner's per-session state files. The
   * `POST /centraid/<id>/_turn` route passes `<dir>/<conversationId>.jsonl` as
   * `ConversationTurnInput.sessionFile`.
   */
  conversationRunnerSessionDir: string;

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
   * templates shadow the bundle. The desktop used to run this fetch in its
   * own main process before serving the catalog moved here; folding it into
   * the gateway lets the desktop drop its `@centraid/blueprints`
   * dependency entirely. Omit for bundle/cache-only resolution.
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

  /**
   * Optional personal-vault directory (duaility §12). When set, the gateway
   * mounts the vault plane: `vault.db` + `journal.db` live here, live apps
   * are enrolled as `consent.app` rows, handlers get the consent-checked
   * `ctx.vault` primitive, and the owner consent surface is served under
   * `/centraid/_vault/*`. Omit to run without a vault — `ctx.vault` calls
   * then fail closed with VAULT_UNAVAILABLE.
   */
  vaultDir?: string;
}
