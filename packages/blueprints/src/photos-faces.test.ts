// @vitest-environment jsdom
// eslint-disable-next-line typescript-eslint/ban-ts-comment -- issue #711: browser-DOM fixture is intentionally checked by jsdom, while the blueprint TS config excludes DOM globals (see photos-media.test.ts's own note)
// @ts-nocheck
// The lightbox's own face mini-list (apps/photos/faces.ts, issue #711).
//
// Two rules were broken before this suite existed and are pinned here as a
// regression net, not a styling snapshot — see faces.ts's own header for the
// full account:
//
//   1. CONFIDENCE IS NEVER A PERCENTAGE (README.md:285). The unconfirmed row
//      must never contain a `%` character; it reports a match COUNT instead.
//   2. ONE FACE AT A TIME (v4 3967). With N unconfirmed regions on one
//      photograph, the panel renders exactly ONE interactive row (one
//      `<select>`), never N.
//
// `outcomes.ts` is mocked by STRING specifier (matching faces.ts's own
// `./outcomes.ts` import), same reason photos-media.test.ts mocks
// `format.js` that way: the typed `vi.mock(import(...), …)` form would pull
// `apps/` into this package's `src`-rooted TS program (TS6059/TS2307 — see
// that file's comment). `window.centraid` is stubbed directly since faces.ts
// reads it as a global, not an import.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// oxlint-disable-next-line vitest/prefer-import-in-mock -- see header
vi.mock("../apps/photos/outcomes.ts", () => ({
  act: (action: string, input: unknown) => {
    acts.push({ action, input });
    return Promise.resolve({ status: "executed" });
  },
  narrate: () => true,
}));

// A `relativePath` PARAMETER, not an inlined literal — see photos-media.test.ts's
// `importFixture` for why: a literal specifier in a dynamic `import()` is
// something tsc resolves and typechecks at compile time even inside a plain
// value position, which pulls `apps/` into this package's `src`-rooted TS
// program (TS6059, same failure `vi.mock`'s string-specifier form avoids).
const FACES_PATH = "../apps/photos/faces.ts";
const importFaces = (relativePath: string) => import(relativePath);

interface StubRegion {
  region_id: string;
  confirmed?: boolean;
  person_name?: string | null;
  confidence?: number | null;
  party_id?: string | null;
}

let acts: Array<{ action: string; input: unknown }> = [];

function stubCentraid(regions: StubRegion[]): void {
  vi.stubGlobal("window", {
    ...window,
    centraid: {
      read: () =>
        Promise.resolve({
          regions,
          people: [{ party_id: "party-ana", name: "Ana" }],
        }),
    },
  });
}

describe("photos faces mini-list", () => {
  beforeEach(() => {
    vi.resetModules();
    acts = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rule 1: never renders confidence as a percentage", async () => {
    stubCentraid([
      {
        region_id: "r1",
        party_id: "party-ana",
        person_name: "Ana",
        confidence: 0.92, // a similarity score — must never surface as 92%
      },
      // A second proposal for the SAME person, on this photograph, is
      // exactly what the match count counts.
      {
        region_id: "r2",
        party_id: "party-ana",
        person_name: "Ana",
        confidence: 0.5,
      },
    ]);
    const { renderFaces } = (await importFaces(FACES_PATH)) as FacesModule;
    const host = document.createElement("div");
    const note = document.createElement("p");
    await renderFaces(host, "asset-1", note);
    expect(host.textContent).not.toMatch(/%/u);
    expect(host.textContent).toMatch(/1 matching face/u);
  });

  it("rule 2: shows exactly one unconfirmed proposal at a time", async () => {
    stubCentraid([
      { region_id: "r1", party_id: null, person_name: null },
      { region_id: "r2", party_id: null, person_name: null },
      { region_id: "r3", party_id: null, person_name: null },
    ]);
    const { renderFaces } = (await importFaces(FACES_PATH)) as FacesModule;
    const host = document.createElement("div");
    const note = document.createElement("p");
    await renderFaces(host, "asset-1", note);
    expect(host.querySelectorAll("select")).toHaveLength(1);
    expect(host.textContent).toMatch(/2 more faces to review/u);
  });

  it("Skip moves to the next face without writing anything", async () => {
    stubCentraid([
      { region_id: "r1", party_id: null, person_name: null },
      { region_id: "r2", party_id: null, person_name: null },
    ]);
    const { renderFaces } = (await importFaces(FACES_PATH)) as FacesModule;
    const host = document.createElement("div");
    const note = document.createElement("p");
    await renderFaces(host, "asset-1", note);
    const skipBtn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Skip"
    );
    skipBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(acts).toHaveLength(0);
    expect(host.dataset.faceIndex).toBe("1");
  });
});
