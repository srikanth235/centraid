import { applyManifestName } from "./app-rewrites.js";
import { AppScaffoldError } from "./scaffold-types.js";
import type { ScaffoldFile } from "./scaffold-types.js";

// Dot-free slug; automation apps are manifest-`kind`-marked, not `auto.`-prefixed (#98).
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export function validateAppId(id: string): void {
  if (id.startsWith("_") || !ID_RE.test(id)) {
    throw new AppScaffoldError(
      "invalid_id",
      `Invalid app id "${id}". Lowercase a-z / 0-9 / "-", 1-63 chars, no leading "_".`
    );
  }
}

/** Apply a `{name?, description?}` patch (#141); return ONLY changed files. */
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
  // Renames propagate; `generated.{by,at}` is clone-only (#141).
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
