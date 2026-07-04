// Per-gateway path derivation. Single source of truth for where a
// gateway's state lives on disk.
//
// Issue #109. The desktop hosts one local gateway plus 0..N remote
// gateways; each gets a dedicated subtree under
// `<userData>/gateways/<id>/`. App ids are scoped to a gateway, so the
// git-store code + the `apps/` data storage are namespaced by gateway
// id — `todos` on the local gateway is a different artifact from
// `todos` on a Cloud account.
//
// The local gateway has the fixed id `'local'`; remote gateways get
// UUIDs minted at creation time so the user-facing label can be
// renamed without breaking paths.
//
// Invariant: EVERY file that belongs to a gateway lives under
// `gateways/<id>/`. There are no exceptions for "well, this is
// really per-machine" — the consistency of the rule beats the few
// kilobytes saved by sharing. Cleanup is therefore trivial:
// `rm -rf gateways/<id>/` removes everything about a gateway, with
// no orphan files left elsewhere.
//
// Each gateway gets (issue #280 — the vault is the unit; everything
// personal lives inside `vault/<vaultId>/`):
//   - `profile.json`              — id, kind, label, url, createdAt
//   - `token.bin`                 — encrypted bearer (gateway-secrets)
//   - `prefs.json`                — device prefs (runner choice, theme, …)
//   - `templates-cache/`          — downloaded remote-template tarballs
//   - `vault/`                    — vault registry root; each vault holds
//                                   vault.db + journal.db + transcripts.db
//                                   + apps/ (data) + code/ (git store)
//                                   + runner-sessions/

import { app } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Fixed id for the always-present in-process gateway. */
export const LOCAL_GATEWAY_ID = 'local';

/** Filename inside each gateway dir holding `{id, kind, label, url?, createdAt}`. */
export const PROFILE_FILE = 'profile.json';

/** Root path containing every per-gateway subtree. */
export function gatewaysRoot(): string {
  return path.join(app.getPath('userData'), 'gateways');
}

/** Per-gateway root — `<userData>/gateways/<id>/`. */
export function gatewayDir(id: string): string {
  return path.join(gatewaysRoot(), id);
}

/** Path to a gateway's `profile.json`. */
export function gatewayProfilePath(id: string): string {
  return path.join(gatewayDir(id), PROFILE_FILE);
}

/**
 * Device-prefs JSON file (runner choice, binPath, theme, …). The old
 * `identity.sqlite` (users + user_prefs) is gone (#280): the vault owner
 * IS the user, so what's left per gateway is device configuration.
 */
export function gatewayPrefsFile(id: string): string {
  return path.join(gatewayDir(id), 'prefs.json');
}

/**
 * Cache for downloaded remote-template tarballs. The `remoteTemplatesUrl`
 * setting today is single-valued (one feed per machine), so per-gateway
 * means each gateway populates its cache on first use rather than
 * sharing one global cache — N copies of identical bytes in the
 * single-feed case, but a clean home for per-gateway template feeds
 * if/when they exist.
 */
export function gatewayTemplatesCacheDir(id: string): string {
  return path.join(gatewayDir(id), 'templates-cache');
}

/**
 * Personal-vault root (duaility §12, #280) — one subdirectory per vault,
 * exactly one active at a time (`vaults.json` pointer). Post-#280 each
 * vault's directory holds its WHOLE world: the sovereign pair (vault.db +
 * journal.db), the conversation ledger (transcripts.db), per-app data
 * (`apps/`), the app code store (`code/`), and runner scratch. Passing
 * this as `GatewayPaths.vaultDir` mounts the registry; the owner surface
 * serves under `/centraid/_vault/*`.
 */
export function gatewayVaultDir(id: string): string {
  return path.join(gatewayDir(id), 'vault');
}

/**
 * The ACTIVE vault's id for a gateway, read from the registry's
 * `vaults.json` pointer. Undefined before the gateway has ever booted
 * (no registry yet). Main-process flows that need a vault-scoped disk
 * path (reveal-in-Finder, the in-process builder) resolve through this.
 */
export function activeVaultId(gatewayId: string): string | undefined {
  try {
    const raw = readFileSync(path.join(gatewayVaultDir(gatewayId), 'vaults.json'), 'utf8');
    const parsed = JSON.parse(raw) as { active?: unknown };
    return typeof parsed.active === 'string' && parsed.active.length > 0
      ? parsed.active
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The ACTIVE vault's app code store root (`apps.git` + worktrees) —
 * `<vault>/<activeVaultId>/code` (#280: each vault owns its own code).
 * Undefined before the vault registry exists on disk.
 */
export function activeVaultCodeStoreDir(gatewayId: string): string | undefined {
  const vaultId = activeVaultId(gatewayId);
  if (!vaultId) return undefined;
  return path.join(gatewayVaultDir(gatewayId), vaultId, 'code');
}

/**
 * Chat picker's per-runner model catalog (`model-catalog.json`, issue #188).
 * The gateway seeds the picker with the default model list and overwrites this
 * file with live self-reported ids when the user hits Refresh. Per-gateway so
 * each gateway's runner enumeration is isolated.
 */
export function gatewayModelCatalogFile(id: string): string {
  return path.join(gatewayDir(id), 'model-catalog.json');
}
