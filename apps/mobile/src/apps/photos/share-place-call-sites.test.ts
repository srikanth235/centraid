import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MOBILE_PHOTOS = import.meta.dirname;
const BLUEPRINT_PHOTOS = path.resolve(
  import.meta.dirname,
  "../../../../../packages/blueprints/apps/photos"
);

const LADDER = "place-phrase.ts";

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

function cite(file: string): string {
  return path.relative(
    path.resolve(import.meta.dirname, "../../../../.."),
    file
  );
}

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
    expect(viewer).toMatch(/onSendCopy:\s*\(\)\s*=>\s*setShareOpen\(true\)/u);
    expect(viewer).toMatch(
      /onChoose=\{\(precision\) =>\s*void sendCopy\(current, precision, sharePlace\)/u
    );
    expect(sheet).toMatch(/selectedId=\{SHARE_PLACE_DEFAULT\}/u);
  });
});
