/*
 * The vault registry — the gateway's set of personal vaults under one root.
 *
 * Each vault is a `VaultPlane` in its own directory (`<root>/<vaultId>/`,
 * holding that vault's `vault.db` + `journal.db`); the vault's identity and
 * owner-facing name live inside its own `core_vault` row, so the registry
 * persists nothing but the ACTIVE pointer (`<root>/vaults.json`). Owner acts
 * (create / rename / switch / delete) land here; per-vault acts (grants,
 * parked confirmations) resolve a plane first and run unchanged.
 *
 * `ctx.vault` follows the active vault: the app/agent bridges resolve the
 * active plane per call and ensure the caller's identity is enrolled there,
 * so switching vaults never strands a handler — deny-by-default still holds,
 * because enrollment is identity only and grants are per vault.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { uuidv7 } from '@centraid/vault';
import type { RuntimeLogger, VaultBridge, VaultWorkspace } from '@centraid/app-engine';
import { openVaultPlane, VaultPlane } from './vault-plane.js';

export interface VaultRegistryOptions {
  /** Root directory: one subdirectory per vault, plus `vaults.json`. */
  rootDir: string;
  logger: RuntimeLogger;
  /** Owner display name used when bootstrapping fresh vaults. */
  ownerName?: string;
  /** Sweep cadence forwarded to every plane. */
  sweepIntervalMs?: number;
}

/** One row of the owner's vault list. */
export interface VaultInfo {
  vaultId: string;
  name: string;
  active: boolean;
  ownerPartyId: string;
  /** Presentation out of `core_vault.settings_json` (#280: profiles are vaults). */
  color?: string;
  icon?: string;
  blurb?: string;
}

/* eslint-disable max-classes-per-file -- error class is colocated with its module (#247) */
/** A refused registry act (delete the active vault, unknown id, …). */
export class VaultRegistryError extends Error {
  constructor(
    readonly code: 'vault_not_found' | 'vault_active' | 'bad_name',
    message: string,
  ) {
    super(message);
    this.name = 'VaultRegistryError';
  }
}

const POINTER_FILE = 'vaults.json';

export class VaultRegistry {
  private readonly rootDir: string;
  private readonly logger: RuntimeLogger;
  private readonly ownerName: string | undefined;
  private readonly sweepIntervalMs: number | undefined;
  private readonly planes = new Map<string, VaultPlane>();
  private activeId!: string;
  private started = false;
  /**
   * Host hook run after the active pointer moves (#280): the gateway
   * re-roots its workspace here (registry sync, scheduler reconcile).
   * Assigned post-construction — the registry opens before the runtime.
   */
  private activationHook: (() => Promise<void>) | undefined;

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
    this.activeId = this.resolveActivePointer();
  }

  /** Mount every `<root>/<dir>/vault.db` found on disk. */
  private scan(): void {
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.rootDir, entry.name);
      if (!existsSync(path.join(dir, 'vault.db'))) continue;
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

  /**
   * Load the active pointer, repairing it (oldest vault wins — ids are
   * UUIDv7, so lexicographic order is creation order) when it is missing
   * or names a vault that no longer exists.
   */
  private resolveActivePointer(): string {
    const pointerPath = path.join(this.rootDir, POINTER_FILE);
    let active: string | undefined;
    try {
      const raw = JSON.parse(readFileSync(pointerPath, 'utf8')) as { active?: unknown };
      if (typeof raw.active === 'string') active = raw.active;
    } catch {
      // Missing or unreadable — repaired below.
    }
    if (active && this.planes.has(active)) return active;
    const oldest = [...this.planes.keys()].sort()[0];
    if (oldest === undefined) throw new Error('vault registry: no vault to activate');
    this.writeActivePointer(oldest);
    return oldest;
  }

  private writeActivePointer(vaultId: string): void {
    writeFileSync(path.join(this.rootDir, POINTER_FILE), JSON.stringify({ active: vaultId }));
  }

  private info(plane: VaultPlane): VaultInfo {
    const presentation = plane.presentation;
    return {
      vaultId: plane.boot.vaultId,
      name: plane.name,
      active: plane.boot.vaultId === this.activeId,
      ownerPartyId: plane.boot.ownerPartyId,
      ...(presentation.color ? { color: presentation.color } : {}),
      ...(presentation.icon ? { icon: presentation.icon } : {}),
      ...(presentation.blurb ? { blurb: presentation.blurb } : {}),
    };
  }

  /** The ACTIVE vault's workspace — the world app-engine operates in (#280). */
  activeWorkspace(): VaultWorkspace {
    return this.active().workspace;
  }

  /** Register the host's post-switch re-root hook (#280). */
  setActivationHook(hook: () => Promise<void>): void {
    this.activationHook = hook;
  }

  /**
   * Run the host's activation hook (after `setActive`, and once at boot).
   * The vault-routes PATCH awaits this so the renderer sees the new
   * workspace fully mounted when the response lands.
   */
  async settleActivation(): Promise<void> {
    if (this.activationHook) await this.activationHook();
  }

  /** The active vault's plane — where `ctx.vault` and default owner acts land. */
  active(): VaultPlane {
    const plane = this.planes.get(this.activeId);
    if (!plane) throw new Error(`vault registry: active vault ${this.activeId} is not mounted`);
    return plane;
  }

  /** Resolve one vault by id — `undefined` when unknown. */
  get(vaultId: string): VaultPlane | undefined {
    return this.planes.get(vaultId);
  }

  /** Every mounted vault, oldest first, active flagged. */
  list(): VaultInfo[] {
    return [...this.planes.keys()].sort().map((id) => this.info(this.planes.get(id)!));
  }

  /** Create (and mount) a fresh vault; it does NOT become active implicitly. */
  create(name?: string): VaultInfo {
    const trimmed = name?.trim();
    if (trimmed !== undefined && trimmed.length === 0) {
      throw new VaultRegistryError('bad_name', 'a vault name cannot be empty');
    }
    const vaultId = uuidv7();
    const plane = this.openPlane(path.join(this.rootDir, vaultId), {
      vaultId,
      ...(trimmed ? { vaultName: trimmed } : {}),
    });
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

  /** Point the gateway's single active-vault seat at another vault. */
  setActive(vaultId: string): VaultInfo {
    const plane = this.require(vaultId);
    this.activeId = vaultId;
    this.writeActivePointer(vaultId);
    this.logger.info(`vault registry: active vault is now ${vaultId} ("${plane.name}")`);
    return this.info(plane);
  }

  /**
   * Delete a vault: plane stopped, its directory (both SQLite files and the
   * appext exports under it) removed. The ACTIVE vault is protected — switch
   * first — which also guarantees at least one vault always remains.
   */
  delete(vaultId: string): void {
    const plane = this.require(vaultId);
    if (vaultId === this.activeId) {
      throw new VaultRegistryError(
        'vault_active',
        'cannot delete the active vault — switch to another vault first',
      );
    }
    plane.stop();
    this.planes.delete(vaultId);
    rmSync(plane.dir, { recursive: true, force: true });
    this.logger.info(`vault registry: deleted vault ${vaultId} ("${plane.name}")`);
  }

  private require(vaultId: string): VaultPlane {
    const plane = this.planes.get(vaultId);
    if (!plane) throw new VaultRegistryError('vault_not_found', `unknown vault "${vaultId}"`);
    return plane;
  }

  /**
   * The app-plane `ctx.vault` executor: every call rides the vault that is
   * active WHEN IT RUNS, with the app's identity ensured there first (identity
   * only — grants stay per vault, deny-by-default).
   */
  bridgeFor(appId: string): VaultBridge {
    return async (call) => {
      const plane = this.active();
      plane.enrollApp(appId);
      return plane.bridgeFor(appId)(call);
    };
  }

  /** The agent-plane mirror of `bridgeFor` for automation fires. */
  agentBridgeFor(appId: string): VaultBridge {
    return async (call) => {
      const plane = this.active();
      plane.enrollAutomationAgent(appId);
      return plane.agentBridgeFor(appId)(call);
    };
  }

  /** The scenario-seed executor against the ACTIVE vault (issue #290). */
  demoBridgeFor(appId: string): VaultBridge {
    return async (call) => this.active().demoBridgeFor(appId)(call);
  }

  /**
   * Enroll a live app in the ACTIVE vault (identity only). Post-#280 an app
   * is a vault asset — it lives in one vault's code store and is enrolled
   * there alone, so `consent.app` now governs the vault's OWN apps.
   */
  enrollApp(appId: string): void {
    this.active().enrollApp(appId);
  }

  /** Enroll an automation's acting identity in the ACTIVE vault. */
  enrollAutomationAgent(appId: string): void {
    this.active().enrollAutomationAgent(appId);
  }

  /** Uninstall cascade in the ACTIVE vault (the app lives nowhere else, #280). */
  revokeApp(appId: string): { grantsRevoked: number } {
    return this.active().revokeApp(appId);
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
