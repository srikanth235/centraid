// Per-gateway path derivation. Single source of truth for where a
// gateway's state lives on disk.
//
// Issue #109. The desktop hosts one local gateway plus 0..N remote
// gateways; each gets a dedicated subtree under
// `<userData>/gateways/<id>/`. App ids are scoped to a gateway, so the
// workspace and the versioned `apps/` storage are namespaced by gateway
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
// Each gateway gets:
//   - `profile.json`              — id, kind, label, url, createdAt
//   - `token.bin`                 — encrypted bearer (gateway-secrets)
//   - `workspace/<appId>/...`     — editable source files
//   - `apps/<appId>/...`          — versioned storage (empty for remote)
//   - `identity.sqlite`           — users + prefs (local only)
//   - `analytics.sqlite`          — run summaries (local only)
//   - `chat-runner-sessions/`     — codex thread state for in-app chat
//   - `codex-home/`               — provider-scoped CODEX_HOME bases
//   - `templates-cache/`          — downloaded remote-template tarballs

import { app } from 'electron';
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
 * Per-gateway workspace — flat, editable source files the builder
 * reads/writes. Same shape regardless of gateway kind.
 */
export function gatewayWorkspaceDir(id: string): string {
  return path.join(gatewayDir(id), 'workspace');
}

/**
 * Per-gateway versioned storage. Populated by uploads from the
 * workspace; the dispatcher + iframe + OS scheduler read from
 * `<appsDir>/<appId>/versions/<active>/`.
 *
 * For remote gateways this directory exists but stays empty — the
 * remote gateway owns its own storage server-side. Keeping the dir
 * lets us avoid kind-specific branching in every IPC handler.
 */
export function gatewayAppsDir(id: string): string {
  return path.join(gatewayDir(id), 'apps');
}

/**
 * Gateway-side identity SQLite — users + per-user prefs (theme,
 * density, runner choice, …). The in-process local gateway is the
 * only consumer; remote gateways read identity from their server.
 * The file slot stays per-gateway for layout consistency even when
 * unused.
 */
export function gatewayIdentityDb(id: string): string {
  return path.join(gatewayDir(id), 'identity.sqlite');
}

/**
 * Gateway-side analytics SQLite — one row per run (chat turn,
 * automation fire). The local gateway writes here; remote gateways
 * track their own analytics server-side. Per-gateway so a future
 * "show me runs across all my gateways" pass has a natural place
 * to look.
 */
export function gatewayAnalyticsDb(id: string): string {
  return path.join(gatewayDir(id), 'analytics.sqlite');
}

/**
 * Codex chat-runner per-session state — `chat-runner-sessions/<id>/`
 * dirs the in-process Runtime materializes for each agentic chat
 * session. Per-gateway because a chat session is between the user
 * and a specific app on a specific gateway.
 */
export function gatewayChatRunnerSessionsDir(id: string): string {
  return path.join(gatewayDir(id), 'chat-runner-sessions');
}

/**
 * Parent dir for provider-scoped `CODEX_HOME`s. When the user has
 * configured a custom OpenAI-compatible provider, the builder + chat
 * codex spawns get `CODEX_HOME=<this dir>/codex-homes/<provider-id>/`
 * pointing at a centraid-generated config.toml (the user's real
 * `~/.codex` is left untouched). Per-gateway because codex stores
 * thread state under `CODEX_HOME`, and a thread tied to "app X on
 * gateway A" is a different conversation from "app X on gateway B".
 */
export function gatewayCodexHomeBaseDir(id: string): string {
  return path.join(gatewayDir(id), 'codex-home');
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
