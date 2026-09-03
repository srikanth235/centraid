/*
 * APPS_OPEN handler core (issue #137 reveal-in-Finder; #865 hardening).
 *
 * Electron-free so the traversal gate is unit-testable without the electron
 * module graph: `ipc.ts` supplies the live `resolveAppRevealDir` and
 * `shell.openPath` deps. The id is validated BEFORE any path join — a
 * renderer-supplied "../../" must never reach the filesystem.
 */
import { parseRevealableAppId } from "./ipc-core.js";

export interface AppRevealDeps {
  resolveDir: (appId: string) => Promise<string>;
  openPath: (dir: string) => Promise<string>;
}

export async function openAppFolder(
  input: unknown,
  deps: AppRevealDeps
): Promise<{ ok: true }> {
  const appId = parseRevealableAppId(input);
  const dir = await deps.resolveDir(appId);
  const openErr = await deps.openPath(dir);
  if (openErr) throw new Error(`Could not open ${dir}: ${openErr}`);
  return { ok: true };
}
