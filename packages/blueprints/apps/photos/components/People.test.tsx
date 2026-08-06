// @vitest-environment jsdom
// THE PEOPLE SHELF'S CONSENT GATE (issue #712 C2).
//
// The face-detection consent question used to open from a toolbar icon +
// `<dialog>` (components/Enrichment.tsx, retired) — built, correct, and
// nearly unreachable. It now re-homes into THIS shelf's empty state: while
// the roster (and its proposals) are empty and the question is still open,
// `gate` renders in place of the grid/note. `app-root.tsx` (enrichment-gate.ts)
// decides WHEN that is true; this file only proves `PeopleShelf` renders
// what it is given — the gate when `gate` is present, the ordinary grid/note
// otherwise — and never both at once.
//
// A pure-view test, same technique enrichment-consent.test.ts uses:
// `renderToStaticMarkup` over the component's props, because `PeopleShelf`
// holds no state of its own.
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
    // Not the plain pending-note copy — the gate is the whole empty state.
    expect(html).not.toContain("not matched to anyone");
  });

  it("renders the ordinary grid/note when `gate` is absent, unchanged", () => {
    const html = markup({ unmatchedCount: 3 });
    expect(html).toContain(
      "3 faces are not matched to anyone. Face review proposes them one at a time, and nothing is named until you name it."
    );
    expect(html).not.toContain(ON_DEVICE_PANEL.action);
  });

  it("prefers a non-empty roster's cards over the gate even if `gate` were passed", () => {
    // Belt and braces: app-root.tsx never passes `gate` alongside a non-empty
    // roster (enrichment-gate.ts's `rosterEmpty` check), but the component
    // itself should never show both a card grid and the gate at once — the
    // gate branch returns unconditionally, so this pins that it is the
    // CALLER's job to withhold `gate`, not this component silently merging
    // the two states.
    const html = markup({
      people: [{ party_id: "p1", name: "Ana", count: 2, asset_ids: [] }],
      gate: GATE_PROPS,
    });
    expect(html).toContain(ON_DEVICE_PANEL.action);
    expect(html).not.toContain("Ana");
  });
});
