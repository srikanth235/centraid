/*
 * @centraid/blueprints
 *
 * How a new centraid app comes into being. Two kinds of blueprint, one home:
 *
 *   1. Blank scaffold — `scaffoldApp` / `scaffoldAppFiles` stamp out an empty
 *      app from `scaffold-defaults`.
 *   2. Template clone — `cloneTemplate` / `cloneTemplateFiles` copy one of the
 *      bundled gallery templates into a fresh app.
 *
 * The gallery half: bundled, pre-built Centraid apps the desktop offers as
 * "clone and deploy" starting points. Each template folder lives under a
 * kind-segment directory — `apps/<id>/` for full UI apps (`apps/hydrate/`,
 * `apps/journal/`, `apps/todos/`, …) and `automations/<id>/` for automation
 * apps — and is a fully-formed app (HTML/CSS/JS + queries/ + actions/ +
 * migrations/) — identical in shape to an app the user authors themselves.
 * Two layers stack on top of the bundle:
 *   - A user-data cache that can hold newer copies pulled from a remote URL.
 *   - A resolver that picks bundle-or-cache per template, preferring the
 *     higher semver version.
 *
 * Depends only on `@centraid/design-tokens` — no engine, no store. Consumed by
 * `@centraid/gateway` (lifecycle routes) and `@centraid/automation` (the
 * `ScaffoldFile` contract for automation scaffolding).
 *
 * Gallery surface:
 *   - appTemplatesDir: string                                       — bundled dir
 *   - listTemplates(): Promise<TemplateMeta[]>                   — bundled manifest
 *   - resolveTemplates({ cacheDir? }): Promise<ResolvedTemplate[]>
 *   - templateSourceDir(id, { kind?, cacheDir?, source? }): string
 *   - fetchRemoteTemplates({ cacheDir, remoteUrl }): Promise<void>
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ResolvedTemplate,
  TemplateKind,
  TemplateManifest,
  TemplateMeta,
  TemplateSource,
} from './types.js';

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
 * The kind-segment directory a template's files live under, relative to the
 * bundle/cache/remote base: `automations/` for automation apps, `apps/` for
 * everything else. Derived from `kind` (no separate field) and shared by the
 * disk resolver ({@link templateSourceDir}), the remote fetcher
 * ({@link downloadTemplate}), and the manifest build script, so all three
 * stay in lock-step. The bundled layout doubles as the remote layout (GitHub
 * raw serves the checked-in tree), so this prefix must match on disk and over
 * the wire.
 */
export function templateKindDir(kind: TemplateKind | undefined): string {
  return kind === 'automation' ? 'automations' : 'apps';
}

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
 * Absolute path to a template's source directory:
 * `<base>/<apps|automations>/<id>`. Defaults to the bundled path; pass
 * `{ source: 'cache', cacheDir }` for the cache path. `kind` selects the
 * kind-segment directory (see {@link templateKindDir}) and defaults to
 * `'app'` when omitted.
 */
export function templateSourceDir(
  templateId: string,
  opts: { kind?: TemplateKind; cacheDir?: string; source?: TemplateSource } = {},
): string {
  const base = opts.source === 'cache' && opts.cacheDir ? opts.cacheDir : appTemplatesDir;
  return path.join(base, templateKindDir(opts.kind), templateId);
}

/**
 * Read a template's files into an in-memory file map (issue #141). The
 * desktop owns the bundled/cached catalog locally, so it reads a
 * template's files here and pushes them to the gateway over HTTP
 * (`cloneTemplateFiles` → session PUT → publish) — the remote gateway
 * never needs the catalog. `files` is the manifest's enumerated relative
 * paths; `source` selects bundle vs cache (same resolution as
 * {@link templateSourceDir}). A file listed in the manifest but missing
 * on disk is a build/catalog error and surfaces as a read rejection.
 */
export async function readTemplateFiles(
  template: Pick<TemplateMeta, 'id' | 'files' | 'kind'> & { source?: TemplateSource },
  opts: { cacheDir?: string } = {},
): Promise<{ path: string; content: string }[]> {
  const dir = templateSourceDir(template.id, {
    ...(template.kind !== undefined ? { kind: template.kind } : {}),
    ...(opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}),
    ...(template.source !== undefined ? { source: template.source } : {}),
  });
  return Promise.all(
    template.files.map(async (rel) => ({
      path: rel,
      content: await fs.readFile(path.join(dir, rel), 'utf8'),
    })),
  );
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
 * Downloads every file listed in `tmpl.files` into
 * `<cacheDir>/<apps|automations>/<id>/...`, mirroring the bundled layout.
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
  const kindDir = templateKindDir(tmpl.kind);
  const targetDir = path.join(cacheDir, kindDir, tmpl.id);
  await fs.mkdir(targetDir, { recursive: true });
  for (const rel of tmpl.files) {
    const url = `${base}/${kindDir}/${encodeURIComponent(tmpl.id)}/${rel
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

// ---------------------------------------------------------------------------
// App scaffolders + clone (moved out of @centraid/app-engine in #151; both
// "how a new app comes into being" — a blank scaffold and a cloned template
// are both blueprints you instantiate). The gateway lifecycle routes use the
// file-map (`*Files`) variants; the disk wrappers back the CLI / local paths.
// ---------------------------------------------------------------------------
export {
  scaffoldAppFiles,
  updateAppMetaFiles,
  appPackageJson,
  validateAppId,
  type ScaffoldFile,
  type ScaffoldAppOpts,
} from './scaffold-files.js';
export {
  scaffoldApp,
  listAppsOnDisk,
  deleteApp,
  updateAppMeta,
  isDisplayNameTaken,
} from './scaffold.js';
export {
  cloneTemplate,
  cloneTemplateFiles,
  suggestAppId,
  suggestCloneIdentity,
  suggestCloneIdentityFrom,
  type CloneTemplateOptions,
  type CloneTemplateFilesOptions,
} from './clone.js';
export { AppScaffoldError, type AppScaffoldErrorCode, type AppInfo } from './scaffold-types.js';
