/*
 * App identity and metadata edits over a file map (issue #141).
 *
 * The gateway's code store tracks files, not directories, and app code is
 * edited over HTTP — so the rename/description path can't write to a
 * directory. It produces a **file map** (`{path, content}[]`) the caller PUTs
 * into a git-store session and publishes. These pure builders back
 * `POST /centraid/_apps/<id>/meta`.
 */

import { applyManifestName } from "./app-rewrites.js";
import { AppScaffoldError } from "./scaffold-types.js";
import type { ScaffoldFile } from "./scaffold-types.js";

// A plain filesystem-safe slug. Automation apps are marked by the
// manifest's `kind` field, not a dotted `auto.` id prefix (issue #98), so
// no dot is allowed — a tree-traversing `..` is impossible by construction.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/** Validate an app id against centraid's reserved-prefix and shape rules. */
export function validateAppId(id: string): void {
  if (id.startsWith("_") || !ID_RE.test(id)) {
    throw new AppScaffoldError(
      "invalid_id",
      `Invalid app id "${id}". Lowercase a-z / 0-9 / "-", 1-63 chars, no leading "_".`
    );
  }
}

/**
 * Apply a `{name?, description?}` patch over an app's current draft
 * files (issue #141), returning ONLY the files that changed (app.json
 * plus, on rename, any automations/<id>/automation.json#name).
 *
 * - Empty/whitespace `name` is rejected (name is mandatory).
 * - Empty/whitespace `description` clears the field.
 * - `existingNames` is the set of sibling apps (id + display name, e.g.
 *   from `listAppsWithMeta()`) for the case-insensitive duplicate-name
 *   guard; the app's own id is excluded by the caller or by id match.
 */
export function updateAppMetaFiles(
  current: ScaffoldFile[],
  id: string,
  patch: { name?: string; description?: string },
  existingNames: ReadonlyArray<{ id: string; name?: string }> = []
): ScaffoldFile[] {
  validateAppId(id);
  const byPath = new Map(current.map((f) => [f.path, f.content]));
  const renameTo = patch.name === undefined ? undefined : patch.name.trim();
  if (patch.name !== undefined && !renameTo) {
    throw new AppScaffoldError("invalid_id", "App name cannot be empty.");
  }
  if (renameTo) {
    const taken = existingNames.some(
      (a) =>
        a.id !== id &&
        (a.name ?? "").trim().toLowerCase() === renameTo.toLowerCase()
    );
    if (taken)
      throw new AppScaffoldError(
        "already_exists",
        `An app named "${renameTo}" already exists.`
      );
  }

  let parsed: Record<string, unknown> = {};
  const rawAppJson = byPath.get("app.json");
  if (rawAppJson) {
    try {
      const decoded = JSON.parse(rawAppJson) as unknown;
      if (decoded && typeof decoded === "object")
        parsed = decoded as Record<string, unknown>;
    } catch {
      /* fall through: write a fresh app.json */
    }
  }
  if (renameTo) parsed.name = renameTo;
  if (patch.description !== undefined) {
    const trimmed = patch.description.trim();
    if (trimmed) parsed.description = trimmed;
    else delete parsed.description;
  }

  const changed: ScaffoldFile[] = [
    { path: "app.json", content: JSON.stringify(parsed, null, 2) + "\n" },
  ];
  // Propagate the rename to the Automations row title so it doesn't drift
  // from app.json#name. The rename path leaves `generated.{by,at}` alone
  // (clone-only).
  if (renameTo !== undefined) {
    for (const f of current) {
      if (!/^automations\/[^/]+\/automation\.json$/u.test(f.path)) continue;
      const next = applyManifestName(f.content, renameTo);
      if (next !== null && next !== f.content)
        changed.push({ path: f.path, content: next });
    }
  }
  return changed;
}
