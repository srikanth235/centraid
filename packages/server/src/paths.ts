/*
 * `GatewayPaths` — the on-disk slots a gateway runtime reads and writes.
 *
 * The caller derives these from its own root layout; this package never
 * reaches for Electron's `userData` or an env-var convention, it consumes
 * absolute paths. All are absolute, and none need exist before `serve()`:
 * a zero-vault registry is legal and stores open lazily.
 *
 * The vault is the unit (#280): everything personal lives inside
 * `<vaultDir>/<vaultId>/` — the sovereign file (`vault.db`, the one file since
 * #916),
 * `apps/`, and the `code/` git store. Gateway state is `gateway.db`, secrets
 * are KeyStore envelopes under `keys/`, and cache and logs are separate
 * disposable directories.
 */

export interface GatewayPaths {
  /** Defaults to the parent of `vaultDir` for legacy callers. */
  dataDir?: string;
  /**
   * The personal-vault root (duaility §12, #280): one subdirectory per vault,
   * exactly one active at a time (pointer in `<vaultDir>/vaults.json`).
   * Required — post-#280 the app surface IS vault-scoped.
   */
  vaultDir: string;

  /**
   * Root for the per-vault DISPOSABLE harness cache
   * (`<cacheDir>/<vaultId>/harness-sessions/`). Kept OUTSIDE `vaultDir` so the
   * sovereign tree holds only the vault file, app data, and code: this cache is
   * derived, safe to wipe, and never backed up. Omit for a `-cache` sibling.
   */
  cacheDir?: string;

  /**
   * Per-gateway template cache (#141). Set makes `GET /centraid/_templates`
   * resolve bundle-or-cache, so a newer copy shadows the bundled one; omit for
   * bundle-only resolution.
   */
  templatesCacheDir?: string;

  /**
   * Gateway-owned model catalog (#188). Set persists the chat picker's
   * per-harness model list; omit to enumerate without persistence. There is no
   * hardcoded default seed.
   */
  modelCatalogFile?: string;

  /**
   * Disk-cached model PRICE table (#445), kept fresh on a 24h TTL. Omit for a
   * sibling of `modelCatalogFile`; without either, the warmer stays in-memory
   * and costing falls back to the bundled snapshot.
   */
  modelPricingFile?: string;

  /**
   * Rotated JSONL persistence for the log ring (#351). NO implicit default
   * sibling: omitting it keeps `GatewayLogStore` in-memory-only, which is what
   * tests and disposable embeds want. A host opts in by naming a directory.
   */
  logsDir?: string;
}
