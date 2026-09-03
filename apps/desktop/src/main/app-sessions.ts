import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { openSession } from "./apps-store-client.js";
import { vaultCodeStoreDir } from "./gateway-paths.js";
import { assertRevealableAppId } from "./ipc-core.js";
import { loadSettings } from "./settings.js";

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

const sessions = new Map<string, Promise<string>>();

/** Renderer duplicates this scheme (`gateway-client-editing.ts`). */
export function desktopSessionIdFor(appId: string): string {
  return `desktop-${appId}`;
}

export async function ensureAppSession(appId: string): Promise<string> {
  const existing = sessions.get(appId);
  if (existing) {
    try {
      return await existing;
    } catch {
      sessions.delete(appId);
    }
  }
  const wanted = desktopSessionIdFor(appId);
  // Re-open of the same id 409s; treat "already exists" as success.
  const p = openSession(wanted).catch((error: unknown) => {
    if (
      error instanceof Error &&
      /already has a worktree|session_exists/u.test(error.message)
    ) {
      return wanted;
    }
    throw error;
  });
  sessions.set(appId, p);
  return p;
}

export function resetAppSessions(): void {
  sessions.clear();
}

/** Backstop: APPS_OPEN and AGENT_* are local-gateway-only (#141). */
export async function assertActiveGatewayLocal(action: string): Promise<void> {
  const settings = await loadSettings();
  if (settings.activeGatewayKind !== "local") {
    throw new Error(
      `${action} requires the local gateway (active is ${settings.activeGatewayKind})`
    );
  }
}

export async function ensureAppSessionDir(appId: string): Promise<string> {
  // Issue #865: the id is joined into an on-disk path below (and handed to
  // external binaries by the AGENT_* builders), so grammar-check it before
  // any join — a traversal id must never build a filesystem path.
  assertRevealableAppId(appId);
  await assertActiveGatewayLocal(`editing app "${appId}"`);
  const settings = await loadSettings();
  const sessionId = await ensureAppSession(appId);
  if (!settings.activeVaultId)
    throw new Error("no active vault — the code store is not mounted yet");
  const codeStore = vaultCodeStoreDir(settings.activeVaultId);
  return path.join(
    codeStore,
    "worktrees",
    "sessions",
    sessionId,
    "apps",
    appId
  );
}

export async function resolveAppRevealDir(appId: string): Promise<string> {
  // Backstop for the grammar gate the APPS_OPEN handler already applies
  // (issue #865) — this path reaches shell.openPath verbatim.
  assertRevealableAppId(appId);
  await assertActiveGatewayLocal(`revealing app "${appId}"`);
  const settings = await loadSettings();
  if (!settings.activeVaultId)
    throw new Error("no active vault — the code store is not mounted yet");
  const codeStore = vaultCodeStoreDir(settings.activeVaultId);
  const liveDir = path.join(codeStore, "active-main", "apps", appId);
  if (await dirExists(liveDir)) return liveDir;
  // Session worktree is lazy; mkdir or shell.openPath no-ops.
  const sessionDir = await ensureAppSessionDir(appId);
  await mkdir(sessionDir, { recursive: true });
  return sessionDir;
}
