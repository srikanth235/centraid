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
