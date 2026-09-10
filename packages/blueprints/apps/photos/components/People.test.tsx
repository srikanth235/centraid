// @vitest-environment jsdom
// THE PEOPLE SHELF'S EMPTY STATE (#712, ruled 2026-09-09): while the roster
// is empty, `emptyState` replaces the grid/note; app-root.tsx decides WHEN.
// Signage, not a consent moment. Pure-view test via renderToStaticMarkup.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "..", rel)).href;

interface Person {
  party_id: string;
  name: string | null;
  count: number;
  asset_ids: string[];
  confirmed_by?: Array<{ party_id: string; name: string | null }>;
}
interface AnswerAvailability {
  available: boolean;
  reason?: string;
}
interface PeopleEmptyStateProps {
  count: number;
  statusLine: string;
  line: string;
  action: string;
  prioritize: AnswerAvailability;
  busy: boolean;
  prioritized: boolean;
  onPrioritize: () => void;
}
interface PeopleShelfProps {
  people: readonly Person[];
  proposals?: readonly unknown[];
  unmatchedCount?: number | null;
  assets: readonly unknown[];
  onOpen: (partyId: string) => void;
  onReview?: () => void;
  onNameProposal?: (regionId: string) => void;
  emptyState?: PeopleEmptyStateProps;
}

const { PeopleShelf } = (await import(app("components/People.tsx"))) as {
  PeopleShelf: ComponentType<PeopleShelfProps>;
};
const { ENRICHMENT_STATUS_LINE, PEOPLE_EMPTY_LINE, PRIORITISE_ACTION } =
  (await import(app("enrichment-consent.ts"))) as {
    ENRICHMENT_STATUS_LINE: string;
    PEOPLE_EMPTY_LINE: string;
    PRIORITISE_ACTION: string;
  };

const BASE_PROPS: PeopleShelfProps = {
  people: [],
  proposals: [],
  unmatchedCount: 0,
  assets: [],
  onOpen: () => undefined,
};

function markup(props: Partial<PeopleShelfProps> = {}): string {
  return renderToStaticMarkup(
    createElement(PeopleShelf, { ...BASE_PROPS, ...props })
  );
}

const EMPTY_PROPS: PeopleEmptyStateProps = {
  count: 6214,
  statusLine: ENRICHMENT_STATUS_LINE,
  line: PEOPLE_EMPTY_LINE,
  action: PRIORITISE_ACTION,
  prioritize: { available: true },
  busy: false,
  prioritized: false,
  onPrioritize: () => undefined,
};

describe("the People shelf's empty state", () => {
  it("replaces the grid/note, and names the recipe and its switch", () => {
    const html = markup({ emptyState: EMPTY_PROPS });
    expect(html).toContain(ENRICHMENT_STATUS_LINE);
    expect(html).toContain(PEOPLE_EMPTY_LINE);
    expect(html).toContain("Faces recipe");
    expect(html).toContain("Automations → Recognition");
    // Not the plain pending-note copy — this IS the whole empty state.
    expect(html).not.toContain("not matched to anyone");
  });

  it("never asks for consent: no panel, no facts table, no decline", () => {
    // A surface offering to "run" or "decline" faces claims a power this
    // shelf does not have.
    const html = markup({ emptyState: EMPTY_PROPS });
    expect(html).not.toContain("Run face detection");
    expect(html).not.toContain("Not now");
    expect(html).not.toContain("what leaves the device");
    expect(html).not.toContain("asked once");
  });

  it("offers the priority action as a plain, enabled control", () => {
    const html = markup({ emptyState: EMPTY_PROPS });
    expect(html).toMatch(
      /class="kit-btn secondary"[^]*?Prioritize faces<\/button>/u
    );
    expect(html).not.toContain('disabled=""');
  });

  it("states WHY the action is inert, beside it, and disables it", () => {
    const html = markup({
      emptyState: {
        ...EMPTY_PROPS,
        prioritize: { available: false, reason: "Not available: because." },
      },
    });
    expect(html).toContain("Not available: because.");
    expect(html).toMatch(/disabled=""[^]*?Prioritize faces/u);
  });

  it("renders the ordinary grid/note when `emptyState` is absent, unchanged", () => {
    const html = markup({ unmatchedCount: 3 });
    expect(html).toContain(
      "3 faces are not matched to anyone — face review proposes them one at a time."
    );
    expect(html).not.toContain(PRIORITISE_ACTION);
  });

  it("prefers the empty state even if a roster were passed with it", () => {
    // The component never shows grid AND empty state; withholding
    // `emptyState` is the CALLER's job.
    const html = markup({
      people: [{ party_id: "p1", name: "Ana", count: 2, asset_ids: [] }],
      emptyState: EMPTY_PROPS,
    });
    expect(html).toContain(PRIORITISE_ACTION);
    expect(html).not.toContain("Ana");
  });
});

// A FACE GROUP MAY SPAN TWO PEOPLE'S CONFIRMATIONS (#712): subject and
// answerer are separate schema columns; merging the two members is
// precisely what must not happen.
describe("a person's confirmers", () => {
  const ANA = (confirmedBy: Person["confirmed_by"]): Person => ({
    party_id: "p1",
    name: "Ana",
    count: 2,
    asset_ids: [],
    confirmed_by: confirmedBy,
  });

  it("says nothing when one member confirmed the whole group", () => {
    const html = markup({ people: [ANA([{ party_id: "m1", name: "Sam" }])] });
    expect(html).toContain("Ana");
    expect(html).not.toContain("Confirmed by");
  });

  it("names both answerers when the group spans two, and merges neither", () => {
    const html = markup({
      people: [
        ANA([
          { party_id: "m1", name: "Sam" },
          { party_id: "m2", name: "Kit" },
        ]),
      ],
    });
    expect(html).toContain("Confirmed by Sam and Kit");
    // The subject of the group is still one person, not two.
    expect(html).toContain("Ana");
    expect(html).not.toContain("Sam and Kit and Ana");
  });

  it("counts an unnameable confirmer without inventing a name for them", () => {
    const html = markup({
      people: [
        ANA([
          { party_id: "m1", name: "Sam" },
          { party_id: "device-7", name: null },
        ]),
      ],
    });
    expect(html).toContain("Confirmed by Sam and someone else");
    expect(html).not.toContain("device-7");
  });

  it("renders the roster unchanged when the gateway sent no confirmers", () => {
    const html = markup({ people: [ANA(undefined)] });
    expect(html).toContain("Ana");
    expect(html).not.toContain("Confirmed by");
  });
});
