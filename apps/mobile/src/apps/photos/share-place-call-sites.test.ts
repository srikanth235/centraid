// THE INVARIANT, HELD OVER THE CALL SITES (#816).
//
// "Shared and exported contexts never carry relative-to-Home phrasing" is not
// a property of `placePhrase` — that function will happily print "3.5 km NE of
// Home" for anyone who forgets to say `context: "shared"`, and the default is
// `"private"`. It is a property of every place in the product that phrases a
// location, which is why this file reads the sources rather than calling the
// function.
//
// TWO RULES, both total over the Photos sources on both surfaces, and neither
// of them an allowlist that can be widened quietly:
//
//   1. EVERY `placePhrase` call names its context. Not "the share path names
//      it" — every call, including the private ones, because the failure this
//      wave is about is somebody adding a call and not thinking about who
//      reads it. A caller who omits the argument gets the private ladder by
//      default and no warning; a caller who omits it here gets a red test that
//      names the file and line.
//   2. EXACTLY ONE Photos module may hand bytes to the operating system's
//      share sheet, and it is the one that asks the member first and strips
//      the file after (`photo-share.ts`). The set is asserted as data, so a
//      second share path anywhere under Photos fails this test on the commit
//      that adds it rather than in a privacy report months later.
//
// Reading source text is the same instrument `viewer-read-only-reason.test.ts`
// uses for the same reason: there is no way to render every surface of two
// clients in a unit test, and the claim is about what the code says, not about
// what one render happened to do.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MOBILE_PHOTOS = import.meta.dirname;
const BLUEPRINT_PHOTOS = path.resolve(
  import.meta.dirname,
  "../../../../../packages/blueprints/apps/photos"
);

/** The phrase ladder itself: it DEFINES the call, so it cannot make one. */
const LADDER = "place-phrase.ts";

/** Every non-test source under a Photos tree, deepest first, repo-relative. */
function sources(root: string, acc: string[] = []): string[] {
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, item.name);
    if (item.isDirectory()) sources(full, acc);
    else if (
      /\.tsx?$/u.test(item.name) &&
      !/\.test\.tsx?$/u.test(item.name) &&
      item.name !== LADDER
    ) {
      acc.push(full);
    }
  }
  return acc;
}

const FILES = [...sources(MOBILE_PHOTOS), ...sources(BLUEPRINT_PHOTOS)];

/** A path as a reader would cite it, from the repository root. */
function cite(file: string): string {
  return path.relative(
    path.resolve(import.meta.dirname, "../../../../.."),
    file
  );
}

/** The text between the parentheses of the call starting at `open`. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const character = source[i];
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open);
}

/** Every `placePhrase(...)` call in `source`, as the text it was passed. */
function placePhraseCalls(source: string): string[] {
  const calls: string[] = [];
  const finder = /(?<![\w.])placePhrase\s*\(/gu;
  let found = finder.exec(source);
  while (found !== null) {
    calls.push(callArguments(source, found.index + found[0].length - 1));
    found = finder.exec(source);
  }
  return calls;
}

/** The OS and browser doors a photograph can leave through. */
const EGRESS =
  /(?<![\w.])Share\.share\s*\(|(?<![\w.])Sharing\.shareAsync\s*\(|navigator\.share\s*\(/u;

describe("every phrase knows who is going to read it", () => {
  it("finds calls to phrase in the first place — the scan is not vacuous", () => {
    const calling = FILES.filter(
      (file) => placePhraseCalls(fs.readFileSync(file, "utf8")).length > 0
    ).map(cite);
    expect(calling.length).toBeGreaterThan(0);
  });

  it("names its context at every call site, on both surfaces", () => {
    const unnamed = FILES.flatMap((file) =>
      placePhraseCalls(fs.readFileSync(file, "utf8"))
        .filter((argument) => !/\bcontext:/u.test(argument))
        .map(() => cite(file))
    );
    // A caller with no `context:` silently gets the member's own screen —
    // which is the right answer on a screen and the wrong one in an export.
    expect(unnamed).toStrictEqual([]);
  });

  it("phrases a share through the one module that hard-wires the shared context", () => {
    const sharePlace = fs.readFileSync(
      path.join(BLUEPRINT_PHOTOS, "share-place.ts"),
      "utf8"
    );
    expect(placePhraseCalls(sharePlace)).toStrictEqual([
      '{ ...input, context: "shared" }',
    ]);
  });
});

describe("one door out of Photos", () => {
  it("is `photo-share.ts`, and nothing else asks the OS to send a photograph", () => {
    const doors = FILES.filter((file) =>
      EGRESS.test(fs.readFileSync(file, "utf8"))
    ).map((file) => path.basename(file));
    expect(doors).toStrictEqual(["photo-share.ts"]);
  });

  it("is reached from the viewer only after the member has chosen a precision", () => {
    const viewer = fs.readFileSync(
      path.join(MOBILE_PHOTOS, "PhotoLightbox.tsx"),
      "utf8"
    );
    const sheet = fs.readFileSync(
      path.join(MOBILE_PHOTOS, "PhotoShareChoice.tsx"),
      "utf8"
    );
    // The menu row opens the sheet; the choice made in the sheet is what
    // calls the share. Neither half is optional — a row wired straight to
    // `sendCopy` would send at whatever precision the code happened to pass —
    // and the sheet opens on the rung that discloses nothing.
    expect(viewer).toMatch(/onSendCopy:\s*\(\)\s*=>\s*setShareOpen\(true\)/u);
    expect(viewer).toMatch(
      /onChoose=\{\(precision\) =>\s*void sendCopy\(current, precision, sharePlace\)/u
    );
    expect(sheet).toMatch(/selectedId=\{SHARE_PLACE_DEFAULT\}/u);
  });
});
