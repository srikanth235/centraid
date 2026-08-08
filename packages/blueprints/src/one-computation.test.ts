/** Mechanical guard for docs/blueprint-seats.md's one-computation rule. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const WEB = path.join(ROOT, "packages/blueprints/apps/photos");
const MOBILE = path.join(ROOT, "apps/mobile/src/apps/photos");
const RUNTIME_EXPORT =
  /export\s+(?:async\s+)?(?:function|const)\s+(?<name>[A-Za-z_$][\w$]*)/gu;

function pureFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return pureFiles(file);
    return entry.name.endsWith(".ts") &&
      !/\.(?:test|spec)\.ts$/u.test(entry.name)
      ? [file]
      : [];
  });
}

function runtimeExports(dir: string): Map<string, string[]> {
  const exports = new Map<string, string[]>();
  for (const file of pureFiles(dir)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(RUNTIME_EXPORT)) {
      const name = match.groups?.name;
      if (!name) continue;
      const files = exports.get(name);
      if (files) files.push(file);
      else exports.set(name, [file]);
    }
  }
  return exports;
}

function collisions(
  left: ReadonlyMap<string, string[]>,
  right: ReadonlyMap<string, string[]>
): string[] {
  return [...left.keys()].filter((name) => right.has(name)).sort();
}

// Pre-existing #725-out-of-scope pure laws. This is a tighten-only baseline:
// a new collision fails, and deleting one shrinks this list in the same PR.
const LEGACY_COLLISIONS = [
  "DEFAULT_RUNG",
  "EDITOR_RATIOS",
  "RUNGS",
  "RUNG_LABELS",
  "SAVE_AS_NEW",
  "SAVE_AS_NEW_EXPLANATION",
  "centredCrop",
  "emptyTrashOrder",
  "emptyTrashSummary",
  "isZoomed",
  "justify",
  "ratioValue",
  "rungHeight",
  "videoKindLabel",
  "zoomIn",
  "zoomOut",
  "zoomReadout",
] as const;

describe("[law:one-computation] Photos pure product law", () => {
  it("adds no seat-local runtime export collision", () => {
    expect(
      collisions(runtimeExports(WEB), runtimeExports(MOBILE))
    ).toStrictEqual([...LEGACY_COLLISIONS]);
  });

  it("SABOTAGE: the collision detector rejects a second face-crop owner", () => {
    expect(
      collisions(
        new Map([["faceCropStyle", ["web.ts"]]]),
        new Map([["faceCropStyle", ["mobile.ts"]]])
      )
    ).toStrictEqual(["faceCropStyle"]);
  });

  it("web and mobile import shared crop and people-count implementations", () => {
    const webCrop = readFileSync(
      path.join(WEB, "components/FaceReview.tsx"),
      "utf8"
    );
    const mobileCrop = readFileSync(
      path.join(MOBILE, "FaceReview.tsx"),
      "utf8"
    );
    const webPeople = readFileSync(path.join(WEB, "queries/people.ts"), "utf8");
    const mobilePeople = readFileSync(
      path.join(MOBILE, "people-model.ts"),
      "utf8"
    );
    expect(webCrop).toContain("_shared/face-crop");
    expect(mobileCrop).toContain("_shared/face-crop");
    expect(webPeople).toContain("_shared/people-counts");
    expect(mobilePeople).toContain("_shared/people-counts");
  });
});
