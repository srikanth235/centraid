import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { HarnessConfig } from '@centraid/agent-harness';

/**
 * Persisted desktop settings. Lives at <userData>/centraid-settings.json with
 * mode 0600 — it holds the gateway bearer token.
 */
export interface DesktopSettings extends HarnessConfig {
  /**
   * Base URL the templates fetcher polls for updates. Expected to host a
   * `manifest.json` plus a per-template file tree at `<url>/<id>/<file>`.
   * Empty string disables remote fetching (bundled templates only).
   */
  remoteTemplatesUrl?: string;
}

const FILE_NAME = 'centraid-settings.json';

function settingsPath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function defaults(): DesktopSettings {
  return {
    projectsDir: path.join(os.homedir(), 'centraid-projects'),
    gatewayUrl: 'http://127.0.0.1:18789',
    gatewayToken: '',
    remoteTemplatesUrl: '',
  };
}

export async function loadSettings(): Promise<DesktopSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DesktopSettings>;
    const base = defaults();
    return {
      projectsDir: parsed.projectsDir?.trim() || base.projectsDir,
      gatewayUrl: parsed.gatewayUrl?.trim() || base.gatewayUrl,
      gatewayToken: parsed.gatewayToken ?? base.gatewayToken,
      remoteTemplatesUrl: parsed.remoteTemplatesUrl ?? base.remoteTemplatesUrl,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[centraid] failed to read settings:', err);
    }
    return defaults();
  }
}

export async function saveSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings> {
  const current = await loadSettings();
  const next: DesktopSettings = {
    projectsDir: patch.projectsDir?.trim() || current.projectsDir,
    gatewayUrl: patch.gatewayUrl?.trim() || current.gatewayUrl,
    gatewayToken: patch.gatewayToken ?? current.gatewayToken,
    remoteTemplatesUrl:
      patch.remoteTemplatesUrl !== undefined
        ? patch.remoteTemplatesUrl
        : current.remoteTemplatesUrl,
  };
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  return next;
}

/** Where remote-fetched template copies are cached. Per-user, persistent. */
export function templatesCacheDir(): string {
  return path.join(app.getPath('userData'), 'templates-cache');
}
