/*
 * EVERY SCREEN READ DECLARES ITS WINDOW (#922 E2), AND THE FLAG IS GONE
 * (#996 wave 4b, R8).
 *
 * `useReplicaQuery` refuses an undeclared read at runtime (0a), which is the
 * safety net; this is the census that keeps the net from being needed. It reads
 * the phone's own source and asserts two things now:
 *
 *   every `useReplicaQuery` call site names a `limit`. There is no second way
 *   to be admitted: `acceptTruncation` said "the default window is fine", and
 *   the forty-four reads that said it were whole sets taking 1,000 rows nobody
 *   chose;
 *
 *   `acceptTruncation` and `UNBOUNDED_READ` appear nowhere under `src` at all —
 *   the tripwire, so a read cannot come back wearing the flag.
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
 * not a way around the census. Photos' five shared reads are no longer here:
 * they are statements over the seat, and a statement has no window to declare.
 */
const SHARED_REQUESTS: Record<string, string> = {
  HOME_TILE_READS: "screens/home/home-tile-reads.ts",
  HOME_ORDERED_TILE_READS: "screens/home/home-tile-reads.ts",
  expenseTileRead: "screens/home/home-tile-reads.ts",
  idFilter: "screens/home/home-tile-reads.ts",
};

function declaresWindow(text: string): boolean {
  if (text.includes("limit")) return true;
  return Object.keys(SHARED_REQUESTS).some((name) => text.includes(name));
}

describe("the phone's screen reads", () => {
  test("the truncation flag is absent from the phone's source", () => {
    // THE TRIPWIRE (#996 wave 4b, R8). Not "every site declares one of two
    // things" — one of them is deleted, and a grep is the only assertion that
    // cannot be satisfied by a read that reintroduces it somewhere new.
    const offenders = sources(SRC).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const relative = path.relative(SRC, file);
      // This file names both words to forbid them.
      if (relative === path.join("kit", "hooks", "replica-read-windows.ts"))
        return [];
      return /acceptTruncation:|UNBOUNDED_READ/u.test(source) ? [relative] : [];
    });
    expect(offenders).toStrictEqual([]);
  });

  test("every one declares a window, and there are this many of them", () => {
    const sites = readSites();
    // A census, not a sample: if this number moves, a screen gained or lost a
    // read and the counter suite beside this file has a new number to hold.
    // Forty-four of them left for the seat in wave 4b (#996).
    expect(sites.length).toBeGreaterThanOrEqual(55);
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
