// EVERY icon literal in the app must resolve — checked against the source, not
// against a list someone remembers to update.
//
// `resolveIconName` THROWS on an unknown name, and an icon is rendered deep
// inside real screens, so a missing alias is not a wrong glyph: it is a render
// error that takes the whole screen down. Three separate spellings shipped that
// way (`list`, `file`, then `map-pin`), each found only by a member walking
// onto the screen that used it, because nothing connected "the spellings the
// call sites use" to "the spellings the resolver knows".
//
// This test is that connection. It greps the mobile source for icon literals
// and resolves every one. It cannot prove a glyph is the RIGHT glyph — that is
// a judgement — but it makes "this screen crashes on open" impossible to merge.
//
// Only literals are reachable this way. A computed name (`icon={someVar}`)
// still escapes, which is an argument for keeping icon names literal at the
// call site.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveIconName } from "./icon-resolver";

const SRC = join(__dirname, "../..");

/**
 * Two shapes reach the resolver, and only two:
 *
 *   - an `icon` prop or record field — `icon="x"`, `icon: "x"` — which is how
 *     every row table and wrapper component passes one through;
 *   - `<Icon name="x" …>`, the component's own prop.
 *
 * A bare `name="x"` is NOT included: most of them are accessibility labels and
 * route names, which have nothing to do with the glyph registry.
 */
const ICON_PROP = /\bicon(?:=|:\s*)"([a-zA-Z0-9_-]+)"/g;
const ICON_ELEMENT = /<Icon\b[^>]*?\bname="([a-zA-Z0-9_-]+)"/gs;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry))
      out.push(path);
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
          if (match[1]) used.add(match[1]);
    }

    // A guard on the guard: if the pattern stops matching, the test would pass
    // by finding nothing.
    expect(used.size).toBeGreaterThan(40);

    const unresolved: string[] = [];
    for (const name of [...used].sort()) {
      try {
        resolveIconName(name);
      } catch {
        unresolved.push(name);
      }
    }
    expect(unresolved).toEqual([]);
  });
});
