import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { HarnessConfig } from '@centraid/agent-harness';

/**
 * Persisted desktop settings. Lives at <userData>/centraid-settings.json with
 * mode 0600 — it holds the gateway bearer token.
 */
export interface DesktopSettings extends HarnessConfig {}

const FILE_NAME = 'centraid-settings.json';

function settingsPath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function defaults(): DesktopSettings {
  return {
    projectsDir: path.join(os.homedir(), 'centraid-projects'),
    gatewayUrl: 'http://127.0.0.1:7575',
    gatewayToken: '',
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
  };
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  return next;
}
