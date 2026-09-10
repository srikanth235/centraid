// NO EXCEPTION EVER REACHES A MEMBER (#1015, S14 — ruling R-A-15).
//
// The audit found the same defect in every app: a `catch` block pasting
// `error.message` into the one status line. What `error.message` holds on this
// seat is whatever the transport, the SQLite driver or the intent admitter
// threw — "Network request failed", a constraint name, a status code, or the
// empty string — and none of it is a sentence a member can act on.
//
// `surfaceWriteFailure` and `readFailure` are the two doors, and both of them
// now log the raw and say the surface's own noun plus the one retry word. This
// sweep is what stops the forty-first call site from re-typing the old one.
//
// It is a SOURCE sweep because the thing being pinned is what a `catch` block
// DOES with what it caught, which no rendered tree can show once the string is
// gone from the copy.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = __dirname;

/**
 * Lifting a caught exception into a string. Every one of these is fine in a
 * `console.warn` argument list — that is where the raw belongs — and none of
 * them may end up inside a sentence the member reads.
 */
const RAW_EXCEPTION =
  /(?:\berror\b|\berr\b|\bcaughtError\b|\bcause\b)\s*\.\s*message|String\(\s*(?:error|err|caughtError)\s*\)|(?:\berror\b|\berr\b|\bcaughtError\b)\s*\.\s*toString\(\)/u;

/** The trees a member actually reads copy from. */
const COPY_TREES = ["apps", "screens"] as const;

/** The two doors themselves: neither may interpolate what it was handed. */
const COPY_DOORS = [
  "kit/replica/write-outcome.ts",
  "kit/rooms/read-failure.ts",
] as const;

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourcesUnder(full, out);
    else if (/\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry))
      out.push(full);
  }
  return out;
}

/**
 * The argument text of every `name(...)` call in `source`, matched by counting
 * parentheses rather than by a regex, so a nested call or a template literal
 * inside the argument is part of what is checked.
 */
function callArguments(source: string, name: string): string[] {
  const found: string[] = [];
  const opener = new RegExp(`\\b${name}\\(`, "gu");
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    const start = cursor;
    while (cursor < source.length && depth > 0) {
      const char = source[cursor];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      cursor += 1;
    }
    found.push(source.slice(start, cursor - 1));
  }
  return found;
}

const COPY_SOURCES = COPY_TREES.flatMap((tree) =>
  sourcesUnder(path.join(SRC, tree)).map(
    (file) => [path.relative(SRC, file), readFileSync(file, "utf8")] as const
  )
);

describe("raw exceptions never become member copy", () => {
  it("has a copy tree to sweep", () => {
    expect(COPY_SOURCES.length).toBeGreaterThan(100);
  });

  it("posts no status line built from an exception", () => {
    const offenders = COPY_SOURCES.flatMap(([file, source]) =>
      callArguments(source, "postStatus")
        .filter((argument) => RAW_EXCEPTION.test(argument))
        .map((argument) => `${file}: postStatus(${argument.trim()})`)
    );
    expect(offenders).toStrictEqual([]);
  });

  it("builds no room error from an exception", () => {
    // `RoomError.detail` is the field that invites it — the room contract says
    // in so many words that it is never an exception string.
    const offenders = COPY_SOURCES.flatMap(([file, source]) =>
      source
        .split("\n")
        .filter(
          (line) =>
            /^\s*(?:detail|body|title):/u.test(line) && RAW_EXCEPTION.test(line)
        )
        .map((line) => `${file}: ${line.trim()}`)
    );
    expect(offenders).toStrictEqual([]);
  });

  it("smuggles no refusal through an Error to be shown", () => {
    // `new Error(reason)` handed to the failure door was how a vault refusal
    // got printed verbatim (`locker-writes.ts` did it three times). A refusal
    // has its own channel now: `surfaceWriteRefusal`.
    const offenders = COPY_SOURCES.flatMap(([file, source]) =>
      callArguments(source, "surfaceWriteFailure")
        .filter((argument) => argument.includes("new Error("))
        .map((argument) => `${file}: surfaceWriteFailure(${argument.trim()})`)
    );
    expect(offenders).toStrictEqual([]);
  });

  it("keeps the two doors from interpolating what they caught", () => {
    for (const relative of COPY_DOORS) {
      const source = readFileSync(path.join(SRC, relative), "utf8");
      // The prose in both files NAMES the defect, so only code lines count.
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
        .join("\n");
      expect([relative, RAW_EXCEPTION.test(code)]).toStrictEqual([
        relative,
        false,
      ]);
    }
  });

  it("gives every write failure a noun, not a bare verb", () => {
    // The status line is signage: it names the thing that did not happen
    // ("Event not saved"), never the verb alone ("Not written", "Failed").
    const titles = COPY_SOURCES.flatMap(([file, source]) =>
      callArguments(source, "surfaceWriteFailure")
        .map((argument) => argument.split(",")[1]?.trim() ?? "")
        .filter((title) => title.startsWith('"'))
        .map((title) => `${file}: ${title.replace(/^"|"$/gu, "")}`)
    );
    expect(titles.length).toBeGreaterThan(20);
    expect(
      titles.filter((entry) =>
        /:\s*(?:not|no|could|failed|error|cancellation)\b/iu.test(entry)
      )
    ).toStrictEqual([]);
  });
});
