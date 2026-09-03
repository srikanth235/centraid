import { promises as fs } from "node:fs";
import type * as TypeImport_g9tn66 from "node:fs";
import path from "node:path";

import type { WorktreeStore } from "../worktree-store/index.js";
import { WorktreeStoreError } from "../worktree-store/index.js";

export const EDITABLE_EXT = new Set([
  ".ts",
  ".js",
  ".jsx",
  ".mjs",
  ".html",
  ".htm",
  ".css",
  ".json",
  ".md",
  ".txt",
  ".svg",
]);

const MAX_DRAFT_FILE_BYTES = 1 * 1024 * 1024; // 1 MiB per file

export interface DraftFile {
  path: string;
  content: string;
}

export async function readDraftFiles(appDir: string): Promise<DraftFile[]> {
  const out: DraftFile[] = [];
  await walk(appDir, "", out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function walk(
  root: string,
  rel: string,
  out: DraftFile[]
): Promise<void> {
  const here = rel ? path.join(root, rel) : root;
  let entries: TypeImport_g9tn66.Dirent[];
  try {
    entries = await fs.readdir(here, { withFileTypes: true });
  } catch {
    return;
  }
  const visitEntry = async (index: number): Promise<void> => {
    const e = entries[index];
    if (e === undefined) return;
    if (e.name.startsWith(".")) return visitEntry(index + 1);
    const r = rel ? path.posix.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      await walk(root, r, out);
      return visitEntry(index + 1);
    }
    if (!e.isFile()) return visitEntry(index + 1);
    if (!EDITABLE_EXT.has(path.extname(e.name).toLowerCase()))
      return visitEntry(index + 1);
    const abs = path.join(root, r);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || stat.size > MAX_DRAFT_FILE_BYTES) return visitEntry(index + 1);
    out.push({
      path: r,
      content: await fs.readFile(abs, "utf8").catch(() => ""),
    });
    return visitEntry(index + 1);
  };
  await visitEntry(0);
}

export async function writeDraftFile(
  store: WorktreeStore,
  sessionId: string,
  appId: string,
  rel: string,
  content: Buffer
): Promise<{ path: string; size: number }> {
  const appDir = await store.snapshotSessionAppDir(sessionId, appId);
  const abs = path.resolve(appDir, rel);
  if (abs !== appDir && !abs.startsWith(appDir + path.sep)) {
    throw new WorktreeStoreError(
      "invalid_app_id",
      `Refusing to write outside the app: ${rel}`
    );
  }
  if (!EDITABLE_EXT.has(path.extname(abs).toLowerCase())) {
    throw new WorktreeStoreError(
      "invalid_app_id",
      `Not an editable text file: ${rel}`
    );
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return { path: rel, size: content.byteLength };
}
