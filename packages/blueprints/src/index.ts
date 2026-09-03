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

export const appTemplatesDir: string = PACKAGE_ROOT;

const MANIFEST_FILE = "manifest.json";

export function templateKindDir(kind: TemplateKind | undefined): string {
  return kind === "automation" ? "automations" : "apps";
}

export async function listTemplates(): Promise<TemplateMeta[]> {
  return (await readManifest(appTemplatesDir)).templates;
}

export async function listBundledAppTemplates(): Promise<TemplateMeta[]> {
  return (await listTemplates()).filter(
    (t) => (t.kind ?? "app") !== "automation"
  );
}

export function bundledAppDir(id: string): string {
  return templateSourceDir(id, { kind: "app" });
}

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
  for (const c of cache.templates) {
    if (!seen.has(c.id)) out.push({ ...c, source: "cache" });
  }
  return out;
}

export function templateSourceDir(
  templateId: string,
  opts: { kind?: TemplateKind; cacheDir?: string; source?: TemplateSource } = {}
): string {
  const base =
    opts.source === "cache" && opts.cacheDir ? opts.cacheDir : appTemplatesDir;
  return path.join(base, templateKindDir(opts.kind), templateId);
}

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

async function readManifest(dir: string): Promise<TemplateManifest> {
  const raw = await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8");
  return JSON.parse(raw) as TemplateManifest;
}

function emptyManifest(): TemplateManifest {
  return { manifestVersion: 1, templates: [] };
}

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
