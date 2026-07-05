/*
 * `VaultWorkspace` — the per-vault world an app-engine runtime operates in
 * (issue #280: the vault is the unit).
 *
 * Everything personal lives inside one vault's directory: the conversation
 * ledger (`transcripts.db`, which also carries the `run_summary` rollup),
 * the per-app state dirs (`apps/<id>/` logs + blobs), and the chat
 * runner's per-conversation scratch files. The gateway resolves the ACTIVE
 * vault and hands app-engine this view of it; a vault switch makes the
 * provider return a different workspace on the next call, and every store
 * that consumes one re-resolves per call so the switch lands without any
 * reconstruction.
 *
 * app-engine never opens a vault itself — the shape is defined here (the
 * lower layer) so stores can type against it without a dependency on the
 * gateway or vault packages.
 */

import type { DatabaseProvider } from './gateway-db.js';

export interface VaultWorkspace {
  /** The vault's id (`core_vault.vault_id`) — the cache key across switches. */
  vaultId: string;
  /**
   * The vault owner's party id (`core_vault.owner_party_id`). Conversations
   * are stamped with this — the vault owner IS the user; there is no separate
   * gateway-side identity (issue #280 kills `identity.sqlite`).
   */
  ownerPartyId: string;
  /**
   * Directory of the vault's per-app data folders — `<plane>/apps/<appId>/`
   * holds per-app runtime state + the attachment blob CAS. Survives code swaps.
   */
  appsDir: string;
  /**
   * Lazy provider for the vault's `transcripts.db` — conversations, turns,
   * items, attachments, automation state, and the `run_summary` rollup.
   */
  transcripts: DatabaseProvider;
  /** Absolute path of `transcripts.db` (for hosts that spawn workers). */
  transcriptsDbFile: string;
  /** Scratch dir for the chat runner's per-conversation session files. */
  runnerSessionDir: string;
}

/**
 * Resolves the ACTIVE vault's workspace at call time. Injected by the
 * gateway; stores re-resolve per call so a vault switch lands immediately.
 */
export type WorkspaceProvider = () => VaultWorkspace;
