/**
 * PHOTOS SHARES THROUGH THE ONE KIT (issue #825, wave 6).
 *
 * Two halves, and the second is the one that keeps the first honest:
 *
 *  - The MAPPING law: who Photos may name in a grant. A grant is addressed to
 *    a party, so a destination that only names a vault, or one whose party id
 *    is an unsettled offline overlay, is not an audience.
 *  - The SOURCE law: no app-private share plumbing survives anywhere under
 *    `apps/photos`. This is a source scan on purpose — a rendering test proves
 *    what one component does, while the defect being prevented is a SECOND
 *    door reappearing somewhere else in the app.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const HERE = import.meta.dirname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)
      ? [file]
      : [];
  });
}

// WHO PHOTOS MAY NAME IN A GRANT is not asserted here any more (#825): the
// roster mapping is one law for every app and both seats, proved in
// `apps/_shared/grant-audiences.test.ts`. What stays below is the part that
// is genuinely about THIS app — that nothing app-private survives under it.

describe("no app-private share plumbing remains under apps/photos", () => {
  const sources = sourceFiles(HERE).map(
    (file) => [file, readFileSync(file, "utf8")] as const
  );

  it("has files to scan", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it("opens no sheet but the grant kit's, and calls no share door of its own", () => {
    for (const [file, text] of sources) {
      expect(text, file).not.toContain("ShareSheet");
      expect(text, file).not.toContain("window.centraid.share");
      expect(text, file).not.toContain("centraid.place");
    }
  });

  it("names exactly the two subjects the registry gives Photos", () => {
    const subjects = new Set(
      sources.flatMap(([, text]) =>
        [...text.matchAll(/subjectType:\s*"(?<type>[^"]+)"/gu)].flatMap(
          (match) => (match.groups?.type ? [match.groups.type] : [])
        )
      )
    );
    expect([...subjects].sort()).toStrictEqual([
      "core.collection",
      "media.asset",
    ]);
  });

  it("hardcodes no capability — the registry decides which verbs exist", () => {
    for (const [file, text] of sources) {
      expect(text, file).not.toContain('capability: "edit"');
      expect(text, file).not.toContain("capabilities: [");
    }
  });
});
