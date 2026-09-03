// @vitest-environment jsdom
// oxlint-disable-next-line typescript-eslint/ban-ts-comment -- issue #711: browser-DOM fixture is intentionally checked by jsdom, while the blueprint TS config excludes DOM globals (see photos-media.test.ts's own note)
// @ts-nocheck
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
      "face review proposes them one at a time"
    );
  });

  it("gets the grammar right for exactly one unmatched face", async () => {
    const { container } = await mount({ people: [], unmatchedCount: 1 });
    expect(container.textContent).toContain("1 face is not matched to anyone");
  });

  it("omits the number rather than claiming a zero before the count is known", async () => {
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
    const { container } = await mount({
      people: [],
      proposals: [proposal()],
      unmatchedCount: 1,
    });
    expect(container.textContent).not.toContain("Not yet named");
  });
});
