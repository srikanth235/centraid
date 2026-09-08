/*
 * EVERY SCREEN READ IS A PAGE OVER THE SEAT (#922 E2; #996 wave 5, R8).
 *
 * This began as a CENSUS: every `useReplicaQuery` call site had to name a
 * window, and the number of them tracked the population down as reads
 * converted. The population is ZERO now — the last of the forty-four went in
 * wave 5 — so the census becomes the tripwire it was always heading for:
 *
 *   no `useReplicaQuery` anywhere under `src` — the hook itself is DELETED as
 *   of #996 W5-D1's read conversion, so this no longer needs to exempt its own
 *   definition. A screen read is a statement over this phone's own copy of the
 *   vault, walked or windowed, and there is no second read vocabulary for one
 *   to come back in;
 *
 *   `acceptTruncation` and `UNBOUNDED_READ` appear nowhere under `src` at all.
 *
 * A grep is the only assertion neither can be satisfied by reintroducing the
 * old plane somewhere new.
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

  test("no screen read is a declarative one any more", () => {
    // The census that stood here counted them down: 55, 44, 32, 24, 4, none.
    // A number cannot express "none", and a floor that reached zero would
    // still admit one coming back; this is the claim itself.
    expect(readSites().map((site) => site.file)).toStrictEqual([]);
  });

  test("People and Agenda still declare the year-3 window", () => {
    // The window survives the plane: a roster is a set the member scrolls, and
    // this is the phone's declared ceiling on how much of one it holds at once.
    // What changed is that a household past it is now reported from the page's
    // own cursor rather than silently cut off.
    for (const file of [
      "apps/people/usePeople.ts",
      "apps/agenda/useAgenda.ts",
    ]) {
      const source = readFileSync(path.join(SRC, file), "utf8");
      expect(source).toContain("MOBILE_ENTITY_READ_WINDOW");
      expect(source).toContain("useSeatWindow");
    }
  });
});
