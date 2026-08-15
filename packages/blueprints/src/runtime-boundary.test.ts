import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const packageDir = path.resolve(import.meta.dirname, "..");
const appsDir = path.join(packageDir, "apps");
const systemApps = [
  "agenda",
  "docs",
  "locker",
  "notes",
  "people",
  "photos",
  "tally",
  "tasks",
];

function sourceText(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return [sourceText(file)];
      return /\.(?:ts|tsx)$/u.test(entry.name)
        ? [readFileSync(file, "utf8")]
        : [];
    })
    .join("\n");
}

describe("v0 blueprint runtime boundary", () => {
  it("does not ship a Centraid-owned React runtime", () => {
    expect(existsSync(path.join(packageDir, "kit", "react-core.min.js"))).toBe(
      false
    );
    expect(existsSync(path.join(packageDir, "kit", "jsx-runtime.js"))).toBe(
      false
    );
  });

  it("does not retain the React vendor generator", () => {
    expect(
      existsSync(path.join(packageDir, "scripts", "vendor-react.mjs"))
    ).toBe(false);
  });

  it("imports workspace React directly from every system-app source graph", () => {
    for (const app of systemApps) {
      const source = sourceText(path.join(appsDir, app));
      expect(source, app).toMatch(/\bfrom\s+["']react["']/u);
      expect(source, app).not.toContain("react-core.min.js");
    }
  });

  it("keeps the maintenance-script set limited to live generated assets", () => {
    expect(
      readdirSync(path.join(packageDir, "scripts")).toSorted()
    ).toStrictEqual(["build-manifest.mjs"]);
  });

  it("ships no generated token stylesheets of its own", () => {
    // Tokens reach an app through `@centraid/design`, never through a
    // blueprint-local copy the design package could not ratchet.
    expect(existsSync(path.join(packageDir, "kit", "tokens.css"))).toBe(false);
    expect(existsSync(path.join(packageDir, "kit", "wall.css"))).toBe(false);
  });
});
