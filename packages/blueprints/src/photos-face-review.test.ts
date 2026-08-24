// @vitest-environment jsdom
// oxlint-disable-next-line typescript-eslint/ban-ts-comment -- issue #711: browser-DOM fixture is intentionally checked by jsdom, while the blueprint TS config excludes DOM globals (see photos-media.test.ts's own note)
// @ts-nocheck
// The Face review surface (apps/photos/components/FaceReview.tsx, issue
// #711, v4 handoff 4305-4318). Same regression net as photos-faces.test.ts,
// for the full vault-wide surface rather than the lightbox's mini-list:
//
//   1. CONFIDENCE IS NEVER A PERCENTAGE (README.md:285) — nothing rendered
//      here may contain a `%` character.
//   2. ONE FACE AT A TIME (v4 3967) — exactly one panel (`Is this someone
//      you know?`) is on screen at once, never a list.
//   3. AN UNMATCHED FACE HAS A FORWARD ACTION — the mobile bug this surface
//      must not repeat (see PR review notes on FaceReview.tsx's old
//      `partyId ? <Confirm/> : null`): a proposal with no proposed person
//      still offers Not this person / Someone else / Unknown person / Skip.
//   4. THE QUEUE CAN BE FINISHED (#712) — "Keep unnamed" writes a real
//      `dismiss` answer instead of setting an apologetic note, Skip is the
//      only control that still writes nothing, and an empty queue reaches
//      "No faces need review right now." rather than cycling the ones the
//      member kept skipping.
//
// `outcomes.ts` mocked by string specifier — see photos-faces.test.ts's own
// note on why (TS6059/TS2307 if imported typed).
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// oxlint-disable-next-line vitest/prefer-import-in-mock -- see header
vi.mock("../apps/photos/outcomes.ts", () => ({
  act: (action: string, input: unknown) => {
    acts.push({ action, input });
    return Promise.resolve({ status: "executed" });
  },
  narrate: () => true,
}));

let acts: Array<{ action: string; input: unknown }> = [];

const QUEUE = [
  {
    region_id: "r1",
    bbox: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 },
    party_id: "party-ana",
    person_name: "Ana",
    matchCount: 8,
    firstSeenAt: "2026-06-12T00:00:00.000Z",
    asset: {
      asset_id: "a1",
      content_uri: null,
      thumb_uri: null,
      width: 1000,
      height: 1000,
    },
  },
  // No proposed person at all — the primary "no forward action" bug case.
  {
    region_id: "r2",
    bbox: null,
    party_id: null,
    person_name: null,
    matchCount: 0,
    firstSeenAt: null,
    asset: null,
  },
];

function stubCentraid(queue: typeof QUEUE): void {
  vi.stubGlobal("window", {
    ...window,
    centraid: {
      read: () =>
        Promise.resolve({
          queue,
          unmatchedTotal: queue.length,
          confirmedTotal: 12,
          people: [{ party_id: "party-ana", name: "Ana" }],
        }),
    },
  });
}

// A `relativePath` PARAMETER, not an inlined literal — see photos-faces.test.ts's
// own note (mirroring photos-media.test.ts's `importFixture`): tsc resolves
// and typechecks a literal specifier in a dynamic `import()` even inside a
// plain value position, which pulls `apps/` into this package's
// `src`-rooted TS program (TS6059).
const FACE_REVIEW_PATH = "../apps/photos/components/FaceReview.tsx";
const importFaceReview = (relativePath: string) => import(relativePath);

async function mount(queue: typeof QUEUE): Promise<{
  container: HTMLDivElement;
  root: Root;
}> {
  stubCentraid(queue);
  const { FaceReview } = await importFaceReview(FACE_REVIEW_PATH);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(FaceReview, {}));
    // Flush the two chained promises `load()` awaits (read + state updates).
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

describe("Face review surface", () => {
  beforeEach(() => {
    vi.resetModules();
    acts = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("rule 1: confidence never renders as a percentage", async () => {
    const { container } = await mount(QUEUE);
    expect(container.textContent).not.toMatch(/%/u);
    expect(container.textContent).toMatch(/8 matching faces/u);
  });

  it("rule 2: exactly one proposal panel is on screen at a time", async () => {
    const { container } = await mount(QUEUE);
    expect(
      container.querySelectorAll('[aria-label="Is this someone you know?"]')
    ).toHaveLength(1);
    expect(container.textContent).toMatch(/Proposed: Ana/u);
    expect(container.textContent).not.toMatch(/No proposed match/u);
  });

  it("an unmatched face (no proposed person) still has a forward action", async () => {
    // The SECOND queue entry has no party_id — mount with it alone so it is
    // the one and only proposal shown.
    const { container } = await mount([QUEUE[1]]);
    expect(container.textContent).toMatch(/No proposed match/u);
    // No "Confirm as X" (there is no name to confirm), but every escape
    // route is still present and clickable.
    expect(container.textContent).not.toMatch(/Confirm as/u);
    const buttons = [...container.querySelectorAll("button")].map(
      (b) => b.textContent
    );
    expect(buttons).toContain("Not this person");
    expect(buttons).toContain("Skip");
    expect(buttons).toContain("Name →");
    expect(buttons).toContain("Keep unnamed");
  });

  it("Keep unnamed fires a real dismiss answer (issue #712)", async () => {
    const { container } = await mount(QUEUE);
    const keep = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Keep unnamed"
    );
    await act(async () => {
      keep!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    // ONE action, carrying the answer as its discriminant — not a second
    // endpoint, and not a note set in place of writing.
    expect(acts).toStrictEqual([
      { action: "answer-face", input: { region_id: "r1", answer: "dismiss" } },
    ]);
    expect(container.textContent).not.toMatch(/isn't wired up yet/u);
  });

  it("confirm and reject ride the same one verb", async () => {
    const { container } = await mount(QUEUE);
    const reject = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Not this person"
    );
    await act(async () => {
      reject!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(acts).toStrictEqual([
      { action: "answer-face", input: { region_id: "r1", answer: "reject" } },
    ]);
  });

  it("a fully answered library reaches the zero-remaining state", async () => {
    // Nothing left to review is a state this surface must be able to REACH —
    // before #712 a skipped stranger had no answer that removed it, so
    // the queue was only ever empty on a vault that had never proposed a face.
    const { container } = await mount([]);
    expect(container.textContent).toMatch(/No faces need review right now\./u);
    expect(container.textContent).toMatch(/0 to go/u);
  });

  it("Skip never fires a write", async () => {
    const { container } = await mount(QUEUE);
    const skip = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Skip"
    );
    await act(async () => {
      skip!.click();
    });
    expect(acts).toHaveLength(0);
    // Cycled to the second (unmatched) proposal.
    expect(container.textContent).toMatch(/No proposed match/u);
  });
});
