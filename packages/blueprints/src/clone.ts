// governance: allow-repo-hygiene file-size-limit clone orchestration + identity/visual rewrites share one copy-then-rewrite pipeline — splitting would fracture the per-clone invariants
import { promises as fs } from "node:fs";
import path from "node:path";

import { validateAppId } from "./app-meta.js";
import {
  applyAppVisualIdentity,
  applyManifestName,
  rewriteAutomationManifestNames,
  stampAppVisualIdentity,
} from "./app-rewrites.js";
import type { AppInfo, ScaffoldFile } from "./scaffold-types.js";
import { AppScaffoldError } from "./scaffold-types.js";

export interface CloneTemplateOptions {
  appsDir: string;
  newAppId: string;
  templateDir: string;
  newName?: string;
  newDesc?: string;
  iconKey?: string;
  colorKey?: string;
}

export async function cloneTemplate(
  opts: CloneTemplateOptions
): Promise<AppInfo> {
  validateAppId(opts.newAppId);

  const destDir = path.join(opts.appsDir, opts.newAppId);
  if (await pathExists(destDir)) {
    throw new AppScaffoldError(
      "already_exists",
      `App "${opts.newAppId}" already exists at ${destDir}.`
    );
  }

  if (!(await dirExists(opts.templateDir))) {
    throw new AppScaffoldError(
      "no_app",
      `Template source not found: ${opts.templateDir}`
    );
  }

  await fs.mkdir(opts.appsDir, { recursive: true });
  await copyDir(opts.templateDir, destDir);

  await ensureCanonicalSubdirs(destDir);

  await rewriteAppJson(destDir, opts.newName, opts.newDesc, opts.newAppId);
  if (opts.iconKey || opts.colorKey) {
    await stampAppVisualIdentity(destDir, {
      iconKey: opts.iconKey,
      colorKey: opts.colorKey,
    });
  }
  await rewritePackageJson(destDir, opts.newAppId);
  if (opts.newName) {
    await rewriteAutomationManifestNames(destDir, opts.newName, {
      stampGenerated: true,
    });
  }

  const stat = await fs.stat(destDir);
  const built = await hasAnyBuiltJs(destDir);
  const meta = await readAppMeta(destDir);

  return {
    id: opts.newAppId,
    dir: destDir,
    built,
    modifiedAt: stat.mtime.toISOString(),
    name: meta.name,
    description: meta.description,
    ...(meta.kind ? { kind: meta.kind } : {}),
  };
}

export async function isDisplayNameTaken(
  appsDir: string,
  name: string,
  opts: { excludeId?: string } = {}
): Promise<boolean> {
  const target = name.trim().toLowerCase();
  if (!target) return false;
  const entries = await fs
    .readdir(appsDir, { withFileTypes: true })
    .catch(() => []);
  const findMatchingName = async (index: number): Promise<boolean> => {
    const e = entries[index];
    if (!e) return false;
    if (!e.isDirectory()) return findMatchingName(index + 1);
    if (opts.excludeId !== undefined && e.name === opts.excludeId)
      return findMatchingName(index + 1);
    if (e.name.startsWith("_") || e.name.startsWith("."))
      return findMatchingName(index + 1);
    const meta = await readAppMeta(path.join(appsDir, e.name));
    if (meta.name && meta.name.trim().toLowerCase() === target) return true;
    return findMatchingName(index + 1);
  };
  return findMatchingName(0);
}

export async function suggestAppId(
  appsDir: string,
  preferred: string,
  opts: { alwaysSuffix?: boolean } = {}
): Promise<string> {
  validateAppId(preferred);
  const start = opts.alwaysSuffix ? 2 : 1;
  const findAvailableId = async (i: number): Promise<string> => {
    if (i > 1000) {
      throw new AppScaffoldError(
        "already_exists",
        `Could not find a free id starting from "${preferred}".`
      );
    }
    const candidate = i === 1 ? preferred : `${preferred}-${i}`;
    if (!(await pathExists(path.join(appsDir, candidate)))) {
      return candidate;
    }
    return findAvailableId(i + 1);
  };
  return findAvailableId(start);
}

export async function suggestCloneIdentity(
  appsDir: string,
  preferredId: string,
  preferredName: string
): Promise<{ id: string; name: string }> {
  validateAppId(preferredId);
  const findAvailableIdentity = async (
    n: number
  ): Promise<{ id: string; name: string }> => {
    if (n > 1000) {
      throw new AppScaffoldError(
        "already_exists",
        `Could not find a free id+name starting from "${preferredId}" / "${preferredName}".`
      );
    }
    const id = n === 1 ? preferredId : `${preferredId}-${n}`;
    if (await pathExists(path.join(appsDir, id)))
      return findAvailableIdentity(n + 1);
    const name = n === 1 ? preferredName : `${preferredName} ${n}`;
    if (await isDisplayNameTaken(appsDir, name))
      return findAvailableIdentity(n + 1);
    return { id, name };
  };
  return findAvailableIdentity(1);
}

export function suggestCloneIdentityFrom(
  existing: ReadonlyArray<{ id: string; name?: string }>,
  preferredId: string,
  preferredName: string
): { id: string; name: string } {
  validateAppId(preferredId);
  const takenIds = new Set(existing.map((a) => a.id));
  const takenNames = new Set(
    existing
      .map((a) => (a.name ?? a.id).trim().toLowerCase())
      .filter((n) => n.length > 0)
  );
  for (let n = 1; n <= 1000; n++) {
    const id = n === 1 ? preferredId : `${preferredId}-${n}`;
    if (takenIds.has(id)) continue;
    const name = n === 1 ? preferredName : `${preferredName} ${n}`;
    if (takenNames.has(name.trim().toLowerCase())) continue;
    return { id, name };
  }
  throw new AppScaffoldError(
    "already_exists",
    `Could not find a free id+name starting from "${preferredId}" / "${preferredName}".`
  );
}

export interface CloneTemplateFilesOptions {
  newAppId: string;
  templateFiles: ScaffoldFile[];
  newName?: string;
  newDesc?: string;
  iconKey?: string;
  colorKey?: string;
}

export function cloneTemplateFiles(
  opts: CloneTemplateFilesOptions
): ScaffoldFile[] {
  validateAppId(opts.newAppId);
  const out = opts.templateFiles.map((f) => ({ ...f }));
  const byPath = new Map(out.map((f, i) => [f.path, i] as const));

  const set = (p: string, content: string): void => {
    const idx = byPath.get(p);
    if (idx === undefined) {
      byPath.set(p, out.length);
      out.push({ path: p, content });
    } else {
      out[idx] = { path: p, content };
    }
  };

  const appJsonIdx = byPath.get("app.json");
  let parsedAppJson: Record<string, unknown> = {};
  if (appJsonIdx !== undefined) {
    try {
      parsedAppJson = JSON.parse(out[appJsonIdx]!.content) as Record<
        string,
        unknown
      >;
    } catch {
      parsedAppJson = {};
    }
  }
  const nextName =
    opts.newName ??
    (typeof parsedAppJson.name === "string" ? parsedAppJson.name : "Untitled");
  const nextAppJson: Record<string, unknown> = {
    ...parsedAppJson,
    id: opts.newAppId,
    name: nextName,
    version: "0.1.0",
  };
  const descSource =
    opts.newDesc ??
    (typeof parsedAppJson.description === "string"
      ? parsedAppJson.description
      : "");
  const descTrimmed = descSource.trim();
  if (descTrimmed) nextAppJson.description = descTrimmed;
  else delete nextAppJson.description;
  const withVisual =
    applyAppVisualIdentity(JSON.stringify(nextAppJson, null, 2) + "\n", {
      iconKey: opts.iconKey,
      colorKey: opts.colorKey,
    }) ?? JSON.stringify(nextAppJson, null, 2) + "\n";
  set("app.json", withVisual);

  const pkgIdx = byPath.get("package.json");
  if (pkgIdx !== undefined) {
    try {
      const pkg = JSON.parse(out[pkgIdx]!.content) as {
        name?: unknown;
      } & Record<string, unknown>;
      if (
        typeof pkg.name === "string" &&
        pkg.name.startsWith("centraid-app-")
      ) {
        pkg.name = `centraid-app-${opts.newAppId}`;
        set("package.json", JSON.stringify(pkg, null, 2) + "\n");
      }
    } catch {
      // Intentionally empty.
    }
  }

  if (opts.newName) {
    for (const f of out) {
      if (!/^automations\/[^/]+\/automation\.json$/u.test(f.path)) continue;
      const next = applyManifestName(f.content, opts.newName, {
        stampGenerated: true,
      });
      if (next !== null) set(f.path, next);
    }
  }

  const hasAutomation = out.some((f) =>
    /^automations\/[^/]+\/automation\.json$/u.test(f.path)
  );
  if (!hasAutomation && !byPath.has("automations/README.md")) {
    set("automations/README.md", AUTOMATIONS_README);
  }
  return out;
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  const copyNextEntry = async (index: number): Promise<void> => {
    const entry = entries[index];
    if (!entry) return;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
    return copyNextEntry(index + 1);
  };
  return copyNextEntry(0);
}

async function rewriteAppJson(
  destDir: string,
  newName?: string,
  newDesc?: string,
  newAppId?: string
): Promise<void> {
  const appJsonPath = path.join(destDir, "app.json");
  let parsed: {
    name?: unknown;
    description?: unknown;
    version?: unknown;
  } & Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(appJsonPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    // Intentionally empty.
  }
  const next: Record<string, unknown> = {
    ...parsed,
    name:
      newName ?? (typeof parsed.name === "string" ? parsed.name : "Untitled"),
    version: "0.1.0",
  };
  if (newAppId) next.id = newAppId;
  const descSource =
    newDesc ??
    (typeof parsed.description === "string" ? parsed.description : "");
  const descTrimmed = descSource.trim();
  if (descTrimmed) next.description = descTrimmed;
  else delete next.description;
  await fs.writeFile(appJsonPath, JSON.stringify(next, null, 2) + "\n");
}

async function rewritePackageJson(
  destDir: string,
  newAppId: string
): Promise<void> {
  const pkgPath = path.join(destDir, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, "utf8");
  } catch {
    return; // template doesn't ship a package.json; nothing to rewrite.
  }
  let parsed: { name?: unknown } & Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // unparseable; leave alone.
  }
  const currentName = typeof parsed.name === "string" ? parsed.name : "";
  if (!currentName.startsWith("centraid-app-")) return;
  parsed.name = `centraid-app-${newAppId}`;
  await fs.writeFile(pkgPath, JSON.stringify(parsed, null, 2) + "\n");
}

async function readAppMeta(appDir: string): Promise<{
  name?: string;
  description?: string;
  kind?: "app" | "automation";
}> {
  try {
    const raw = await fs.readFile(path.join(appDir, "app.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      description?: unknown;
      kind?: unknown;
    };
    const name =
      typeof parsed.name === "string" && parsed.name.length > 0
        ? parsed.name
        : undefined;
    const description =
      typeof parsed.description === "string" && parsed.description.length > 0
        ? parsed.description
        : undefined;
    const kind =
      parsed.kind === "automation" || parsed.kind === "app"
        ? parsed.kind
        : undefined;
    return { name, description, kind };
  } catch {
    return {};
  }
}

const CANONICAL_SUBDIRS = ["queries", "actions", "automations"] as const;

async function ensureCanonicalSubdirs(appDir: string): Promise<void> {
  await Promise.all(
    CANONICAL_SUBDIRS.map((sub) =>
      fs.mkdir(path.join(appDir, sub), { recursive: true })
    )
  );
  const readmePath = path.join(appDir, "automations", "README.md");
  try {
    await fs.access(readmePath);
  } catch {
    await fs.writeFile(readmePath, AUTOMATIONS_README);
  }
}

const AUTOMATIONS_README = `# automations/

This folder holds the scheduled jobs the app owns. Each automation is
its own folder — \`automations/<id>/automation.json\` (the manifest) +
\`automations/<id>/handler.js\` (the handler the scheduler fires).
Existing automations appear in the desktop's App settings →
Automations panel; this README is only seeded when the folder is
empty, so seeing it means no automations ship with this app yet.

To add one, ask the assistant ("set up an automation that
runs every Monday at 9am…") — it scaffolds both files and the
desktop picks them up on the next sync. See the app root
\`README.md\` for the full manifest shape.
`;

async function hasAnyBuiltJs(appDir: string): Promise<boolean> {
  const entriesByDirectory = await Promise.all(
    ["queries", "actions"].map(async (sub) =>
      fs.readdir(path.join(appDir, sub)).catch(() => [])
    )
  );
  return entriesByDirectory.some((entries) =>
    entries.some((n) => n.endsWith(".js") || n.endsWith(".mjs"))
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}
