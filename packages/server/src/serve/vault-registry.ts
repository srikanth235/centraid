// governance: allow-repo-hygiene file-size-limit (#439) the vault registry is one cohesive mount/lifecycle owner — scan, create, rename, delete, and now adopt (issue #439) all manipulate the same private plane map + auto-created-default set, so splitting the adopt seam into its own module would either expose that internal state across a boundary or duplicate the scan/delete plumbing it reuses

import { readdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

import type {
  RuntimeLogger,
  VaultBridge,
  VaultWorkspace,
} from "@centraid/server/engine";
import {
  uuidv7,
  VaultSchemaAheadError,
  applyVaultFootprint,
  signWithVaultIdentity,
  vaultIdentityPublicKey,
} from "@centraid/vault";
import type {
  BlobStoreSettings,
  S3Credentials,
  PreviewCodec,
  KeyStore,
  VaultFootprintBudget,
} from "@centraid/vault";

import {
  replicaIntentContext,
  runWithReplicaIntent,
} from "./replica-intent-context.js";
import { runWithVaultContext, vaultContext } from "./vault-context.js";
import type { InstallScopeBlock, VaultPlane } from "./vault-plane.js";
import { openVaultPlane } from "./vault-plane.js";

const MOUNT_RETRY_BACKOFF_MS = 30_000;

export interface FailedMount {
  dir: string;
  message: string;
  at: string;
  schemaAhead?: boolean;
}

interface FailedMountState {
  message: string;
  atMs: number;
  schemaAhead: boolean;
}

export interface VaultRegistryOptions {
  rootDir: string;
  cacheRootDir?: string;
  logger: RuntimeLogger;
  keyStore?: KeyStore;
  ownerName?: string;
  sweepIntervalMs?: number;
  enableWalShipper?: boolean;
  walCaptureConfigured?: () => boolean;
  skipOrphanDelete?: () => boolean;
  s3Credentials?: (settings: BlobStoreSettings) => Promise<S3Credentials>;
  previewCodec?: PreviewCodec;
  onProvenanceCommitted?: (
    vaultId: string,
    entityTypes?: readonly string[]
  ) => void;
  onCommonsCommandSequenced?: (vaultId: string, grantId: string) => void;
  onCommonsIntentQueued?: (vaultId: string, grantId: string) => void;
  onNotificationsChanged?: (vaultId: string, wake: boolean) => void;
  synchronous?: "FULL" | "NORMAL";
  shouldDeferBackgroundWork?: () => boolean;
  replicationConcurrency?: number;
  footprintBudget?: VaultFootprintBudget;
  onSweepPass?: (info: { durationMs: number }) => void;
  onReplicationPass?: (info: {
    bytesReplicated: number;
    durationMs: number;
  }) => void;
  journalLimitBytes?: () => number | null;
}

export interface VaultInfo {
  vaultId: string;
  name: string;
  ownerPartyId: string;
  personal?: boolean;
  color?: string;
  icon?: string;
  blurb?: string;
}

/* oxlint-disable max-classes-per-file -- error class is colocated with its module (#247) */
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
  private readonly onCommonsCommandSequenced:
    | ((vaultId: string, grantId: string) => void)
    | undefined;
  private readonly onCommonsIntentQueued:
    | ((vaultId: string, grantId: string) => void)
    | undefined;
  private readonly onNotificationsChanged:
    | ((vaultId: string, wake: boolean) => void)
    | undefined;
  private readonly synchronous: "FULL" | "NORMAL" | undefined;
  private readonly shouldDeferBackgroundWork: (() => boolean) | undefined;
  private readonly replicationConcurrency: number | undefined;
  private readonly footprintBudget: VaultFootprintBudget | undefined;
  private readonly onSweepPass:
    | ((info: { durationMs: number }) => void)
    | undefined;
  private readonly onReplicationPass:
    | ((info: { bytesReplicated: number; durationMs: number }) => void)
    | undefined;
  private readonly journalLimitBytes: (() => number | null) | undefined;
  private readonly planes = new Map<string, VaultPlane>();
  private readonly mountListeners = new Set<(plane: VaultPlane) => void>();
  private readonly scannedDirs = new Set<string>();
  private readonly failedMountsByDir = new Map<string, FailedMountState>();
  private started = false;

  constructor(options: VaultRegistryOptions) {
    this.rootDir = options.rootDir;
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
    this.onCommonsCommandSequenced = options.onCommonsCommandSequenced;
    this.onCommonsIntentQueued = options.onCommonsIntentQueued;
    this.onNotificationsChanged = options.onNotificationsChanged;
    this.synchronous = options.synchronous;
    this.shouldDeferBackgroundWork = options.shouldDeferBackgroundWork;
    this.replicationConcurrency = options.replicationConcurrency;
    this.footprintBudget = options.footprintBudget;
    this.onSweepPass = options.onSweepPass;
    this.onReplicationPass = options.onReplicationPass;
    this.journalLimitBytes = options.journalLimitBytes;
    if (!existsSync(this.rootDir)) return;
    if (existsSync(path.join(this.rootDir, "vault.db"))) {
      this.logger.warn(
        `vault registry: ignoring legacy single-vault files at ${this.rootDir} — ` +
          "vaults now live one directory per vault"
      );
    }
    this.scan();
  }

  private scan(): void {
    if (!existsSync(this.rootDir)) return;
    const nowMs = Date.now();
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Restore staging carries a `vault.db` too, and mounting it mid-restore
      // would be a torn vault. Real vaults are UUIDv7 (#439).
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
          // A real conflict: retrying cannot fix it without an operator.
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
        this.rebalanceFootprints();
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

  rescan(): void {
    this.scan();
  }

  onMount(listener: (plane: VaultPlane) => void): () => void {
    this.mountListeners.add(listener);
    return () => this.mountListeners.delete(listener);
  }

  private notifyMounted(plane: VaultPlane): void {
    for (const listener of this.mountListeners) {
      try {
        listener(plane);
      } catch {
        // One listener's throw must not starve the others.
      }
    }
  }

  /** A directory that FAILED to mount is still a vault here: corruption must
   *  never make an inhabited gateway look fresh (#603). */
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

  rootPath(): string {
    return this.rootDir;
  }

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

  /** Counting DIRECTORIES, not open planes: `scan()` opens them one at a
   *  time, so `planes.size` would over-grant the first vault (#659). */
  private planeFootprint(): Partial<VaultFootprintBudget> {
    const budget = this.footprintBudget;
    if (!budget) return {};
    const planes = Math.max(1, this.mountableVaultCount());
    return {
      mmapBytes: Math.floor(budget.mmapBytes / planes),
      cacheBytes: Math.floor(budget.cacheBytes / planes),
    };
  }

  private mountableVaultCount(): number {
    if (!existsSync(this.rootDir)) return this.planes.size;
    let count = 0;
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (!existsSync(path.join(this.rootDir, entry.name, "vault.db")))
        continue;
      count += 1;
    }
    return Math.max(count, this.planes.size);
  }

  /** A household grows one vault at a time, so the SUM of opening shares lands
   *  over the ceiling. The per-file split belongs to `applyVaultFootprint`. */
  private rebalanceFootprints(): void {
    const budget = this.footprintBudget;
    if (!budget || this.planes.size === 0) return;
    const perVault: VaultFootprintBudget = {
      mmapBytes: Math.floor(budget.mmapBytes / this.planes.size),
      cacheBytes: Math.floor(budget.cacheBytes / this.planes.size),
    };
    for (const plane of this.planes.values()) {
      for (const db of [plane.db.vault, plane.db.audit]) {
        applyVaultFootprint(db, perVault);
      }
    }
  }

  private openPlane(
    dir: string,
    boot: { vaultId?: string; vaultName?: string }
  ): VaultPlane {
    return openVaultPlane({
      dir,
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
      ...(this.onCommonsCommandSequenced
        ? { onCommonsCommandSequenced: this.onCommonsCommandSequenced }
        : {}),
      ...(this.onCommonsIntentQueued
        ? { onCommonsIntentQueued: this.onCommonsIntentQueued }
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
      ...(this.footprintBudget ? { footprint: this.planeFootprint() } : {}),
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

  /** The durable `personal` marker, NOT creation order and NOT the name. */
  defaultVaultId(): string {
    const chosen = this.defaultVaultIdOrUndefined();
    if (chosen === undefined)
      throw new Error("vault registry: no vault mounted");
    return chosen;
  }

  defaultVaultIdOrUndefined(): string | undefined {
    const ids = [...this.planes.keys()].sort();
    return ids.find((id) => this.planes.get(id)?.personal === true) ?? ids[0];
  }

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

  currentWorkspace(): VaultWorkspace {
    return this.current().workspace;
  }

  get(vaultId: string): VaultPlane | undefined {
    const mounted = this.planes.get(vaultId);
    if (mounted) return mounted;
    this.scan();
    return this.planes.get(vaultId);
  }

  vaultIdentity(vaultId: string): { publicKey: string } | undefined {
    const plane = this.get(vaultId);
    if (!plane) return undefined;
    return {
      publicKey: vaultIdentityPublicKey(plane.db.identitySeed).toString(
        "base64"
      ),
    };
  }

  signAsVault(vaultId: string, bytes: Buffer): Buffer | undefined {
    const plane = this.get(vaultId);
    if (!plane) return undefined;
    return signWithVaultIdentity(plane.db.identitySeed, bytes);
  }

  /**
   * DEFAULT VAULT FIRST — the SINGLE choke point every client listing goes
   * through. WHY NOT JUST THE OLDEST: an older non-personal vault can exist in
   * a data dir predating the personal marker, and clients treat row 0 as
   * PRIMARY, which must agree with `defaultVaultId()` (#665).
   */
  list(): VaultInfo[] {
    return this.listedIds().map((id) => this.info(this.planes.get(id)!));
  }

  private listedIds(): string[] {
    const ids = [...this.planes.keys()].sort();
    const head = this.defaultVaultIdOrUndefined();
    if (head === undefined || ids[0] === head) return ids;
    return [head, ...ids.filter((id) => id !== head)];
  }

  /** NOT reordered like `list()`: no caller here reads element 0 as
   *  "primary", so the hoist stays on the client wire (#665). */
  planesList(): VaultPlane[] {
    return [...this.planes.keys()].sort().map((id) => this.planes.get(id)!);
  }

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
    this.rebalanceFootprints();
    if (this.started) plane.start();
    this.notifyMounted(plane);
    this.logger.info(
      `vault registry: created vault ${plane.boot.vaultId} ("${plane.name}")`
    );
    return this.info(plane);
  }

  rename(vaultId: string, name: string): VaultInfo {
    const plane = this.require(vaultId);
    const trimmed = name.trim();
    if (trimmed.length === 0)
      throw new VaultRegistryError("bad_name", "a vault name cannot be empty");
    plane.rename(trimmed);
    return this.info(plane);
  }

  updatePresentation(
    vaultId: string,
    patch: Partial<Record<"color" | "icon" | "blurb", string | null>>
  ): VaultInfo {
    const plane = this.require(vaultId);
    plane.updatePresentation(patch);
    return this.info(plane);
  }

  /** An ADMIN act. This registry owns CONTENT deletion only — crypto-erasure
   *  belongs to the erase ceremony. The remote tier purge is best-effort. */
  delete(vaultId: string): void {
    const plane = this.require(vaultId);
    // Resolves synchronously BEFORE `stop()` closes the handles; the deletes
    // then run detached.
    const purge = plane.db.blobs.purgeRemote();
    plane.stop();
    this.planes.delete(vaultId);
    this.rebalanceFootprints();
    this.scannedDirs.delete(plane.dir);
    this.failedMountsByDir.delete(plane.dir);
    rmSync(plane.dir, { recursive: true, force: true });
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

  bridgeFor(appId: string): VaultBridge {
    // Workers invoke this AFTER the request's async-local scopes unwind, so
    // capture at construction; an unscoped bridge resolves dynamically.
    const capturedVault = vaultContext();
    const capturedIntent = replicaIntentContext();
    return async (call) => {
      const invoke = async (): Promise<Awaited<ReturnType<VaultBridge>>> => {
        const plane = this.current();
        plane.enrollApp(appId);
        return plane.bridgeFor(appId)(call);
      };
      const withIntent = (): ReturnType<typeof invoke> =>
        capturedIntent
          ? runWithReplicaIntent(capturedIntent, invoke)
          : invoke();
      return capturedVault
        ? runWithVaultContext(capturedVault, withIntent)
        : withIntent();
    };
  }

  agentBridgeFor(appId: string, block?: InstallScopeBlock): VaultBridge {
    return async (call) => {
      const plane = this.current();
      plane.enrollAutomationAgent(appId);
      return plane.agentBridgeFor(appId, block)(call);
    };
  }

  demoBridgeFor(appId: string): VaultBridge {
    return async (call) => this.current().demoBridgeFor(appId)(call);
  }

  enrollApp(appId: string): void {
    this.current().enrollApp(appId);
  }

  enrollAutomationAgent(appId: string, displayName?: string): void {
    this.current().enrollAutomationAgent(appId, displayName);
  }

  revokeApp(appId: string): { grantsRevoked: number } {
    return this.current().revokeApp(appId);
  }

  start(): void {
    this.started = true;
    for (const plane of this.planes.values()) plane.start();
  }

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
