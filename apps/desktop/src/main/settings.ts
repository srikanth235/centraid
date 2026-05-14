import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { HarnessConfig } from '@centraid/agent-harness';
import { ensureLocalRuntime } from './local-runtime.js';

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
  projectsDir: string;
  runtimeMode: RuntimeMode;
  remoteGatewayUrl: string;
  remoteGatewayToken: string;
  remoteTemplatesUrl?: string;
}

export interface DesktopSettings extends HarnessConfig {
  projectsDir: string;
  runtimeMode: RuntimeMode;
  remoteGatewayUrl: string;
  remoteGatewayToken: string;
  remoteTemplatesUrl?: string;
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
  if (p.runtimeMode === 'local') {
    const handle = await ensureLocalRuntime();
    return {
      ...p,
      gatewayUrl: handle.url,
      gatewayToken: handle.token,
    };
  }
  return {
    ...p,
    gatewayUrl: p.remoteGatewayUrl,
    gatewayToken: p.remoteGatewayToken,
  };
}

export async function loadSettings(): Promise<DesktopSettings> {
  const persisted = await readPersisted();
  return resolveEffective(persisted);
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
  };
  await writePersisted(next);
  return resolveEffective(next);
}

/** Where remote-fetched template copies are cached. Per-user, persistent. */
export function templatesCacheDir(): string {
  return path.join(app.getPath('userData'), 'templates-cache');
}
