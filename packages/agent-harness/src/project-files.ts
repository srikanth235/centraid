import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ProjectFile {
  /** Path relative to the project root, posix style (e.g. "queries/foo.ts"). */
  path: string;
  content: string;
  /** UTF-8 byte length. */
  size: number;
  /** Convenience: "ts" | "js" | "html" | "css" | "json" | "md" | "other". */
  language: ProjectFileLanguage;
}

export type ProjectFileLanguage = 'ts' | 'js' | 'html' | 'css' | 'json' | 'md' | 'other';

const TEXT_EXT = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.html',
  '.htm',
  '.css',
  '.json',
  '.md',
  '.txt',
  '.svg',
]);
const SKIP_TOP = new Set([
  'node_modules',
  '.git',
  '.DS_Store',
  'dist',
  'data.sqlite',
  'current.json',
  '_registry.json',
  'versions',
  '_uploads',
  '_trash',
  'tsconfig.tsbuildinfo',
]);
const MAX_FILE_BYTES = 256 * 1024; // skip giant files for the code viewer

/**
 * Read every text file in a project folder for the desktop's code viewer.
 * Skips build artifacts, hidden files, and binaries by extension. Returns a
 * stable list sorted by path.
 */
export async function readProjectFiles(projectDir: string): Promise<ProjectFile[]> {
  const out: ProjectFile[] = [];
  await walk(projectDir, '', out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function walk(root: string, rel: string, out: ProjectFile[]): Promise<void> {
  const here = rel ? path.join(root, rel) : root;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(here, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (rel === '' && SKIP_TOP.has(e.name)) continue;
    if (e.name.startsWith('.')) continue;
    const r = rel ? path.posix.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      await walk(root, r, out);
      continue;
    }
    if (!e.isFile()) continue;

    const ext = path.extname(e.name).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;

    const abs = path.join(root, r);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) continue;
    if (stat.size > MAX_FILE_BYTES) {
      out.push({
        path: r,
        content: `// File too large (${stat.size} bytes) — open in editor.`,
        size: stat.size,
        language: languageOf(ext),
      });
      continue;
    }
    const content = await fs.readFile(abs, 'utf8').catch(() => '');
    out.push({ path: r, content, size: stat.size, language: languageOf(ext) });
  }
}

function languageOf(ext: string): ProjectFileLanguage {
  switch (ext) {
    case '.ts':
      return 'ts';
    case '.js':
    case '.mjs':
      return 'js';
    case '.html':
    case '.htm':
      return 'html';
    case '.css':
      return 'css';
    case '.json':
      return 'json';
    case '.md':
      return 'md';
    default:
      return 'other';
  }
}
