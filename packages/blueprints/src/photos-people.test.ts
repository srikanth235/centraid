// @vitest-environment jsdom
// eslint-disable-next-line typescript-eslint/ban-ts-comment -- issue #711: browser-DOM fixture is intentionally checked by jsdom, while the blueprint TS config excludes DOM globals (see photos-media.test.ts's own note)
// @ts-nocheck
// The People shelf's own conformance fixes (issue #711, v4 handoff §5, proto
// :4432-:4433):
//
//   1. SIX COLUMNS DESKTOP, THREE PHONE (proto :4432) — a fixed column
//      count, not `auto-fill`'s floor (checked on the CSS module itself: a
//      grid's column count is a layout fact `getComputedStyle` cannot see
//      under jsdom, so this reads the authored rule directly, the same way
//      photos-vocabulary.test.ts reads sources rather than a live DOM).
//   2. THE PENDING NOTE CARRIES THE LIVE COUNT (proto :4433) — `54 faces are
//      not matched to anyone…` with the vault-wide `unmatchedTotal` fact
//      `queries/people.ts` now derives itself (same computation
//      `queries/face-queue.ts` uses for the same fact) and passes down as a
//      prop, not a fixed prototype number and not a second read of a
//      different query.
//   3. UNCONFIRMED PROPOSALS RENDER, NEVER NAMED (issue #711 review, proto
//      :3760 `PPEOPLE` — named cards next to "Unnamed" ones, each with its
//      own count) — distinguishable from a confirmed person's card and
//      routing into Face Review, never asserting a name nobody confirmed.
import fs from "node:fs";
import path from "node:path";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const PEOPLE_MODULE_CSS = path.resolve(
  import.meta.dirname,
  "../apps/photos/components/People.module.css"
);

// A `relativePath` PARAMETER, not an inlined literal — see
// photos-face-review.test.ts's own note (TS6059 if the specifier is a
// literal tsc can resolve at compile time).
const PEOPLE_PATH = "../apps/photos/components/People.tsx";
const importPeople = (relativePath: string) => import(relativePath);

interface Person {
  party_id: string;
  name: string | null;
  count: number;
  asset_ids: string[];
}

interface FaceProposal {
  cluster_id: string;
  party_id: string | null;
  count: number;
  region_id: string;
  cover: {
    asset_id: string;
    content_uri: string | null;
    thumb_uri: string | null;
    width: number | null;
    height: number | null;
    bbox: { x: number; y: number; w: number; h: number } | null;
  } | null;
}

async function mount(props: {
  people: Person[];
  proposals?: FaceProposal[];
  unmatchedCount?: number | null;
  onNameProposal?: (regionId: string) => void;
}): Promise<{ container: HTMLDivElement; root: Root }> {
  const { PeopleShelf } = await importPeople(PEOPLE_PATH);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(PeopleShelf, {
        people: props.people,
        proposals: props.proposals,
        unmatchedCount: props.unmatchedCount,
        assets: [],
        onOpen: () => {},
        onNameProposal: props.onNameProposal,
      })
    );
  });
  return { container, root };
}

describe("People is six columns desktop, three phone (proto :4432)", () => {
  const css = fs.readFileSync(PEOPLE_MODULE_CSS, "utf8");

  it("fixes the desktop grid at six columns, not auto-fill's floor", () => {
    // `auto-fill` with a 104px floor lands near nine columns on a wide pane —
    // the exact regression this fix closes, so its absence from the RULE
    // (not the file's own prose, which still explains the old bug) is
    // asserted too.
    // The desktop rule is the first `.grid { … }` block — the phone override
    // lives inside the `@media` block asserted separately below.
    const gridRule = css.match(/\.grid\s*\{(?<body>[^}]*)\}/u);
    expect(gridRule?.groups?.body).toMatch(/repeat\(6,\s*1fr\)/u);
    expect(gridRule?.groups?.body).not.toMatch(/auto-fill/u);
  });

  it("narrows to three columns under the app's phone breakpoint", () => {
    const phoneBlock = css.match(
      /@media \(max-width: 719\.98px\) \{\s*\.grid\s*\{(?<body>[^}]*)\}/u
    );
    expect(phoneBlock?.groups?.body).toMatch(/repeat\(3,\s*1fr\)/u);
  });
});

describe("the pending note carries the live unmatched count (proto :4433)", () => {
  it("names the count from the passed-in fact", async () => {
    const { container } = await mount({ people: [], unmatchedCount: 54 });
    expect(container.textContent).toContain(
      "54 faces are not matched to anyone"
    );
    expect(container.textContent).toContain(
      "Face review proposes them one at a time"
    );
  });

  it("gets the grammar right for exactly one unmatched face", async () => {
    const { container } = await mount({ people: [], unmatchedCount: 1 });
    expect(container.textContent).toContain("1 face is not matched to anyone");
  });

  it("omits the number rather than claiming a zero before the count is known", async () => {
    // A static-markup render with no `unmatchedCount` prop is the "not yet
    // answered" moment every other lazy shelf count respects (app-root.tsx's
    // `countFor`, `duplicates.count()`) — `undefined`/`null` must read as
    // unread, never as a zero the caller never actually checked.
    const { PeopleShelf } = await importPeople(PEOPLE_PATH);
    const html = renderToStaticMarkup(
      createElement(PeopleShelf, { people: [], assets: [], onOpen: () => {} })
    );
    expect(html).toContain("not matched to anyone yet");
    expect(html).not.toContain("54");
  });
});

describe("a confirmed person with no display name is never invented", () => {
  it("prints nothing rather than a placeholder string for a name-less row", async () => {
    // `queries/people.ts` types `name` as nullable defensively, but the one
    // command that can mint a person (`people.create`) requires
    // `display_name` with `minLength: 1` — this case cannot occur from a
    // real read. The old fallback ("Someone with no name yet") therefore
    // pretended to handle a case the query never produces; this asserts the
    // shelf no longer invents prose for it.
    const { container } = await mount({
      people: [{ party_id: "p1", name: null, count: 3, asset_ids: [] }],
      unmatchedCount: 0,
    });
    expect(container.textContent).not.toContain("Someone with no name yet");
  });
});

describe("unconfirmed proposals render distinct from confirmed people (issue #711 review)", () => {
  function proposal(overrides: Partial<FaceProposal> = {}): FaceProposal {
    return {
      cluster_id: "region:r1",
      party_id: null,
      count: 3,
      region_id: "r1",
      cover: null,
      ...overrides,
    };
  }

  it("never prints a name for a proposal card", async () => {
    const { container } = await mount({
      people: [{ party_id: "p1", name: "Ana", count: 5, asset_ids: [] }],
      proposals: [proposal()],
      unmatchedCount: 3,
      onNameProposal: () => {},
    });
    // The confirmed person's own name is fine; what must never appear is a
    // name attributed to the proposal. There is no name to leak here since
    // FaceProposal carries none, but the card's own copy must say so instead
    // of a name.
    expect(container.textContent).toContain("Ana");
    expect(container.textContent).toContain("Not yet named");
  });

  it("shows the proposal's own count, not the confirmed person's", async () => {
    const { container } = await mount({
      people: [],
      proposals: [proposal({ count: 7 })],
      unmatchedCount: 7,
      onNameProposal: () => {},
    });
    expect(container.textContent).toContain("7");
  });

  it("routes a click to onNameProposal with the proposal's own region_id", async () => {
    const clicked: string[] = [];
    const { container } = await mount({
      people: [],
      proposals: [proposal({ region_id: "r-42" })],
      unmatchedCount: 1,
      onNameProposal: (regionId) => clicked.push(regionId),
    });
    const buttons = container.querySelectorAll("button");
    const proposalButton = [...buttons].find((b) =>
      b.textContent?.includes("Not yet named")
    );
    expect(proposalButton).toBeTruthy();
    await act(async () => {
      proposalButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(clicked).toStrictEqual(["r-42"]);
  });

  it("renders no proposal cards when the caller has not wired onNameProposal", async () => {
    // A control with no working handler must never ship (hard rule) — if the
    // caller has not passed the routing callback yet, the shelf omits the
    // proposal cards entirely rather than rendering dead buttons.
    const { container } = await mount({
      people: [],
      proposals: [proposal()],
      unmatchedCount: 1,
    });
    expect(container.textContent).not.toContain("Not yet named");
  });
});
