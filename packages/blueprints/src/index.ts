/*
 * @centraid/blueprints
 *
 * How Centraid code comes into being. Two paths, one home:
 *
 *   1. Automation clone — `cloneTemplate` / `cloneTemplateFiles` copy a
 *      bundled automation into editable, user-owned app code.
 *   2. UI-app install — bundled apps under `apps/<id>/` are enrolled in place
 *      (`consent.app`, origin `installed`, declared-scope grants). No source is
 *      copied: the main client compiles their UI modules from this package,
 *      while the gateway reads the same tree for catalog metadata and scopes.
 *
 * The catalog half: each source folder lives under a kind-segment directory —
 * `apps/<id>/` for shipped UI apps (`apps/agenda/`, `apps/notes/`, …) and
 * `automations/<id>/` for cloneable automations. Both carry runtime-ready
 * files; ownership and upgrade behavior, not source shape, distinguish the
 * paths. A user-data cache dir may hold newer per-template copies, and the
 * resolver picks bundle-or-cache per template by higher semver version.
 *
 * Depends only on `@centraid/design` — no engine, no store. Consumed by
 * `@centraid/server` (lifecycle routes) and `@centraid/server/automation` (the
 * `ScaffoldFile` contract for automation scaffolding).
 *
 * Catalog surface:
 *   - appTemplatesDir: string                                       — bundled dir
 *   - listTemplates(): Promise<TemplateMeta[]>                   — bundled manifest
 *   - resolveTemplates({ cacheDir? }): Promise<ResolvedTemplate[]>
 *   - templateSourceDir(id, { kind?, cacheDir?, source? }): string
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ResolvedTemplate,
  TemplateKind,
  TemplateManifest,
  TemplateMeta,
  TemplateSource,
} from "./types.js";

export type {
  AppKnob,
  AppKnobOption,
  AppKnobsManifest,
  ResolvedTemplate,
  TemplateKind,
  TemplateManifest,
  TemplateMeta,
  TemplateSource,
} from "./types.js";
export { tallyGroupNet, type TallyBalanceData } from "./tally-balance.js";

const DIST_DIR = import.meta.dirname;
const PACKAGE_ROOT = path.resolve(DIST_DIR, "..");

/** Absolute path to the bundled templates directory (the package root). */
export const appTemplatesDir: string = PACKAGE_ROOT;

/** Manifest file name — same on bundle and cache. */
const MANIFEST_FILE = "manifest.json";

/**
 * The kind-segment directory a template's files live under, relative to the
 * bundle/cache/remote base: `automations/` for automation apps, `apps/` for
 * everything else. Derived from `kind` (no separate field) and shared by the
 * disk resolver ({@link templateSourceDir}) and the manifest build script, so
 * both stay in lock-step.
 */
export function templateKindDir(kind: TemplateKind | undefined): string {
  return kind === "automation" ? "automations" : "apps";
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
 * The bundled APP-kind templates (automations excluded). Issue #434:
 * install = enroll the shipped blueprint in place, no copy — so these ids
 * are RESERVED (a code-store app must never shadow one). The main client owns
 * the system UI; the gateway reads {@link bundledAppDir} for metadata and
 * scopes. Automation templates are excluded because they still compile into
 * the vault's git code store.
 */
export async function listBundledAppTemplates(): Promise<TemplateMeta[]> {
  return (await listTemplates()).filter(
    (t) => (t.kind ?? "app") !== "automation"
  );
}

/**
 * Absolute dir for a bundled APP-kind template inside the shipped
 * `@centraid/blueprints` package (`<package>/apps/<id>/`). Issue #434: these
 * are real directories on disk under the installed package — no per-vault
 * copy or materialized cache is needed. The main client compiles the UI from
 * this tree; the gateway reads it for metadata and scopes.
 */
export function bundledAppDir(id: string): string {
  return templateSourceDir(id, { kind: "app" });
}

/**
 * Merge the bundled and cached manifests, preferring whichever copy has the
 * higher semver `version` per template. Cache failures are swallowed —
 * resolution always degrades to the bundle.
 */
export async function resolveTemplates(
  opts: { cacheDir?: string } = {}
): Promise<ResolvedTemplate[]> {
  const bundle = await readManifest(appTemplatesDir).catch(() =>
    emptyManifest()
  );
  const cache = opts.cacheDir
    ? await readManifest(opts.cacheDir).catch(() => emptyManifest())
    : emptyManifest();

  const out: ResolvedTemplate[] = [];
  const cacheById = new Map(cache.templates.map((t) => [t.id, t]));
  const seen = new Set<string>();

  for (const b of bundle.templates) {
    const c = cacheById.get(b.id);
    if (c && compareSemver(c.version, b.version) > 0) {
      out.push({ ...c, source: "cache" });
    } else {
      out.push({ ...b, source: "bundle" });
    }
    seen.add(b.id);
  }
  // Cache-only templates (added remotely, not yet bundled) also surface.
  for (const c of cache.templates) {
    if (!seen.has(c.id)) out.push({ ...c, source: "cache" });
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
  opts: { kind?: TemplateKind; cacheDir?: string; source?: TemplateSource } = {}
): string {
  const base =
    opts.source === "cache" && opts.cacheDir ? opts.cacheDir : appTemplatesDir;
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
  template: Pick<TemplateMeta, "id" | "files" | "kind"> & {
    source?: TemplateSource;
  },
  opts: { cacheDir?: string } = {}
): Promise<{ path: string; content: string }[]> {
  const dir = templateSourceDir(template.id, {
    ...(template.kind === undefined ? {} : { kind: template.kind }),
    ...(opts.cacheDir === undefined ? {} : { cacheDir: opts.cacheDir }),
    ...(template.source === undefined ? {} : { source: template.source }),
  });
  return Promise.all(
    template.files.map(async (rel) => ({
      path: rel,
      content: await fs.readFile(path.join(dir, rel), "utf8"),
    }))
  );
}

// ──────────────── internal helpers ────────────────

async function readManifest(dir: string): Promise<TemplateManifest> {
  const raw = await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8");
  return JSON.parse(raw) as TemplateManifest;
}

function emptyManifest(): TemplateManifest {
  return { manifestVersion: 1, templates: [] };
}

/**
 * Loose semver compare: splits on `.`, parses each part as an integer, and
 * compares numerically. Returns >0 if a>b, <0 if a<b, 0 if equal. Pre-release
 * tags are ignored — fine for our `0.1.0`-style template versions.
 */
function compareSemver(a: string, b: string): number {
  const pa = a
    .split("-")[0]!
    .split(".")
    .map((p) => Number(p) || 0);
  const pb = b
    .split("-")[0]!
    .split(".")
    .map((p) => Number(p) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Template clone + app metadata edits (moved out of @centraid/server/engine in
// #151). The gateway lifecycle routes use the file-map (`*Files`) variants;
// the disk wrappers back the local paths.
// ───────────────────────────────────────────────────────────────────────────
export { updateAppMetaFiles, validateAppId } from "./app-meta.js";
export {
  cloneTemplate,
  cloneTemplateFiles,
  isDisplayNameTaken,
  suggestAppId,
  suggestCloneIdentity,
  suggestCloneIdentityFrom,
  type CloneTemplateOptions,
  type CloneTemplateFilesOptions,
} from "./clone.js";
export {
  AppScaffoldError,
  type AppScaffoldErrorCode,
  type AppInfo,
  type ScaffoldFile,
} from "./scaffold-types.js";
