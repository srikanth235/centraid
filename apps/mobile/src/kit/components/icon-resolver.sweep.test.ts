import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveIconName } from "./icon-resolver";

const SRC = path.join(__dirname, "../..");

const ICON_PROP = /\bicon(?:=|:\s*)"(?<name>[a-zA-Z0-9_-]+)"/gu;
const ICON_ELEMENT = /<Icon\b[^>]*?\bname="(?<name>[a-zA-Z0-9_-]+)"/gsu;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const child = path.join(dir, entry);
    if (statSync(child).isDirectory()) walk(child, out);
    else if (/\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry))
      out.push(child);
  }
  return out;
}

describe("icon call sites", () => {
  it("resolves every icon name literal in the mobile source", () => {
    const used = new Set<string>();
    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const pattern of [ICON_PROP, ICON_ELEMENT])
        for (const match of source.matchAll(pattern))
          if (match.groups?.name) used.add(match.groups.name);
    }

    expect(used.size).toBeGreaterThan(40);

    const unresolved: string[] = [];
    for (const name of [...used].sort()) {
      try {
        resolveIconName(name);
      } catch {
        unresolved.push(name);
      }
    }
    expect(unresolved).toStrictEqual([]);
  });
});
