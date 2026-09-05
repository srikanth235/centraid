/*
 * EVERY SCREEN READ DECLARES ITS WINDOW (#922 E2).
 *
 * `useReplicaQuery` refuses an undeclared read at runtime (0a), which is the
 * safety net; this is the census that keeps the net from being needed. It reads
 * the phone's own source and asserts that every `useReplicaQuery` call site
 * names either a `limit` or `acceptTruncation` — so a new screen cannot ship a
 * read whose page size nobody chose, and the number of reads on the seat is a
 * number this file can state.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const SRC = path.join(import.meta.dirname, "..", "..");

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "test") sources(full, found);
      continue;
    }
    if (/\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry))
      found.push(full);
  }
  return found;
}

/** The argument list of one `useReplicaQuery(...)` call, brace-balanced. */
function callArguments(source: string, at: number): string {
  let depth = 0;
  for (let index = at; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(at, index + 1);
    }
  }
  return source.slice(at);
}

interface ReadSite {
  file: string;
  text: string;
}

function readSites(): ReadSite[] {
  const sites: ReadSite[] = [];
  for (const file of sources(SRC)) {
    if (file.endsWith(path.join("hooks", "useReplicaQuery.ts"))) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/useReplicaQuery\s*\(/gu)) {
      sites.push({
        file: path.relative(SRC, file),
        text: callArguments(source, match.index + "useReplicaQuery".length),
      });
    }
  }
  return sites;
}

/**
 * Request modules a call site may name instead of declaring the window inline.
 * Each is asserted below to declare a window on EVERY entry, so naming one is
 * not a way around the census.
 */
const SHARED_REQUESTS: Record<string, string> = {
  PHOTO_ENTITY_READS: "apps/photos/photo-entity-reads.ts",
  HOME_TILE_READS: "screens/home/home-tile-reads.ts",
  HOME_ORDERED_TILE_READS: "screens/home/home-tile-reads.ts",
  expenseTileRead: "screens/home/home-tile-reads.ts",
  idFilter: "screens/home/home-tile-reads.ts",
};

function declaresWindow(text: string): boolean {
  if (text.includes("limit") || text.includes("acceptTruncation")) return true;
  return Object.keys(SHARED_REQUESTS).some((name) => text.includes(name));
}

describe("the phone's screen reads", () => {
  test("every one declares a window, and there are this many of them", () => {
    const sites = readSites();
    // A census, not a sample: if this number moves, a screen gained or lost a
    // read and the counter suite beside this file has a new number to hold.
    expect(sites.length).toBeGreaterThanOrEqual(100);
    const undeclared = sites.filter((site) => !declaresWindow(site.text));
    expect(
      undeclared.map((site) => `${site.file}: ${site.text.slice(0, 80)}`)
    ).toStrictEqual([]);
  });

  test("a shared request module declares a window on every entry", () => {
    for (const file of new Set(Object.values(SHARED_REQUESTS))) {
      const source = readFileSync(path.join(SRC, file), "utf8");
      const entities = [...source.matchAll(/entity:/gu)].length;
      const windows = [...source.matchAll(/limit|acceptTruncation/gu)].length;
      expect(windows).toBeGreaterThanOrEqual(entities);
    }
  });

  test("People and Agenda declare the year-3 window, not the default one", () => {
    for (const file of [
      "apps/people/usePeople.ts",
      "apps/agenda/useAgenda.ts",
    ]) {
      const source = readFileSync(path.join(SRC, file), "utf8");
      expect(source).toContain("MOBILE_ENTITY_READ_WINDOW");
      // The default window is what capped a 5,000-person roster at 1,000.
      expect(source).not.toContain("acceptTruncation");
    }
  });
});
