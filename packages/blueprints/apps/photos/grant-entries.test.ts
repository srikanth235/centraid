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
    expect([...subjects].sort((a, b) => a.localeCompare(b))).toStrictEqual([
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
