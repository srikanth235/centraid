// governance: allow-repo-hygiene file-size-limit (#439) the vault registry is one cohesive mount/lifecycle owner — scan, create, rename, delete, and now adopt (issue #439) all manipulate the same private plane map + auto-created-default set, so splitting the adopt seam into its own module would either expose that internal state across a boundary or duplicate the scan/delete plumbing it reuses
/*
 * The vault registry — the gateway's set of sovereign vaults under one root.
 *
 * Each vault is a `VaultPlane` in its own directory (`<root>/<vaultId>/`,
 * holding that vault's `vault.db` + `journal.db`); the vault's identity and
 * owner-facing name live inside its own `core_vault` row, so the registry
 * persists NOTHING at the root (issue #289 killed the `vaults.json` active
 * pointer — the client owns its pointer now).
 *
 * The registry is a warm map of mounted planes keyed by vaultId. Every
 * request resolves its vault via `current()` from the ambient request
 * context (see `vault-context.ts`); there is no server-global active seat,
 * so two clients on two vaults never disturb each other. Outside a scoped
 * request (tests, boot paths that predate scoping) `current()` falls back
 * to the default vault — the owner's PERSONAL vault, identified by a durable
 * marker in the vault itself, never by creation order (see `defaultVaultId`).
 *
 * Vault lifecycle is split by AUTHORITY, not by transport (issue #289,
 * corrected in #568 item J). `create` and `delete` are ADMIN acts, but they
 * are no longer CLI-only: a fresh data dir auto-creates its two vaults at
 * construction (issue #603), an admin device may create further ones, and the
 * erase ceremony (`vault-routes.ts`) deletes over HTTP behind the owner
 * enrollment + typed-name + verified-kit guards. What has not changed is that
 * neither is reachable by an ordinary enrolled device on ordinary authority.
 * `rename`/presentation remain plain owner acts on an enrolled vault.
 */

import { readdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

import type {
  RuntimeLogger,
  VaultBridge,
  VaultWorkspace,
} from "@centraid/app-engine";
import { uuidv7, VaultSchemaAheadError } from "@centraid/vault";
import type {
  BlobStoreSettings,
  S3Credentials,
  PreviewCodec,
  KeyStore,
} from "@centraid/vault";

import { vaultContext } from "./vault-context.js";
import type { InstallScopeBlock, VaultPlane } from "./vault-plane.js";
import { openVaultPlane } from "./vault-plane.js";

/**
 * Minimum time between retry attempts for a directory whose mount failed
 * (issue #351): `scan()` now runs on every `vaults` health probe tick (the
 * desktop polls `_gateway/health` every 15s — see `useGatewayHealth.ts`), so
 * without a backoff a permanently-broken directory would reopen its corrupt
 * SQLite file on every single poll forever. This caps that to roughly once
 * per backoff window; it is deliberately a flat window, not exponential —
 * v0 has no evidence a broken vault needs anything fancier.
 */
const MOUNT_RETRY_BACKOFF_MS = 30_000;

/** One directory the registry failed to mount, kept until it mounts clean or the dir goes away. */
export interface FailedMount {
  dir: string;
  /** The mount error's message, UNPREFIXED — this is shown to the owner verbatim (e.g. `VaultSchemaAheadError`'s upgrade-the-app copy). */
  message: string;
  /** ISO timestamp of the most recent failed attempt. */
  at: string;
  /**
   * Set when the failure was a `VaultSchemaAheadError` — a newer-software
   * backup restored onto older software. Callers may want to special-case
   * this (e.g. an "upgrade the app" affordance) rather than treat it as a
   * generic corruption error.
   */
  schemaAhead?: boolean;
}

interface FailedMountState {
  message: string;
  atMs: number;
  schemaAhead: boolean;
}

export interface VaultRegistryOptions {
  /** Root directory: one subdirectory per vault. */
  rootDir: string;
  /**
   * Root for per-vault DISPOSABLE runner cache (`<cacheRootDir>/<vaultId>/`),
   * kept OUTSIDE `rootDir` so the sovereign vault tree holds only the
   * `vault.db` + `journal.db` pair, app data, and code. Defaults to a sibling
   * of `rootDir` (`<rootDir>-cache`). journal.db is the source of truth; this
   * cache is derived and safe to wipe.
   */
  cacheRootDir?: string;
  logger: RuntimeLogger;
  /** Shared host custody store for every vault sealing key. */
  keyStore?: KeyStore;
  /** Owner display name used when bootstrapping fresh vaults. */
  ownerName?: string;
  /** Sweep cadence forwarded to every plane. */
  sweepIntervalMs?: number;
  /** False for admin/read-only opens that must never own or checkpoint WALs. */
  enableWalShipper?: boolean;
  /** Forwarded backup-destination predicate; it gates capture, never ownership. */
  walCaptureConfigured?: () => boolean;
  /** Fail-safe blob-GC gate for network filesystems. */
  skipOrphanDelete?: () => boolean;
  /** Forwarded to every plane (issue #367 §C3) — see `VaultPlaneOptions.s3Credentials`. */
  s3Credentials?: (settings: BlobStoreSettings) => Promise<S3Credentials>;
  /** Forwarded to every plane (issue #405 §2) — see `VaultPlaneOptions.previewCodec`. */
  previewCodec?: PreviewCodec;
  /** Forwarded to each plane after journal provenance commits. */
  onProvenanceCommitted?: (
    vaultId: string,
    entityTypes?: readonly string[]
  ) => void;
  /** Forwarded to each plane for the unified Notifications event/wake channel. */
  onNotificationsChanged?: (vaultId: string, wake: boolean) => void;
  /** SQLite durability selected by the gateway hardware profile. */
  synchronous?: "FULL" | "NORMAL";
  /** Global event-loop pressure gate forwarded to mounted planes. */
  shouldDeferBackgroundWork?: () => boolean;
  /** Concurrent remote pushes selected by the gateway hardware profile. */
  replicationConcurrency?: number;
  /** Resource-actuals sweep hook (#528 Phase C), forwarded to every plane. */
  onSweepPass?: (info: { durationMs: number }) => void;
  /** Resource-actuals replication hook (#528 Phase C), forwarded to every plane. */
  onReplicationPass?: (info: {
    bytesReplicated: number;
    durationMs: number;
  }) => void;
  /** Forwarded to every plane (issue #544) — see `VaultPlaneOptions.journalLimitBytes`. */
  journalLimitBytes?: () => number | null;
}

/** One row of the vault list. */
export interface VaultInfo {
  vaultId: string;
  name: string;
  ownerPartyId: string;
  /**
   * True for the owner's PERSONAL vault — the durable default marker written
   * at founding (`core_vault.settings_json.personal`). Absent on every other
   * vault, so clients can find "my own space" without matching a name that
   * the fresh path renames.
   */
  personal?: boolean;
  /** Presentation out of `core_vault.settings_json` (#280: profiles are vaults). */
  color?: string;
  icon?: string;
  blurb?: string;
}

/* eslint-disable max-classes-per-file -- error class is colocated with its module (#247) */
/** A refused registry act (delete the last vault, unknown id, …). */
export class VaultRegistryError extends Error {
  constructor(
    readonly code: "vault_not_found" | "bad_name",
    message: string
  ) {
    super(message);
    this.name = "VaultRegistryError";
  }
}

export class VaultRegistry {
  private readonly rootDir: string;
  private readonly cacheRootDir: string;
  private readonly logger: RuntimeLogger;
  private readonly ownerName: string | undefined;
  private readonly keyStore: KeyStore | undefined;
  private readonly sweepIntervalMs: number | undefined;
  private readonly enableWalShipper: boolean;
  private readonly walCaptureConfigured: (() => boolean) | undefined;
  private readonly skipOrphanDelete: (() => boolean) | undefined;
  private readonly s3Credentials:
    | ((settings: BlobStoreSettings) => Promise<S3Credentials>)
    | undefined;
  private readonly previewCodec: PreviewCodec | undefined;
  private readonly onProvenanceCommitted:
    | ((vaultId: string, entityTypes?: readonly string[]) => void)
    | undefined;
  private readonly onNotificationsChanged:
    | ((vaultId: string, wake: boolean) => void)
    | undefined;
  private readonly synchronous: "FULL" | "NORMAL" | undefined;
  private readonly shouldDeferBackgroundWork: (() => boolean) | undefined;
  private readonly replicationConcurrency: number | undefined;
  private readonly onSweepPass:
    | ((info: { durationMs: number }) => void)
    | undefined;
  private readonly onReplicationPass:
    | ((info: { bytesReplicated: number; durationMs: number }) => void)
    | undefined;
  private readonly journalLimitBytes: (() => number | null) | undefined;
  private readonly planes = new Map<string, VaultPlane>();
  private readonly mountListeners = new Set<(plane: VaultPlane) => void>();
  /** Directories already MOUNTED — lets `scan()` skip them cheaply on rescan. */
  private readonly scannedDirs = new Set<string>();
  /** Directories that failed to mount, keyed by dir (issue #351 — never silently dropped). */
  private readonly failedMountsByDir = new Map<string, FailedMountState>();
  private started = false;

  constructor(options: VaultRegistryOptions) {
    this.rootDir = options.rootDir;
    // Runner cache lives OUTSIDE the vault tree — default to a `-cache` sibling
    // of the vault root so a vault dir carries only sovereign + code state.
    this.cacheRootDir =
      options.cacheRootDir ??
      path.join(
        path.dirname(this.rootDir),
        `${path.basename(this.rootDir)}-cache`
      );
    this.logger = options.logger;
    this.keyStore = options.keyStore;
    this.ownerName = options.ownerName;
    this.sweepIntervalMs = options.sweepIntervalMs;
    this.enableWalShipper = options.enableWalShipper ?? true;
    this.walCaptureConfigured = options.walCaptureConfigured;
    this.skipOrphanDelete = options.skipOrphanDelete;
    this.s3Credentials = options.s3Credentials;
    this.previewCodec = options.previewCodec;
    this.onProvenanceCommitted = options.onProvenanceCommitted;
    this.onNotificationsChanged = options.onNotificationsChanged;
    this.synchronous = options.synchronous;
    this.shouldDeferBackgroundWork = options.shouldDeferBackgroundWork;
    this.replicationConcurrency = options.replicationConcurrency;
    this.onSweepPass = options.onSweepPass;
    this.onReplicationPass = options.onReplicationPass;
    this.journalLimitBytes = options.journalLimitBytes;
    // Zero-vault boot does not materialize `vault/`; the first create or
    // restore owns that transition.
    if (!existsSync(this.rootDir)) return;
    if (existsSync(path.join(this.rootDir, "vault.db"))) {
      // Pre-multi-vault layout (v0: no data migrations) — the files stay put
      // but are not mounted.
      this.logger.warn(
        `vault registry: ignoring legacy single-vault files at ${this.rootDir} — ` +
          "vaults now live one directory per vault"
      );
    }
    this.scan();
  }

  /**
   * Mount every `<root>/<dir>/vault.db` found on disk. Re-runnable: a vault
   * created by the admin CLI while the daemon is up is picked up on the
   * first request that names it (see `get()`), and the `vaults` health
   * probe calls this on every tick so a directory that failed to mount
   * (corrupt file, transient FS error) gets retried instead of vanishing
   * forever — see `MOUNT_RETRY_BACKOFF_MS` for why that retry is throttled.
   *
   * A dir is skipped only once it has a MOUNTED plane (`scannedDirs`); a
   * failed dir stays eligible for retry on every call, subject to backoff.
   */
  private scan(): void {
    if (!existsSync(this.rootDir)) return;
    const nowMs = Date.now();
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Ignore hidden/dot directories (issue #439 R1): `recover()` stages a
      // restore into `<root>/.recover-staging-<id>/` (same device, so the adopt
      // is an atomic rename) and that half-written dir carries a `vault.db` too
      // — mounting it mid-restore would be a torn vault. Real vaults are named
      // by UUIDv7 and never start with a dot, so this can only ever exclude
      // staging scratch.
      if (entry.name.startsWith(".")) continue;
      const dir = path.join(this.rootDir, entry.name);
      if (this.scannedDirs.has(dir)) continue;
      if (!existsSync(path.join(dir, "vault.db"))) continue;
      const priorFailure = this.failedMountsByDir.get(dir);
      if (priorFailure && nowMs - priorFailure.atMs < MOUNT_RETRY_BACKOFF_MS)
        continue;
      try {
        const plane = this.openPlane(dir, {});
        if (this.planes.has(plane.boot.vaultId)) {
          // A real conflict (two directories claiming the same vault id),
          // not a transient mount failure — record it so it surfaces in
          // `failedMounts()` too, but retrying won't fix it without an
          // operator moving/removing one of the directories.
          const message = `duplicate vault id ${plane.boot.vaultId} at ${dir} — skipped`;
          this.logger.warn(`vault registry: ${message}`);
          this.failedMountsByDir.set(dir, {
            message,
            atMs: nowMs,
            schemaAhead: false,
          });
          plane.stop();
          continue;
        }
        this.planes.set(plane.boot.vaultId, plane);
        this.scannedDirs.add(dir);
        this.failedMountsByDir.delete(dir);
        if (this.started) plane.start();
        this.notifyMounted(plane);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const schemaAhead =
          error instanceof VaultSchemaAheadError ||
          (error instanceof Error && error.name === "VaultSchemaAheadError");
        this.failedMountsByDir.set(dir, { message, atMs: nowMs, schemaAhead });
        this.logger.warn(
          `vault registry: could not mount vault at ${dir}: ${message}`
        );
      }
    }
  }

  /** Directories the registry could not mount, most recently failed first (issue #351). */
  failedMounts(): FailedMount[] {
    return [...this.failedMountsByDir.entries()]
      .sort((a, b) => b[1].atMs - a[1].atMs)
      .map(([dir, state]) => ({
        dir,
        message: state.message,
        at: new Date(state.atMs).toISOString(),
        ...(state.schemaAhead ? { schemaAhead: true } : {}),
      }));
  }

  /** Re-scan the vault root now — retries any previously-failed mount past its backoff window. */
  rescan(): void {
    this.scan();
  }

  /** Observe vaults mounted after registration (admin create or recovery). */
  onMount(listener: (plane: VaultPlane) => void): () => void {
    this.mountListeners.add(listener);
    return () => this.mountListeners.delete(listener);
  }

  private notifyMounted(plane: VaultPlane): void {
    for (const listener of this.mountListeners) {
      try {
        listener(plane);
      } catch {
        // Follow-up host work cannot roll back a successful durable mount.
      }
    }
  }

  /**
   * Whether this data dir has never held a vault — the one input to the
   * auto-found decision (issue #603). The filesystem registry is the only
   * authority; there is deliberately no `vaults` table to disagree with it.
   * A vault directory that failed to mount is still a vault for this gate:
   * corruption or a missing custody key must never make an existing gateway
   * look fresh and get founded over its own data.
   */
  isFresh(): boolean {
    if (this.planes.size > 0) return false;
    if (!existsSync(this.rootDir)) return true;
    return !readdirSync(this.rootDir, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        existsSync(path.join(this.rootDir, entry.name, "vault.db"))
    );
  }

  /** Canonical registry root on disk. */
  rootPath(): string {
    return this.rootDir;
  }

  /**
   * Adopt a recovered vault directory as a live vault (issue #439 R1 — the
   * live-gateway path wave 4's `/recover` routes call after `recover()` has
   * renamed its staging dir into place). The directory `<root>/<vaultId>` MUST
   * already exist on disk; this mounts it (`scan`). Recovery runs against a
   * data dir the operator brought, so no cleanup heuristic is needed here.
   */
  adopt(vaultId: string): VaultInfo {
    this.scan();
    const plane = this.planes.get(vaultId);
    if (!plane) {
      throw new VaultRegistryError(
        "vault_not_found",
        `adopt: no vault mounted at "${vaultId}" — is its directory in place under the root?`
      );
    }
    return this.info(plane);
  }

  private openPlane(
    dir: string,
    boot: { vaultId?: string; vaultName?: string }
  ): VaultPlane {
    return openVaultPlane({
      dir,
      // Vault dir name IS the vault id (create() names it so), so the cache
      // dir keys per-vault without needing the bootstrapped id up front.
      cacheDir: path.join(this.cacheRootDir, path.basename(dir)),
      logger: this.logger,
      ...(this.keyStore ? { keyStore: this.keyStore } : {}),
      ...(this.ownerName ? { ownerName: this.ownerName } : {}),
      ...(boot.vaultId ? { bootstrap: true } : {}),
      ...(this.sweepIntervalMs === undefined
        ? {}
        : { sweepIntervalMs: this.sweepIntervalMs }),
      enableWalShipper: this.enableWalShipper,
      ...(this.walCaptureConfigured
        ? { walCaptureConfigured: this.walCaptureConfigured }
        : {}),
      ...(this.skipOrphanDelete
        ? { skipOrphanDelete: this.skipOrphanDelete }
        : {}),
      ...(this.s3Credentials ? { s3Credentials: this.s3Credentials } : {}),
      ...(this.previewCodec ? { previewCodec: this.previewCodec } : {}),
      ...(this.onProvenanceCommitted
        ? { onProvenanceCommitted: this.onProvenanceCommitted }
        : {}),
      ...(this.onNotificationsChanged
        ? { onNotificationsChanged: this.onNotificationsChanged }
        : {}),
      ...(this.synchronous ? { synchronous: this.synchronous } : {}),
      ...(this.shouldDeferBackgroundWork
        ? { shouldDeferBackgroundWork: this.shouldDeferBackgroundWork }
        : {}),
      ...(this.replicationConcurrency === undefined
        ? {}
        : { replicationConcurrency: this.replicationConcurrency }),
      ...(this.onSweepPass ? { onSweepPass: this.onSweepPass } : {}),
      ...(this.onReplicationPass
        ? { onReplicationPass: this.onReplicationPass }
        : {}),
      ...(this.journalLimitBytes
        ? { journalLimitBytes: this.journalLimitBytes }
        : {}),
      ...boot,
    });
  }

  private info(plane: VaultPlane): VaultInfo {
    const presentation = plane.presentation;
    return {
      vaultId: plane.boot.vaultId,
      name: plane.name,
      ownerPartyId: plane.boot.ownerPartyId,
      ...(plane.personal ? { personal: true } : {}),
      ...(presentation.color ? { color: presentation.color } : {}),
      ...(presentation.icon ? { icon: presentation.icon } : {}),
      ...(presentation.blurb ? { blurb: presentation.blurb } : {}),
    };
  }

  /**
   * The default vault — the owner's PERSONAL vault, never the shared one.
   *
   * The signal is the durable `personal` marker written into the vault's own
   * `core_vault.settings_json` at founding, NOT creation order and NOT the
   * name: ids are UUIDv7 so "oldest" is Shared (founded first), and the
   * desktop fresh path renames the personal vault to the owner's display
   * name. Ties (a data dir with several marked vaults — restore edge) resolve
   * oldest-first; a registry with no marked vault at all (pre-marker dev data,
   * or a household that erased its personal vault) falls back to the oldest,
   * which is the previous behaviour.
   *
   * The fallback for unscoped callers only; a scoped request names its vault.
   */
  defaultVaultId(): string {
    const chosen = this.defaultVaultIdOrUndefined();
    if (chosen === undefined)
      throw new Error("vault registry: no vault mounted");
    return chosen;
  }

  /**
   * `defaultVaultId()` without the throw — for seams that must survive a
   * gateway whose every vault was erased (the pairing-ticket mint target).
   */
  defaultVaultIdOrUndefined(): string | undefined {
    const ids = [...this.planes.keys()].sort();
    return ids.find((id) => this.planes.get(id)?.personal === true) ?? ids[0];
  }

  /**
   * The vault the CURRENT request (or background fire) is addressed to,
   * resolved from the ambient context (issue #289). Falls back to the
   * default vault outside a scoped request.
   */
  current(): VaultPlane {
    const ctx = vaultContext();
    const vaultId = ctx?.vaultId ?? this.defaultVaultId();
    const plane = this.get(vaultId);
    if (!plane)
      throw new VaultRegistryError(
        "vault_not_found",
        `unknown vault "${vaultId}"`
      );
    return plane;
  }

  /** The current request's workspace — the world app-engine operates in. */
  currentWorkspace(): VaultWorkspace {
    return this.current().workspace;
  }

  /** Resolve one vault by id — `undefined` when unknown. Rescans once on miss. */
  get(vaultId: string): VaultPlane | undefined {
    const mounted = this.planes.get(vaultId);
    if (mounted) return mounted;
    // Miss → the admin CLI may have created it while we run; rescan once.
    this.scan();
    return this.planes.get(vaultId);
  }

  /**
   * Every mounted vault the CLIENT sees — DEFAULT VAULT FIRST, then the rest
   * oldest-first (issue #665).
   *
   * This is the single choke point every client-facing vault listing goes
   * through (`GET /_vault/vaults` via `vault-routes.ts`, and the member scopes
   * plane `GET /_vault/scopes` via `build-gateway.ts`'s `listVaults` dep), so
   * the two can never disagree about which vault heads the list.
   *
   * WHY THE HEAD IS NOT JUST THE OLDEST. Ids are UUIDv7, so plain
   * lexicographic order IS creation order, and the auto-found bootstrap
   * (#603) founds `Shared` before the personal vault — so oldest-first put
   * `Shared` at the head of every list. Clients treat the first row as
   * PRIMARY (`useMemberScopes.ts` takes `scopes[0]`), which put them on a
   * different vault than the gateway's own `defaultVaultId()`. Hoisting the
   * default vault settles that disagreement in one place.
   *
   * The head is `defaultVaultIdOrUndefined()` — the same durable `personal`
   * marker the rest of the gateway trusts, never the literal name "Personal"
   * (the desktop fresh path renames it to the owner's display name). With no
   * marked vault (pre-marker data dirs, an erased personal vault) that seam
   * already answers "oldest", so the order is byte-for-byte the previous
   * behaviour. Total and stable either way.
   */
  list(): VaultInfo[] {
    return this.listedIds().map((id) => this.info(this.planes.get(id)!));
  }

  /** Mounted ids in client-listing order: default vault first, then oldest-first. */
  private listedIds(): string[] {
    const ids = [...this.planes.keys()].sort();
    const head = this.defaultVaultIdOrUndefined();
    if (head === undefined || ids[0] === head) return ids;
    return [head, ...ids.filter((id) => id !== head)];
  }

  /**
   * Every mounted plane, oldest first (boot activation iterates these).
   *
   * Deliberately NOT reordered like `list()`: no caller here renders a list or
   * reads element 0 as "primary" — they start, sweep, drain, or diagnose every
   * plane — so creation order stays the stable iteration order for background
   * work, and the default-first hoist is confined to the client wire (#665).
   */
  planesList(): VaultPlane[] {
    return [...this.planes.keys()].sort().map((id) => this.planes.get(id)!);
  }

  /**
   * Create (and mount) a fresh vault. ADMIN act: the CLI, the auto-found
   * bootstrap a fresh data dir runs at construction (#603), or an admin
   * device over HTTP. Never reachable on ordinary device authority.
   *
   * `personal: true` stamps the durable default marker (see `VaultInfo.personal`
   * and `defaultVaultId()`); only the auto-found bootstrap passes it.
   */
  create(name?: string, options?: { personal?: boolean }): VaultInfo {
    const trimmed = name?.trim();
    if (trimmed !== undefined && trimmed.length === 0) {
      throw new VaultRegistryError("bad_name", "a vault name cannot be empty");
    }
    const vaultId = uuidv7();
    const dir = path.join(this.rootDir, vaultId);
    const plane = this.openPlane(dir, {
      vaultId,
      ...(trimmed ? { vaultName: trimmed } : {}),
    });
    if (options?.personal) plane.markPersonal();
    this.scannedDirs.add(dir);
    this.planes.set(plane.boot.vaultId, plane);
    if (this.started) plane.start();
    this.notifyMounted(plane);
    this.logger.info(
      `vault registry: created vault ${plane.boot.vaultId} ("${plane.name}")`
    );
    return this.info(plane);
  }

  /** Rename one vault (owner act on its own `core_vault` row). */
  rename(vaultId: string, name: string): VaultInfo {
    const plane = this.require(vaultId);
    const trimmed = name.trim();
    if (trimmed.length === 0)
      throw new VaultRegistryError("bad_name", "a vault name cannot be empty");
    plane.rename(trimmed);
    return this.info(plane);
  }

  /** Merge a presentation patch into one vault (owner act, #280). */
  updatePresentation(
    vaultId: string,
    patch: Partial<Record<"color" | "icon" | "blurb", string | null>>
  ): VaultInfo {
    const plane = this.require(vaultId);
    plane.updatePresentation(patch);
    return this.info(plane);
  }

  /**
   * Delete a vault: plane stopped, its directory (both SQLite files, the
   * blob CAS and the appext exports under it) removed, and any remote blob
   * tier purged best-effort (issue #296 — deleting a vault must not leave
   * the owner's bytes billing in a bucket forever; a crash here costs
   * orphan objects, which any later reconcile against the empty set finds).
   * ADMIN act: the CLI, or the erase ceremony over HTTP behind the owner
   * enrollment, typed-name confirmation, and verified-kit guards (#568 item
   * J — this is no longer CLI-only).
   *
   * This registry owns content deletion only. The erase ceremony's durable
   * state machine owns crypto-erasure through KeyStore after its gateway rows
   * commit; restore rollback callers likewise destroy keys explicitly.
   */
  delete(vaultId: string): void {
    const plane = this.require(vaultId);
    // The remote tier resolves synchronously inside purgeRemote — BEFORE
    // stop() closes the db handles — and the deletes then run detached:
    // remote latency must not block the admin act.
    const purge = plane.db.blobs.purgeRemote();
    plane.stop();
    this.planes.delete(vaultId);
    this.scannedDirs.delete(plane.dir);
    this.failedMountsByDir.delete(plane.dir);
    rmSync(plane.dir, { recursive: true, force: true });
    // Drop the vault's disposable runner cache too (it lives outside the
    // vault dir, so the rmSync above doesn't reach it).
    rmSync(plane.cacheDir, { recursive: true, force: true });
    if (existsSync(this.rootDir) && readdirSync(this.rootDir).length === 0) {
      rmSync(this.rootDir, { recursive: true, force: true });
    }
    if (
      existsSync(this.cacheRootDir) &&
      readdirSync(this.cacheRootDir).length === 0
    ) {
      rmSync(this.cacheRootDir, { recursive: true, force: true });
    }
    void purge
      .then((shas) => {
        if (shas.length > 0) {
          this.logger.info(
            `vault registry: purged ${shas.length} remote blob(s) of deleted vault ${vaultId}`
          );
        }
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `vault registry: remote blob purge for deleted vault ${vaultId} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    this.logger.info(
      `vault registry: deleted vault ${vaultId} ("${plane.name}")`
    );
  }

  private require(vaultId: string): VaultPlane {
    const plane = this.get(vaultId);
    if (!plane)
      throw new VaultRegistryError(
        "vault_not_found",
        `unknown vault "${vaultId}"`
      );
    return plane;
  }

  /**
   * The app-plane `ctx.vault` executor: every call rides the vault the
   * CURRENT request is addressed to, with the app's identity ensured there
   * first (identity only — grants stay per vault, deny-by-default).
   */
  bridgeFor(appId: string): VaultBridge {
    return async (call) => {
      const plane = this.current();
      plane.enrollApp(appId);
      return plane.bridgeFor(appId)(call);
    };
  }

  /** The agent-plane mirror of `bridgeFor` for automation fires. */
  agentBridgeFor(appId: string, block?: InstallScopeBlock): VaultBridge {
    return async (call) => {
      const plane = this.current();
      plane.enrollAutomationAgent(appId);
      return plane.agentBridgeFor(appId, block)(call);
    };
  }

  /** The scenario-seed executor against the ACTIVE vault (issue #290). */
  demoBridgeFor(appId: string): VaultBridge {
    return async (call) => this.current().demoBridgeFor(appId)(call);
  }

  /**
   * Enroll a live app in the current request's vault (identity only).
   * Post-#280 an app is a vault asset — it lives in one vault's code store
   * and is enrolled there alone, so `consent.app` governs the vault's OWN apps.
   */
  enrollApp(appId: string): void {
    this.current().enrollApp(appId);
  }

  /** Enroll an automation's acting identity in the current request's vault. */
  enrollAutomationAgent(appId: string, displayName?: string): void {
    this.current().enrollAutomationAgent(appId, displayName);
  }

  /** Uninstall cascade in the current request's vault (the app lives nowhere else). */
  revokeApp(appId: string): { grantsRevoked: number } {
    return this.current().revokeApp(appId);
  }

  /** Start every plane's standing-duty clock; new vaults start on creation. */
  start(): void {
    this.started = true;
    for (const plane of this.planes.values()) plane.start();
  }

  /** Stop every plane (sweep clocks down, WALs checkpointed, files closed). */
  stop(): void {
    this.started = false;
    for (const plane of this.planes.values()) plane.stop();
  }
}

export function openVaultRegistry(
  options: VaultRegistryOptions
): VaultRegistry {
  return new VaultRegistry(options);
}
