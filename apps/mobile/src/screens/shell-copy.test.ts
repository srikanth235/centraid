// THE SHELL'S COPY AND A11Y SWEEP (#1015, Wave 3 — S11, S14, a11y).
//
// Three claims no mounted test makes cheaply over thirty screens:
//
//  1. SENTENCE CASE, over the tables here AND over the option arrays that
//     still live in `.tsx` (D2, superseding #712).
//  2. ONE NOUN PER DESTINATION — `short` may only drop words from `name`, so
//     the band cannot paint one noun while VoiceOver speaks another. That was
//     shell/findings 6: the Alerts place wore four names at once.
//  3. NO EXCEPTION REACHES MEMBER COPY — S14. `error.message`, `String(err)`
//     and `err.toString()` may be captured for a log; none of them may flow
//     into a status note or a room's error detail.
//
// It reads `scripts/lint-mobile-rooms.mjs`'s own rules rather than a second
// copy of them, for the same reason `shell-rooms.test.ts` does.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { APPROVALS_DENY_SUB } from "@centraid/client/approvals-copy";
import { AUTOMATIONS_EMPTY_BODY } from "@centraid/client/automations-copy";
import { INSIGHTS_EMPTY_BODY } from "@centraid/client/insights-copy";

import { isTitleCase, walk } from "../../../../scripts/lint-mobile-rooms.mjs";
import { PLACES } from "./home/places";
import {
  DESKTOP_LINK_STATUS,
  SHELL_ERROR,
  SHELL_TITLES,
  desktopLinkStatus,
} from "./shell-copy";

const REPO = path.resolve(import.meta.dirname, "../../../..");

/** The shared sentences both seats read — swept with the shell's own. */
const SHARED_COPY = [
  "packages/client/src/automations-copy.ts",
  "packages/client/src/approvals-copy.ts",
  "packages/client/src/insights-copy.ts",
  "packages/client/src/react/shell/launcherModel.ts",
  "packages/client/src/react/shell/opsBar.ts",
];

const SHELL = [
  "apps/mobile/src/screens/",
  "apps/mobile/src/apps/assistant/",
  "apps/mobile/src/apps/automations/",
  "apps/mobile/src/apps/insights/",
];

const shellSources = SHELL.flatMap((tree) => walk(path.join(REPO, tree)))
  .map((file) => path.relative(REPO, file))
  .filter((file) => /\.tsx?$/u.test(file) && !file.includes(".test."));

const read = (file: string): string =>
  readFileSync(path.join(REPO, file), "utf8");

/** Every string in one of this lane's copy tables. */
const TABLE_COPY: readonly string[] = [
  ...Object.values(DESKTOP_LINK_STATUS),
  ...Object.values(SHELL_ERROR),
  ...Object.values(SHELL_TITLES),
  ...PLACES.flatMap((p) => [p.name, p.short, p.what]),
];

describe("the shell's copy", () => {
  it("writes every table label in sentence case", () => {
    expect(TABLE_COPY.filter((label) => isTitleCase(label))).toStrictEqual([]);
  });

  it("keeps the tunnel's port and its exception out of the member's words", () => {
    // shell/findings 13: the row read "Connected (port 8787)", and a failure
    // read "Error: <the module's own sentence>".
    expect(desktopLinkStatus({ state: "running", port: 8787 })).toBe(
      "Connected"
    );
    expect(
      desktopLinkStatus({ state: "error", error: "EADDRINUSE" })
    ).not.toContain("EADDRINUSE");
    expect(desktopLinkStatus(undefined)).toBe("Checking…");
  });

  it("gives every destination one noun, dropping words but never swapping them", () => {
    const swapped = PLACES.filter((place) => {
      if (place.short === place.name) return false;
      const words = new Set(place.name.toLowerCase().split(/\s+/u));
      return !place.short
        .toLowerCase()
        .split(/\s+/u)
        .every((word) => words.has(word));
    }).map((place) => place.id);
    // No exception, since R-SH-8: the one place that painted a second noun
    // ("Automations" in the header, "Rules" on the band) is named "Rules" in
    // both. A `short` may only drop words from `name` — never swap one in.
    expect(swapped).toStrictEqual([]);
  });

  it("says rule, never automation, in any sentence a member reads", () => {
    // R-SH-11: a place named Rules whose rows are "automations" is exactly the
    // divergence this umbrella exists to end. `automations` survives as a WIRE
    // flag, a route key, a deep-link path, a module name and a file name — none
    // of which a member reads — so the sweep looks only at sentences (a literal
    // with a space in it), with comments stripped.
    const offenders: string[] = [];
    for (const file of [...shellSources, ...SHARED_COPY]) {
      const source = read(file)
        .replaceAll(/\/\*[\s\S]*?\*\//gu, " ")
        .replaceAll(/(?<before>^|[^:])\/\/[^\n]*/gu, "$<before>");
      for (const match of source.matchAll(
        /["'`](?<text>[^"'`\n]*[ \t][^"'`\n]*)["'`]/gu
      )) {
        const text = match.groups?.text ?? "";
        if (/\bautomations?\b/iu.test(text)) offenders.push(`${file}: ${text}`);
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it("keeps the noun out of the shared copy both seats read", () => {
    // The shell's own tables are swept above; these are the sentences
    // `packages/client` hands BOTH seats, where a second noun would reappear
    // on desktop only.
    // The launcher's and ops bar's labels are swept as SOURCE above; these
    // three are read as VALUES, so a re-export cannot hide a rename.
    const shared = [
      AUTOMATIONS_EMPTY_BODY,
      APPROVALS_DENY_SUB,
      INSIGHTS_EMPTY_BODY,
    ];
    expect(shared.filter((t) => /\bautomations?\b/iu.test(t))).toStrictEqual(
      []
    );
  });

  it("ends no error noun with a full stop, and gives each one a subject", () => {
    for (const sentence of Object.values(SHELL_ERROR)) {
      expect(sentence.endsWith(".")).toBe(false);
      expect(sentence.split(/\s+/u).length).toBeGreaterThan(2);
    }
  });

  it("leaves no Title Case option label in a shell .tsx", () => {
    // A destination's own name is a proper noun — "Open Settings" is sentence
    // case, and the lint's word-shape heuristic cannot know that. The set is
    // the tables above, so a label can only borrow a name the product HAS.
    const properNouns = new Set([
      ...PLACES.map((place) => place.name),
      ...Object.values(SHELL_TITLES),
    ]);
    const sentenceCase = (label: string): boolean =>
      !isTitleCase(
        label
          .split(/\s+/u)
          .filter((word) => !properNouns.has(word))
          .join(" ")
      );
    const offenders: string[] = [];
    for (const file of shellSources.filter((f) => f.endsWith(".tsx")))
      for (const match of read(file).matchAll(
        /\blabel:\s*["'](?<label>[^"'\n]{3,60})["']/gu
      )) {
        const label = match.groups?.label ?? "";
        if (!sentenceCase(label)) offenders.push(`${file}: ${label}`);
      }
    expect(offenders).toStrictEqual([]);
  });
});

describe("the shell's errors (S14)", () => {
  // A capture is fine; a render is not. These are the sinks that reach a
  // member: the one status channel, and a room's error detail.
  const SINKS =
    /(?:postStatus|showUndoStatus)\s*\(|(?:detail|message|reason|secondary):/u;
  const RAW =
    /\b(?:error|err|e)\.message\b|String\((?:error|err|e)\)|\.toString\(\)/u;

  it("never renders an exception into the one status channel", () => {
    const offenders: string[] = [];
    for (const file of shellSources)
      for (const line of read(file).split("\n"))
        if (SINKS.test(line) && RAW.test(line))
          offenders.push(`${file}: ${line.trim()}`);
    expect(offenders).toStrictEqual([]);
  });
});

describe("the shell's a11y", () => {
  it("labels no container that already carries its own visible text", () => {
    // A label on a container makes VoiceOver read the label INSTEAD of the
    // rows inside it, so a labelled panel silences everything it holds.
    const offenders: string[] = [];
    for (const file of shellSources.filter((f) => f.endsWith(".tsx"))) {
      const source = read(file);
      for (const match of source.matchAll(
        /<(?<tag>ScrollView|FlatList|SectionList)\b[^>]*accessibilityLabel=/gu
      ))
        offenders.push(`${file}: <${match.groups?.tag ?? "?"}>`);
    }
    expect(offenders).toStrictEqual([]);
  });

  it("gives every pressable a role", () => {
    const offenders: string[] = [];
    for (const file of shellSources.filter((f) => f.endsWith(".tsx"))) {
      const source = read(file);
      for (const match of source.matchAll(/<Pressable\b(?<attrs>[^>]*)>/gu)) {
        const attrs = match.groups?.attrs ?? "";
        if (!/accessibilityRole=/u.test(attrs) && /onPress/u.test(attrs))
          offenders.push(`${file}: <Pressable> without a role`);
      }
    }
    expect(offenders).toStrictEqual([]);
  });
});
