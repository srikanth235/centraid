/*
 * @centraid/app-templates
 *
 * Bundled, pre-built Centraid apps that the desktop gallery offers as
 * "clone and deploy" starting points. Each template folder sits directly at
 * the package root (`hydrate/`, `journal/`, `todos/`) and is a fully-formed
 * app (HTML/CSS/JS + queries/ + actions/ + migrations/) — identical in shape
 * to an app the user authors themselves.
 *
 * Two layers stack on top of the bundle:
 *   - A user-data cache that can hold newer copies pulled from a remote URL.
 *   - A resolver that picks bundle-or-cache per template, preferring the
 *     higher semver version.
 *
 * Public surface:
 *   - appTemplatesDir: string                                       — bundled dir
 *   - listTemplates(): Promise<TemplateMeta[]>                   — bundled manifest
 *   - resolveTemplates({ cacheDir? }): Promise<ResolvedTemplate[]>
 *   - templateSourceDir(id, { cacheDir?, source? }): string
 *   - fetchRemoteTemplates({ cacheDir, remoteUrl }): Promise<void>
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedTemplate, TemplateManifest, TemplateMeta, TemplateSource } from './types.js';

export type {
  AppKnob,
  AppKnobOption,
  AppKnobsManifest,
  ResolvedTemplate,
  TemplateKind,
  TemplateManifest,
  TemplateMeta,
  TemplateSource,
} from './types.js';

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(DIST_DIR, '..');

/** Absolute path to the bundled templates directory (the package root). */
export const appTemplatesDir: string = PACKAGE_ROOT;

/** Manifest file name — same on bundle and cache. */
const MANIFEST_FILE = 'manifest.json';

/**
 * Read the bundled manifest at `<package>/manifest.json`. Throws if the
 * manifest is missing or unparseable — those are build-system failures and
 * the caller can't do anything useful with the gallery.
 */
export async function listTemplates(): Promise<TemplateMeta[]> {
  return (await readManifest(appTemplatesDir)).templates;
}

/**
 * Merge the bundled and cached manifests, preferring whichever copy has the
 * higher semver `version` per template. Cache failures are swallowed —
 * resolution always degrades to the bundle.
 */
export async function resolveTemplates(
  opts: { cacheDir?: string } = {},
): Promise<ResolvedTemplate[]> {
  const bundle = await readManifest(appTemplatesDir).catch(() => emptyManifest());
  const cache = opts.cacheDir
    ? await readManifest(opts.cacheDir).catch(() => emptyManifest())
    : emptyManifest();

  const out: ResolvedTemplate[] = [];
  const cacheById = new Map(cache.templates.map((t) => [t.id, t]));
  const seen = new Set<string>();

  for (const b of bundle.templates) {
    const c = cacheById.get(b.id);
    if (c && compareSemver(c.version, b.version) > 0) {
      out.push({ ...c, source: 'cache' });
    } else {
      out.push({ ...b, source: 'bundle' });
    }
    seen.add(b.id);
  }
  // Cache-only templates (added remotely, not yet bundled) also surface.
  for (const c of cache.templates) {
    if (!seen.has(c.id)) out.push({ ...c, source: 'cache' });
  }
  return out;
}

/**
 * Absolute path to a template's source directory. Defaults to the bundled
 * path; pass `{ source: 'cache', cacheDir }` for the cache path.
 */
export function templateSourceDir(
  templateId: string,
  opts: { cacheDir?: string; source?: TemplateSource } = {},
): string {
  const base = opts.source === 'cache' && opts.cacheDir ? opts.cacheDir : appTemplatesDir;
  return path.join(base, templateId);
}

/**
 * Fetch the remote manifest from `<remoteUrl>/manifest.json` and download any
 * template whose remote version is strictly greater than the cached or
 * bundled copy. Files are written atomically into `<cacheDir>/<id>/...` and
 * `<cacheDir>/manifest.json` is updated last so a partial fetch never points
 * users at incomplete code.
 *
 * Silent on every failure: an offline machine, a 404, a malformed manifest,
 * or a single file fetch error → the cache stays untouched, callers keep
 * resolving to the bundle. Never throws.
 */
export async function fetchRemoteTemplates(opts: {
  cacheDir: string;
  remoteUrl: string;
  /** Optional fetch implementation (for tests / non-Node environments). */
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { cacheDir, remoteUrl } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  if (!remoteUrl) return;

  const base = stripTrailingSlash(remoteUrl);
  let remote: TemplateManifest;
  try {
    const res = await doFetch(`${base}/${MANIFEST_FILE}`);
    if (!res.ok) return;
    remote = (await res.json()) as TemplateManifest;
  } catch {
    return;
  }
  if (!remote || !Array.isArray(remote.templates)) return;

  const bundle = await readManifest(appTemplatesDir).catch(() => emptyManifest());
  const cached = await readManifest(cacheDir).catch(() => emptyManifest());
  const bundleById = new Map(bundle.templates.map((t) => [t.id, t]));
  const cachedById = new Map(cached.templates.map((t) => [t.id, t]));

  // Per-template: only fetch if remote.version beats whichever local copy
  // we'd otherwise resolve to (max of bundle, cache).
  const nextCached: TemplateMeta[] = [...cached.templates];
  let updated = false;

  for (const rt of remote.templates) {
    const localBest = bestOf(bundleById.get(rt.id), cachedById.get(rt.id));
    if (localBest && compareSemver(rt.version, localBest.version) <= 0) continue;
    const ok = await downloadTemplate(base, cacheDir, rt, doFetch);
    if (!ok) continue;
    const idx = nextCached.findIndex((t) => t.id === rt.id);
    if (idx >= 0) nextCached[idx] = rt;
    else nextCached.push(rt);
    updated = true;
  }

  if (!updated) return;
  await writeManifestAtomic(cacheDir, {
    manifestVersion: remote.manifestVersion ?? 1,
    templates: nextCached,
  });
}

// ---------------- internal helpers ----------------

async function readManifest(dir: string): Promise<TemplateManifest> {
  const raw = await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf8');
  return JSON.parse(raw) as TemplateManifest;
}

function emptyManifest(): TemplateManifest {
  return { manifestVersion: 1, templates: [] };
}

function bestOf(a?: TemplateMeta, b?: TemplateMeta): TemplateMeta | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSemver(a.version, b.version) >= 0 ? a : b;
}

/**
 * Loose semver compare: splits on `.`, parses each part as an integer, and
 * compares numerically. Returns >0 if a>b, <0 if a<b, 0 if equal. Pre-release
 * tags are ignored — fine for our `0.1.0`-style template versions.
 */
function compareSemver(a: string, b: string): number {
  const pa = a
    .split('-')[0]!
    .split('.')
    .map((p) => Number(p) || 0);
  const pb = b
    .split('-')[0]!
    .split('.')
    .map((p) => Number(p) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Downloads every file listed in `tmpl.files` into `<cacheDir>/<id>/...`.
 * Each file is written to a `.tmp` sibling first, then renamed, so a torn
 * fetch never leaves a half-written file in place. Returns false on any
 * file fetch failure — the caller skips updating the manifest entry, so a
 * later run can retry cleanly.
 */
async function downloadTemplate(
  base: string,
  cacheDir: string,
  tmpl: TemplateMeta,
  doFetch: typeof fetch,
): Promise<boolean> {
  const targetDir = path.join(cacheDir, tmpl.id);
  await fs.mkdir(targetDir, { recursive: true });
  for (const rel of tmpl.files) {
    const url = `${base}/${encodeURIComponent(tmpl.id)}/${rel
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    try {
      const res = await doFetch(url);
      if (!res.ok) return false;
      const buf = Buffer.from(await res.arrayBuffer());
      const dest = path.join(targetDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp`;
      await fs.writeFile(tmp, buf);
      await fs.rename(tmp, dest);
    } catch {
      return false;
    }
  }
  return true;
}

async function writeManifestAtomic(dir: string, manifest: TemplateManifest): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, MANIFEST_FILE);
  const tmp = `${dest}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n');
  await fs.rename(tmp, dest);
}
