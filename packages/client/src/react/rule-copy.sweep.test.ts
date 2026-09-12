// THE DESKTOP'S RULE SCREENS SAY "RULE" (#1015, R-SH-11 finished by R-NY-9).
//
// The place is Rules and its rows are rules, on both seats. R-SH-11 renamed
// the shared pool and the place; the desktop's own editor, viewer, templates
// and run screens kept calling their subject an automation, which is the
// divergence the ruling exists to end: a place named one thing whose
// contents are called another.
//
// `automations` stays as the wire flag, the route key, the deep-link path,
// the prefs keys and the module and file names — identifiers are not copy.
// This is a SOURCE sweep, because the copy lives in string literals and JSX
// text across two dozen files and no single rendered tree shows all of it.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..");

/** The desktop rule screens: the editor, the viewer, templates and runs. */
const SCREEN_DIRS = ["react/screens", "react/shell/routes"] as const;
const SCREEN_FILE = /^(?:automation|runview|runs|templates)\w*\.tsx?$/iu;
const NOT_COPY_FILE = /\.test\.tsx?$|test-fixtures|TestKit|\.fixture\./u;
/**
 * Copy pools that name a rule from outside the screens above: the overview's
 * shared pool, and the caller phrase Needs you prints for an `agent` caller —
 * the one R-SH-11 named by hand and the one seat that still said "automation".
 */
const SHARED_COPY = [
  "automations-copy.ts",
  "react/shell/routes/needsYouPhrasing.ts",
] as const;

const NOUN = /\bautomations?\b/iu;
/** A string with no whitespace in identifier characters is a key, not copy. */
const IDENTIFIER = /^[a-z0-9_.:/-]*$/u;
/** A dotted name inside a sentence ("automation.json") is a file or key. */
const DOTTED_NAME = /\b[\w-]*automations?[\w-]*(?:\.[\w-]+)+/giu;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(?<lead>^|[^:\\])\/\/.*$/gmu, "$<lead>");
}

const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu;

/** Every piece of text a member could read: string literals, then JSX text. */
function memberTexts(source: string): string[] {
  const code = stripComments(source);
  const texts: string[] = [];
  const remainder = code.replace(LITERAL, (literal) => {
    const body = literal.slice(1, -1);
    // A template's placeholders are code; its static text decides the shape.
    if (!IDENTIFIER.test(body.replace(/\$\{[^}]*\}/gu, ""))) texts.push(body);
    return '""';
  });
  // JSX text runs from a tag's `>` (never an arrow's `=>`) to the next tag or
  // expression, so a sentence followed by `{" "}` is still read.
  for (const match of remainder.matchAll(/(?<!=)>(?<jsx>[^<>{}]+)[<{]/gu)) {
    const text = (match.groups?.jsx ?? "").replace(/\s+/gu, " ").trim();
    if (text.length > 0) texts.push(text);
  }
  return texts;
}

const SOURCES = [
  ...SCREEN_DIRS.flatMap((dir) =>
    readdirSync(path.join(SRC, dir))
      .filter((name) => SCREEN_FILE.test(name) && !NOT_COPY_FILE.test(name))
      .map((name) => path.join(dir, name))
  ),
  ...SHARED_COPY,
].map((file) => [file, readFileSync(path.join(SRC, file), "utf8")] as const);

describe("the desktop's rule screens say rule (R-NY-9)", () => {
  it("has the rule screens to sweep", () => {
    expect(SOURCES.length).toBeGreaterThan(20);
  });

  it("puts no member-copy 'automation' on a rule screen", () => {
    const offenders = SOURCES.flatMap(([file, source]) =>
      memberTexts(source)
        .filter((text) => NOUN.test(text.replace(DOTTED_NAME, "")))
        .map((text) => `${file}: ${text}`)
    );
    expect(offenders).toStrictEqual([]);
  });
});
