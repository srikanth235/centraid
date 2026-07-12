/*
 * Per-request vault context (issue #289).
 *
 * A client addresses a (gateway, vault) pair — never a gateway alone. The
 * gateway resolves WHICH vault a request rides from the request itself
 * (device identity and/or the explicit `x-centraid-vault` header), then runs
 * the whole handler chain inside this AsyncLocalStorage scope so every
 * provider callback deep in the graph (`appsDir()`, transcripts, `ctx.vault`
 * bridges, owner routes) lands on the request's vault without threading a
 * vault id through each signature.
 *
 * There is no server-global active vault: the client owns its pointer, and
 * two clients on two vaults never observe each other. Background work
 * (scheduler fires, boot activation) enters a scope explicitly via
 * `runWithVaultContext` with the vault it belongs to.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface VaultRequestContext {
  /** The vault this request (or background fire) is addressed to. */
  vaultId: string;
  /**
   * The calling device's key when the request arrived over an enrolled
   * transport (issue #289 phase 2): an iroh EndpointId for a proved iroh
   * caller, or a synthetic `http:<uuid>` for a device that redeemed a
   * pairing ticket over HTTP and authenticates with a per-device token
   * (issue #376, `device-token-store.ts`). Absent for the ADMIN plane —
   * the shared landlord token (loopback embed, or the daemon bearer with
   * no per-device token) — which is implicitly enrolled in every vault.
   */
  deviceKey?: string;
}

/**
 * Device-plane resolution + ACL (issue #289 phase 2): device key ↔ vault,
 * one bit. Implemented by the daemon's enrollment store; absent for hosts
 * whose transport carries no device identity (loopback embed, tests).
 */
export interface DeviceAccess {
  /**
   * Extract the calling device's key (iroh EndpointId) from the request's
   * iroh-forwarder proof headers. `undefined` = not a proved iroh
   * transport — the composed handler (`build-gateway.ts`) then falls back
   * to the HTTP listener's own device-token header before concluding the
   * caller is the shared-bearer admin plane, implicitly enrolled in every
   * vault (issue #376).
   */
  deviceKeyFor(req: import('node:http').IncomingMessage): string | undefined;
  /** The vault ids this device key is enrolled in, oldest enrollment first. */
  vaultsFor(deviceKey: string): string[];
}

const storage = new AsyncLocalStorage<VaultRequestContext>();

/** Run `fn` with `ctx` as the ambient vault context. */
export function runWithVaultContext<T>(ctx: VaultRequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The ambient vault context — undefined outside a scoped request/fire. */
export function vaultContext(): VaultRequestContext | undefined {
  return storage.getStore();
}

/** Canonical header a client names its vault with. */
export const VAULT_HEADER = 'x-centraid-vault';
