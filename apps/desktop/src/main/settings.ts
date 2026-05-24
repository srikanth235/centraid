import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { HarnessConfig } from '@centraid/builder-harness';
// `local-runtime` is loaded lazily because it pulls in `@centraid/runtime-core`
// which uses `node:sqlite` — a built-in Electron's Node doesn't expose.
// Importing it statically would crash the renderer at boot for remote-mode
// users who never need the embedded runtime.

/**
 * Persisted desktop settings live at `<userData>/centraid-settings.json`
 * with mode `0600` — it holds the remote gateway bearer token.
 *
 * Two shapes coexist here:
 *   - **Persisted form** (`PersistedSettings`): exactly what's serialized
 *     to disk. Includes `runtimeMode` + the user-edited `remoteGatewayUrl`
 *     / `remoteGatewayToken`.
 *   - **Effective form** (`DesktopSettings`, returned by `loadSettings()`):
 *     same persisted fields, plus `gatewayUrl` / `gatewayToken` resolved
 *     against the chosen `runtimeMode`. The renderer reads the effective
 *     values for runtime HTTP calls; the persisted fields drive the
 *     Settings UI editor.
 */

export type RuntimeMode = 'local' | 'remote';

export interface PersistedSettings {
  /**
   * Root directory for everything the desktop persists per-user. Two
   * derived subdirs hang off this on the effective {@link DesktopSettings}:
   *   - `workspaceDir` (`<projectsDir>/workspace/`) — flat, editable
   *     source files. The builder owns this. One copy per app.
   *   - `appsDir` (`<projectsDir>/apps/`) — gateway storage, versioned.
   *     Populated by uploads from the workspace. The dispatcher,
   *     iframe, and automations all read from `<appsDir>/<id>/versions/<active>/`.
   * Issue #108 split these two roles apart; #98 introduced the
   * single-`apps/` layout that the gateway side keeps.
   */
  projectsDir: string;
  runtimeMode: RuntimeMode;
  remoteGatewayUrl: string;
  remoteGatewayToken: string;
  remoteTemplatesUrl?: string;
  /** Model id used by the app-view agentic chat (openclaw infer model run). */
  chatModel?: string;
  /**
   * ISO timestamp of the most recent Claude Code / Codex credential
   * auto-import. Empty/undefined on first launch — main.ts uses that as
   * the trigger to run the importer once. The Settings → AI providers
   * "Re-sync" button is independent of this field.
   */
  authImportedAt?: string;
}

export interface DesktopSettings extends HarnessConfig {
  /** Root dir (persisted). See {@link PersistedSettings.projectsDir}. */
  projectsDir: string;
  /**
   * Derived — `<projectsDir>/workspace`. Editable source files the
   * builder reads/writes. Flat layout: `<workspaceDir>/<id>/app.json`,
   * `actions/*.js`, etc. Never read by the dispatcher or iframe.
   */
  workspaceDir: string;
  /**
   * Derived — `<projectsDir>/apps`. Local gateway storage, versioned.
   * Layout: `<appsDir>/<id>/current.json` + `versions/v_<ts>_<sha>/`.
   * In local-runtime mode, the in-process gateway owns this directory;
   * the renderer reads it only via the gateway HTTP surface or the
   * preview protocol (which resolves the active version). In remote
   * mode, the directory is unused — the renderer talks to the remote
   * gateway, which owns its own storage.
   */
  appsDir: string;
  runtimeMode: RuntimeMode;
  remoteGatewayUrl: string;
  remoteGatewayToken: string;
  remoteTemplatesUrl?: string;
  chatModel?: string;
  authImportedAt?: string;
}

const FILE_NAME = 'centraid-settings.json';
const DEFAULT_REMOTE_URL = 'http://127.0.0.1:18789';

function settingsPath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function persistedDefaults(): PersistedSettings {
  return {
    projectsDir: path.join(os.homedir(), 'centraid-projects'),
    runtimeMode: 'local',
    remoteGatewayUrl: DEFAULT_REMOTE_URL,
    remoteGatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN ?? '',
    remoteTemplatesUrl: '',
  };
}

/**
 * Migrate legacy persisted JSON to the new shape. Older builds wrote
 * `gatewayUrl` / `gatewayToken` at the top level with no `runtimeMode`. If
 * `gatewayToken` was set the user was previously configured for remote
 * OpenClaw, so keep them on remote mode; otherwise default to local.
 */
function migrate(
  raw: Partial<PersistedSettings & { gatewayUrl?: string; gatewayToken?: string }>,
): PersistedSettings {
  const base = persistedDefaults();
  const projectsDir = raw.projectsDir?.trim() || base.projectsDir;
  const remoteTemplatesUrl = raw.remoteTemplatesUrl ?? base.remoteTemplatesUrl;

  if (raw.runtimeMode || raw.remoteGatewayUrl) {
    return {
      projectsDir,
      runtimeMode: raw.runtimeMode ?? base.runtimeMode,
      remoteGatewayUrl: raw.remoteGatewayUrl?.trim() || base.remoteGatewayUrl,
      remoteGatewayToken: raw.remoteGatewayToken ?? base.remoteGatewayToken,
      remoteTemplatesUrl,
      chatModel: raw.chatModel,
      authImportedAt: raw.authImportedAt,
    };
  }

  const legacyUrl = raw.gatewayUrl?.trim() || base.remoteGatewayUrl;
  const legacyToken = raw.gatewayToken ?? base.remoteGatewayToken;
  return {
    projectsDir,
    runtimeMode: legacyToken ? 'remote' : 'local',
    remoteGatewayUrl: legacyUrl,
    remoteGatewayToken: legacyToken,
    remoteTemplatesUrl,
    chatModel: raw.chatModel,
    authImportedAt: raw.authImportedAt,
  };
}

async function readPersisted(): Promise<PersistedSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<
      PersistedSettings & { gatewayUrl?: string; gatewayToken?: string }
    >;
    return migrate(parsed);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[centraid] failed to read settings:', err);
    }
    return persistedDefaults();
  }
}

async function writePersisted(next: PersistedSettings): Promise<void> {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function resolveEffective(p: PersistedSettings): Promise<DesktopSettings> {
  // Workspace (editable source) and gateway storage (versioned) are
  // sibling subdirs under the user's project root — see #108.
  const derived = {
    workspaceDir: path.join(p.projectsDir, 'workspace'),
    appsDir: path.join(p.projectsDir, 'apps'),
  };
  if (p.runtimeMode === 'local') {
    const { ensureLocalRuntime } = await import('./local-runtime.js');
    const handle = await ensureLocalRuntime();
    return {
      ...p,
      ...derived,
      gatewayUrl: handle.url,
      gatewayToken: handle.token,
    };
  }
  return {
    ...p,
    ...derived,
    gatewayUrl: p.remoteGatewayUrl,
    gatewayToken: p.remoteGatewayToken,
  };
}

export async function loadSettings(): Promise<DesktopSettings> {
  const persisted = await readPersisted();
  return resolveEffective(persisted);
}

/**
 * Read the persisted settings WITHOUT resolving the effective runtime
 * gateway. `loadSettings` routes through `resolveEffective`, which (in
 * local mode) starts the in-process runtime — code reachable from
 * `ensureLocalRuntime` must use this to avoid a startup cycle.
 */
export async function loadPersistedSettings(): Promise<PersistedSettings> {
  return readPersisted();
}

export async function saveSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings> {
  const current = await readPersisted();
  const next: PersistedSettings = {
    projectsDir: patch.projectsDir?.trim() || current.projectsDir,
    runtimeMode: patch.runtimeMode ?? current.runtimeMode,
    remoteGatewayUrl: patch.remoteGatewayUrl?.trim() || current.remoteGatewayUrl,
    remoteGatewayToken:
      patch.remoteGatewayToken !== undefined
        ? patch.remoteGatewayToken
        : current.remoteGatewayToken,
    remoteTemplatesUrl:
      patch.remoteTemplatesUrl !== undefined
        ? patch.remoteTemplatesUrl
        : current.remoteTemplatesUrl,
    chatModel: patch.chatModel !== undefined ? patch.chatModel : current.chatModel,
    authImportedAt:
      patch.authImportedAt !== undefined ? patch.authImportedAt : current.authImportedAt,
  };
  await writePersisted(next);
  return resolveEffective(next);
}

/** Where remote-fetched template copies are cached. Per-user, persistent. */
export function templatesCacheDir(): string {
  return path.join(app.getPath('userData'), 'templates-cache');
}
