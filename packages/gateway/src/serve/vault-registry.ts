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
import { uuidv7 } from '@centraid/vault';
import type { RuntimeLogger, VaultBridge, VaultWorkspace } from '@centraid/app-engine';
import { openVaultPlane, VaultPlane } from './vault-plane.js';
import { vaultContext } from './vault-context.js';

export interface VaultRegistryOptions {
  /** Root directory: one subdirectory per vault. */
  rootDir: string;
  logger: RuntimeLogger;
  /** Owner display name used when bootstrapping fresh vaults. */
  ownerName?: string;
  /** Sweep cadence forwarded to every plane. */
  sweepIntervalMs?: number;
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
  private readonly logger: RuntimeLogger;
  private readonly ownerName: string | undefined;
  private readonly sweepIntervalMs: number | undefined;
  private readonly planes = new Map<string, VaultPlane>();
  /** Directories already mounted (or skipped) — lets `scan()` re-run cheaply. */
  private readonly scannedDirs = new Set<string>();
  private started = false;

  constructor(options: VaultRegistryOptions) {
    this.rootDir = options.rootDir;
    this.logger = options.logger;
    this.ownerName = options.ownerName;
    this.sweepIntervalMs = options.sweepIntervalMs;
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
    if (this.planes.size === 0) this.create();
  }

  /**
   * Mount every `<root>/<dir>/vault.db` found on disk. Re-runnable: a vault
   * created by the admin CLI while the daemon is up is picked up on the
   * first request that names it (see `get()`).
   */
  private scan(): void {
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.rootDir, entry.name);
      if (this.scannedDirs.has(dir)) continue;
      if (!existsSync(path.join(dir, 'vault.db'))) continue;
      this.scannedDirs.add(dir);
      try {
        const plane = this.openPlane(dir, {});
        if (this.planes.has(plane.boot.vaultId)) {
          this.logger.warn(
            `vault registry: duplicate vault id ${plane.boot.vaultId} at ${dir} — skipped`,
          );
          plane.stop();
          continue;
        }
        this.planes.set(plane.boot.vaultId, plane);
        if (this.started) plane.start();
      } catch (err) {
        this.logger.warn(
          `vault registry: could not mount vault at ${dir}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  private openPlane(dir: string, boot: { vaultId?: string; vaultName?: string }): VaultPlane {
    return openVaultPlane({
      dir,
      logger: this.logger,
      ...(this.ownerName ? { ownerName: this.ownerName } : {}),
      ...(this.sweepIntervalMs !== undefined ? { sweepIntervalMs: this.sweepIntervalMs } : {}),
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
   * Delete a vault: plane stopped, its directory (both SQLite files and the
   * appext exports under it) removed. ADMIN act — CLI/host only, never HTTP.
   * The LAST vault is protected so a gateway always has something to serve.
   */
  delete(vaultId: string): void {
    const plane = this.require(vaultId);
    if (this.planes.size === 1) {
      throw new VaultRegistryError(
        'vault_last',
        'cannot delete the last vault — a gateway always hosts at least one',
      );
    }
    plane.stop();
    this.planes.delete(vaultId);
    this.scannedDirs.delete(plane.dir);
    rmSync(plane.dir, { recursive: true, force: true });
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
  enrollAutomationAgent(appId: string): void {
    this.current().enrollAutomationAgent(appId);
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
