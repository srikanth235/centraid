/** Clone + rename share these so row title cannot drift from `app.json#name`. */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface AppVisualIdentity {
  iconKey?: string;
  colorKey?: string;
}

/**
 * Backfill `iconKey` / `colorKey` from the catalog (#263). Keys already
 * present win. Unparseable → `null`.
 */
export function applyAppVisualIdentity(
  raw: string,
  visual: AppVisualIdentity
): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (visual.iconKey && typeof parsed.iconKey !== "string")
    parsed.iconKey = visual.iconKey;
  if (visual.colorKey && typeof parsed.colorKey !== "string")
    parsed.colorKey = visual.colorKey;
  return JSON.stringify(parsed, null, 2) + "\n";
}

export async function stampAppVisualIdentity(
  appDir: string,
  visual: AppVisualIdentity
): Promise<void> {
  const appJsonPath = path.join(appDir, "app.json");
  let raw: string;
  try {
    raw = await fs.readFile(appJsonPath, "utf8");
  } catch {
    return;
  }
  const next = applyAppVisualIdentity(raw, visual);
  if (next !== null && next !== raw) await fs.writeFile(appJsonPath, next);
}

export interface AutomationManifestRewriteOptions {
  /** Clone path restamps `generated`; rename leaves it. */
  stampGenerated?: boolean;
}

export function applyManifestName(
  raw: string,
  newName: string,
  opts: AutomationManifestRewriteOptions = {}
): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  parsed.name = newName;
  if (opts.stampGenerated) {
    parsed.generated = { by: "centraid-builder", at: new Date().toISOString() };
  }
  return JSON.stringify(parsed, null, 2) + "\n";
}

export async function rewriteAutomationManifestNames(
  appDir: string,
  newName: string,
  opts: AutomationManifestRewriteOptions = {}
): Promise<void> {
  const autoRoot = path.join(appDir, "automations");
  let names: string[];
  try {
    names = await fs.readdir(autoRoot);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => !name.startsWith(".") && !name.startsWith("_"))
      .map(async (name) => {
        const manifestPath = path.join(autoRoot, name, "automation.json");
        // readFile fails for non-directories / missing manifests — no Dirent check.
        let raw: string;
        try {
          raw = await fs.readFile(manifestPath, "utf8");
        } catch {
          return;
        }
        const next = applyManifestName(raw, newName, opts);
        if (next !== null) await fs.writeFile(manifestPath, next);
      })
  );
}
