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
interface EnrichmentConsentProps {
  count: number | null;
  onDevice: AnswerAvailability;
  cloud: AnswerAvailability;
  busy?: boolean;
  answered?: "device" | "declined" | null;
  onRunOnDevice: () => void;
  onDecline: () => void;
}
interface PeopleShelfProps {
  people: readonly Person[];
  proposals?: readonly unknown[];
  unmatchedCount?: number | null;
  assets: readonly unknown[];
  onOpen: (partyId: string) => void;
  onReview?: () => void;
  onNameProposal?: (regionId: string) => void;
  gate?: EnrichmentConsentProps;
}

const { PeopleShelf } = (await import(app("components/People.tsx"))) as {
  PeopleShelf: ComponentType<PeopleShelfProps>;
};
const { CLOUD_ANSWER, ON_DEVICE_PANEL } = (await import(
  app("enrichment-consent.ts")
)) as {
  CLOUD_ANSWER: AnswerAvailability;
  ON_DEVICE_PANEL: { action: string };
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

const GATE_PROPS: EnrichmentConsentProps = {
  count: 6214,
  onDevice: { available: true },
  cloud: CLOUD_ANSWER,
  onRunOnDevice: () => undefined,
  onDecline: () => undefined,
};

describe("the People shelf's consent gate", () => {
  it("renders the gate in place of the grid/note when `gate` is present", () => {
    const html = markup({ gate: GATE_PROPS });
    expect(html).toContain(ON_DEVICE_PANEL.action);
    expect(html).not.toContain("not matched to anyone");
  });

  it("renders the ordinary grid/note when `gate` is absent, unchanged", () => {
    const html = markup({ unmatchedCount: 3 });
    expect(html).toContain(
      "3 faces are not matched to anyone — face review proposes them one at a time."
    );
    expect(html).not.toContain(ON_DEVICE_PANEL.action);
  });

  it("prefers a non-empty roster's cards over the gate even if `gate` were passed", () => {
    const html = markup({
      people: [{ party_id: "p1", name: "Ana", count: 2, asset_ids: [] }],
      gate: GATE_PROPS,
    });
    expect(html).toContain(ON_DEVICE_PANEL.action);
    expect(html).not.toContain("Ana");
  });
});

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
// @vitest-environment jsdom
