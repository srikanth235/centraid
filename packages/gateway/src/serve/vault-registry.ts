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
 * to the default vault — the oldest one.
 *
 * Vault lifecycle is split across two planes (issue #289): create/delete are
 * ADMIN acts (the server CLI, guarded by shell access — they no longer ride
 * HTTP); rename/presentation are owner acts on an enrolled vault.
 */

import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  uuidv7,
  VaultSchemaAheadError,
  type BlobStoreSettings,
  type S3Credentials,
  type PreviewCodec,
} from '@centraid/vault';
import type { RuntimeLogger, VaultBridge, VaultWorkspace } from '@centraid/app-engine';
import { openVaultPlane, VaultPlane } from './vault-plane.js';
import { vaultContext } from './vault-context.js';

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
  /** Owner display name used when bootstrapping fresh vaults. */
  ownerName?: string;
  /** Sweep cadence forwarded to every plane. */
  sweepIntervalMs?: number;
  /** False for admin/read-only opens that must never own or checkpoint WALs. */
  enableWalShipper?: boolean;
  /** Forwarded to every plane (issue #367 §C6) — see `VaultPlaneOptions.leaseConflicted`. */
  leaseConflicted?: () => boolean;
  /** Forwarded to every plane (issue #367 §C3) — see `VaultPlaneOptions.s3Credentials`. */
  s3Credentials?: (settings: BlobStoreSettings) => Promise<S3Credentials>;
  /** Forwarded to every plane (issue #405 §2) — see `VaultPlaneOptions.previewCodec`. */
  previewCodec?: PreviewCodec;
}

/** One row of the vault list. */
export interface VaultInfo {
  vaultId: string;
  name: string;
  ownerPartyId: string;
  /** Presentation out of `core_vault.settings_json` (#280: profiles are vaults). */
  color?: string;
  icon?: string;
  blurb?: string;
}

/* eslint-disable max-classes-per-file -- error class is colocated with its module (#247) */
/** A refused registry act (delete the last vault, unknown id, …). */
export class VaultRegistryError extends Error {
  constructor(
    readonly code: 'vault_not_found' | 'vault_last' | 'bad_name',
    message: string,
  ) {
    super(message);
    this.name = 'VaultRegistryError';
  }
}

export class VaultRegistry {
  private readonly rootDir: string;
  private readonly cacheRootDir: string;
  private readonly logger: RuntimeLogger;
  private readonly ownerName: string | undefined;
  private readonly sweepIntervalMs: number | undefined;
  private readonly enableWalShipper: boolean;
  private readonly leaseConflicted: (() => boolean) | undefined;
  private readonly s3Credentials:
    | ((settings: BlobStoreSettings) => Promise<S3Credentials>)
    | undefined;
  private readonly previewCodec: PreviewCodec | undefined;
  private readonly planes = new Map<string, VaultPlane>();
  /**
   * Vault ids THIS registry auto-created on an empty root at construction
   * (issue #439 R1) — never an admin `create(name)`. The airtight signal
   * `adopt()` uses to know a sibling default is provably pristine (minted by
   * us, never served a request) and safe to remove so a recovered vault can
   * stand alone.
   */
  private readonly autoCreatedDefaults = new Set<string>();
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
      path.join(path.dirname(this.rootDir), `${path.basename(this.rootDir)}-cache`);
    this.logger = options.logger;
    this.ownerName = options.ownerName;
    this.sweepIntervalMs = options.sweepIntervalMs;
    this.enableWalShipper = options.enableWalShipper ?? true;
    this.leaseConflicted = options.leaseConflicted;
    this.s3Credentials = options.s3Credentials;
    this.previewCodec = options.previewCodec;
    mkdirSync(this.rootDir, { recursive: true });
    if (existsSync(path.join(this.rootDir, 'vault.db'))) {
      // Pre-multi-vault layout (v0: no data migrations) — the files stay put
      // but are not mounted; a fresh default vault is bootstrapped beside them.
      this.logger.warn(
        `vault registry: ignoring legacy single-vault files at ${this.rootDir} — ` +
          'vaults now live one directory per vault',
      );
    }
    this.scan();
    if (this.planes.size === 0) {
      // Record the bootstrap default as auto-created — the ONLY id `adopt()`
      // may later remove to let a recovered vault stand alone (issue #439 R1).
      this.autoCreatedDefaults.add(this.create().vaultId);
    }
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
    const nowMs = Date.now();
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Ignore hidden/dot directories (issue #439 R1): `recover()` stages a
      // restore into `<root>/.recover-staging-<id>/` (same device, so the adopt
      // is an atomic rename) and that half-written dir carries a `vault.db` too
      // — mounting it mid-restore would be a torn vault. Real vaults are named
      // by UUIDv7 and never start with a dot, so this can only ever exclude
      // staging scratch.
      if (entry.name.startsWith('.')) continue;
      const dir = path.join(this.rootDir, entry.name);
      if (this.scannedDirs.has(dir)) continue;
      if (!existsSync(path.join(dir, 'vault.db'))) continue;
      const priorFailure = this.failedMountsByDir.get(dir);
      if (priorFailure && nowMs - priorFailure.atMs < MOUNT_RETRY_BACKOFF_MS) continue;
      try {
        const plane = this.openPlane(dir, {});
        if (this.planes.has(plane.boot.vaultId)) {
          // A real conflict (two directories claiming the same vault id),
          // not a transient mount failure — record it so it surfaces in
          // `failedMounts()` too, but retrying won't fix it without an
          // operator moving/removing one of the directories.
          const message = `duplicate vault id ${plane.boot.vaultId} at ${dir} — skipped`;
          this.logger.warn(`vault registry: ${message}`);
          this.failedMountsByDir.set(dir, { message, atMs: nowMs, schemaAhead: false });
          plane.stop();
          continue;
        }
        this.planes.set(plane.boot.vaultId, plane);
        this.scannedDirs.add(dir);
        this.failedMountsByDir.delete(dir);
        if (this.started) plane.start();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const schemaAhead =
          err instanceof VaultSchemaAheadError ||
          (err instanceof Error && err.name === 'VaultSchemaAheadError');
        this.failedMountsByDir.set(dir, { message, atMs: nowMs, schemaAhead });
        this.logger.warn(`vault registry: could not mount vault at ${dir}: ${message}`);
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

  /**
   * Adopt a recovered vault directory as a live vault (issue #439 R1 — the
   * live-gateway path wave 4's `/recover` routes call after `recover()` has
   * renamed its staging dir into place). The directory `<root>/<vaultId>` MUST
   * already exist on disk; this mounts it (`scan`) and, when this registry
   * bootstrapped a pristine default onto an empty root, removes that default so
   * the recovered vault stands alone.
   *
   * "Effective default" — what `defaultVaultId()` returns — is purely the
   * oldest vaultId (UUIDv7 encodes creation time), and a recovered vault was
   * minted on the ORIGINAL machine before this blank gateway existed, so it is
   * always older than a just-auto-created default and wins that ordering on its
   * own. The removal below is therefore cleanliness, not correctness, and it is
   * gated on an AIRTIGHT signal: the sibling is one THIS registry auto-created
   * on an empty root (`autoCreatedDefaults`) and so has provably never held user
   * content (adopt runs during recovery, before the gateway serves a request).
   * A vault the operator created by hand, or any vault carrying data, is never
   * touched — recovery must never delete something with user content.
   */
  adopt(vaultId: string): VaultInfo {
    this.scan();
    const plane = this.planes.get(vaultId);
    if (!plane) {
      throw new VaultRegistryError(
        'vault_not_found',
        `adopt: no vault mounted at "${vaultId}" — is its directory in place under the root?`,
      );
    }
    // Collect the pristine auto-created siblings up front (a fresh array from
    // `list()`), THEN delete — never mutate `this.planes` mid-iteration.
    const pristineSiblings = this.list()
      .map((info) => info.vaultId)
      .filter((id) => id !== vaultId && this.autoCreatedDefaults.has(id));
    for (const id of pristineSiblings) {
      // `delete()` refuses the last vault; the recovered plane keeps size >= 2,
      // so removing a provably-pristine auto default here is always allowed.
      if (this.planes.size <= 1) break;
      this.logger.info(
        `vault registry: adopt(${vaultId}) — removing the pristine auto-created default ` +
          `${id} so the recovered vault is the effective default`,
      );
      this.delete(id);
    }
    return this.info(plane);
  }

  private openPlane(dir: string, boot: { vaultId?: string; vaultName?: string }): VaultPlane {
    return openVaultPlane({
      dir,
      // Vault dir name IS the vault id (create() names it so), so the cache
      // dir keys per-vault without needing the bootstrapped id up front.
      cacheDir: path.join(this.cacheRootDir, path.basename(dir)),
      logger: this.logger,
      ...(this.ownerName ? { ownerName: this.ownerName } : {}),
      ...(this.sweepIntervalMs !== undefined ? { sweepIntervalMs: this.sweepIntervalMs } : {}),
      enableWalShipper: this.enableWalShipper,
      ...(this.leaseConflicted ? { leaseConflicted: this.leaseConflicted } : {}),
      ...(this.s3Credentials ? { s3Credentials: this.s3Credentials } : {}),
      ...(this.previewCodec ? { previewCodec: this.previewCodec } : {}),
      ...boot,
    });
  }

  private info(plane: VaultPlane): VaultInfo {
    const presentation = plane.presentation;
    return {
      vaultId: plane.boot.vaultId,
      name: plane.name,
      ownerPartyId: plane.boot.ownerPartyId,
      ...(presentation.color ? { color: presentation.color } : {}),
      ...(presentation.icon ? { icon: presentation.icon } : {}),
      ...(presentation.blurb ? { blurb: presentation.blurb } : {}),
    };
  }

  /**
   * The default vault — the oldest one (ids are UUIDv7, so lexicographic
   * order is creation order). The fallback for unscoped callers only; a
   * scoped request always names its vault.
   */
  defaultVaultId(): string {
    const oldest = [...this.planes.keys()].sort()[0];
    if (oldest === undefined) throw new Error('vault registry: no vault mounted');
    return oldest;
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
    if (!plane) throw new VaultRegistryError('vault_not_found', `unknown vault "${vaultId}"`);
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

  /** Every mounted vault, oldest first. */
  list(): VaultInfo[] {
    return [...this.planes.keys()].sort().map((id) => this.info(this.planes.get(id)!));
  }

  /** Every mounted plane, oldest first (boot activation iterates these). */
  planesList(): VaultPlane[] {
    return [...this.planes.keys()].sort().map((id) => this.planes.get(id)!);
  }

  /** Create (and mount) a fresh vault. ADMIN act — CLI/host only, never HTTP. */
  create(name?: string): VaultInfo {
    const trimmed = name?.trim();
    if (trimmed !== undefined && trimmed.length === 0) {
      throw new VaultRegistryError('bad_name', 'a vault name cannot be empty');
    }
    const vaultId = uuidv7();
    const dir = path.join(this.rootDir, vaultId);
    const plane = this.openPlane(dir, {
      vaultId,
      ...(trimmed ? { vaultName: trimmed } : {}),
    });
    this.scannedDirs.add(dir);
    this.planes.set(plane.boot.vaultId, plane);
    if (this.started) plane.start();
    this.logger.info(`vault registry: created vault ${plane.boot.vaultId} ("${plane.name}")`);
    return this.info(plane);
  }

  /** Rename one vault (owner act on its own `core_vault` row). */
  rename(vaultId: string, name: string): VaultInfo {
    const plane = this.require(vaultId);
    const trimmed = name.trim();
    if (trimmed.length === 0)
      throw new VaultRegistryError('bad_name', 'a vault name cannot be empty');
    plane.rename(trimmed);
    return this.info(plane);
  }

  /** Merge a presentation patch into one vault (owner act, #280). */
  updatePresentation(
    vaultId: string,
    patch: Partial<Record<'color' | 'icon' | 'blurb', string | null>>,
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
   * ADMIN act — CLI/host only, never HTTP. The LAST vault is protected so
   * a gateway always has something to serve.
   *
   * The seal key in the `keys/` sibling is DELIBERATELY left behind (issue
   * #298 item 2): a directory backup taken before this delete stays
   * restorable only while its key survives. Key material leaves the box
   * through the receipted `key export` gesture, never as a side effect.
   * Corollary for any FUTURE gesture that renames or duplicates the vault
   * DIRECTORY (none exists today — rename is display-name-only): it must
   * move/copy `sealKeyFileFor(dir)` in the same step, or the custody check
   * in openVaultDb refuses the next open (issue #298 item 1).
   */
  delete(vaultId: string): void {
    const plane = this.require(vaultId);
    if (this.planes.size === 1) {
      throw new VaultRegistryError(
        'vault_last',
        'cannot delete the last vault — a gateway always hosts at least one',
      );
    }
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
    void purge
      .then((shas) => {
        if (shas.length > 0) {
          this.logger.info(
            `vault registry: purged ${shas.length} remote blob(s) of deleted vault ${vaultId}`,
          );
        }
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `vault registry: remote blob purge for deleted vault ${vaultId} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    this.logger.info(`vault registry: deleted vault ${vaultId} ("${plane.name}")`);
  }

  private require(vaultId: string): VaultPlane {
    const plane = this.get(vaultId);
    if (!plane) throw new VaultRegistryError('vault_not_found', `unknown vault "${vaultId}"`);
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
  agentBridgeFor(appId: string): VaultBridge {
    return async (call) => {
      const plane = this.current();
      plane.enrollAutomationAgent(appId);
      return plane.agentBridgeFor(appId)(call);
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

export function openVaultRegistry(options: VaultRegistryOptions): VaultRegistry {
  return new VaultRegistry(options);
}
