// R-A-14 (#1015). Presence IS the mode: `bandStateFor` reads a room's
// `selection` prop as "this screen is choosing", so a screen that is not
// choosing passes NO selection. Four Photos screens passed their selection
// bar unconditionally — an object at rest — and so sat permanently in the
// mode: the header swapped for the instruction, the band was dimmed and
// non-interactive, and the foot row stood there before a single photograph
// had been picked. `PhotosHome` was always right (`selecting ? {…} :
// undefined`); these four now match it.
//
// The proof is read off the source rather than off four renders, because the
// bug is a MISSING GUARD at the call site: a render can only show that the
// guarded screen behaves, while the guard's absence is what regresses.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { bandStateFor } from "../../kit/rooms/room-contracts";

const CALLERS = [
  "AlbumDetail.tsx",
  "DuplicateReview.tsx",
  "DuplicatesShelf.tsx",
  "PhotoStateView.tsx",
];

const read = (file: string): string =>
  readFileSync(path.join(__dirname, file), "utf8");

describe("a Photos screen only enters the mode once something is chosen", () => {
  it.each(CALLERS)("%s gates its selection bar on a live count", (file) => {
    const source = read(file);
    expect(source).toContain(
      "selection={selection.size > 0 ? selectionBar : undefined}"
    );
    expect(source).not.toContain("selection={selectionBar}");
  });

  // Why the guard has to be at the call site: the room cannot tell an empty
  // selection from a resting one, and by contract it must not try — Docs'
  // drive is choosing at zero as much as at three.
  it("reads a passed selection as the mode, empty or not", () => {
    expect(bandStateFor(undefined)).toStrictEqual({
      dimmed: false,
      interactive: true,
    });
    expect(
      bandStateFor({ actions: [], count: 0, onCancel: (): void => undefined })
    ).toStrictEqual({ dimmed: true, interactive: false });
  });
});
