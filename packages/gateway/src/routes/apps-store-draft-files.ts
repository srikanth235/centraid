// Draft file read/write inside a session worktree (issue #137) — the I/O
// helpers behind `PUT`/`GET`/`DELETE /_apps/<id>/files`. Split out of
// apps-store-routes.ts to keep the route table under the repo file-size
// limit; the sandboxing (refuse writes outside the app dir, text-only
// extensions) lives here with the reads/writes it guards.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WorktreeStore, WorktreeStoreError } from '../worktree-store/index.js';

/** Text extensions a draft file write accepts — mirrors agent-harness. */
export const EDITABLE_EXT = new Set([
  '.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.html',
  '.htm',
  '.css',
  '.json',
  '.md',
  '.txt',
  '.svg',
]);

const MAX_DRAFT_FILE_BYTES = 1 * 1024 * 1024; // 1 MiB per file

export interface DraftFile {
  path: string;
  content: string;
}

export async function readDraftFiles(appDir: string): Promise<DraftFile[]> {
  const out: DraftFile[] = [];
  await walk(appDir, '', out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function walk(root: string, rel: string, out: DraftFile[]): Promise<void> {
  const here = rel ? path.join(root, rel) : root;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(here, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? path.posix.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      await walk(root, r, out);
      continue;
    }
    if (!e.isFile()) continue;
    if (!EDITABLE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    const abs = path.join(root, r);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || stat.size > MAX_DRAFT_FILE_BYTES) continue;
    out.push({ path: r, content: await fs.readFile(abs, 'utf8').catch(() => '') });
  }
}

export async function writeDraftFile(
  store: WorktreeStore,
  sessionId: string,
  appId: string,
  rel: string,
  content: Buffer,
): Promise<{ path: string; size: number }> {
  const appDir = await store.snapshotSessionAppDir(sessionId, appId);
  const abs = path.resolve(appDir, rel);
  if (abs !== appDir && !abs.startsWith(appDir + path.sep)) {
    throw new WorktreeStoreError('invalid_app_id', `Refusing to write outside the app: ${rel}`);
  }
  if (!EDITABLE_EXT.has(path.extname(abs).toLowerCase())) {
    throw new WorktreeStoreError('invalid_app_id', `Not an editable text file: ${rel}`);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return { path: rel, size: content.byteLength };
}
