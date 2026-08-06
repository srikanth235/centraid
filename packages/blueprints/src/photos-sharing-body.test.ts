// @vitest-environment jsdom
// The Sharing shelf's body (v4 handoff §H, proto 4235-4253): the counts it
// reads off the loaded rows, the two ways in and their refusals, and the
// difference between "nothing has been shared yet" and a populated shelf.
//
// Rendered to static markup like photos-selection-bar.test.ts — the view is a
// pure function of `sharingFacts`, so the markup IS the behaviour and a server
// render keeps the assertions free of act() noise. jsdom rather than the
// package's default node environment because the component tree pulls the
// shared kit in transitively.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/photos", rel)).href;

interface AudienceMember {
  memberId: string;
  name: string;
  role: string;
}
interface Scope {
  id: string;
  label: string;
  canWrite: boolean;
  personal?: boolean;
  audience?: readonly AudienceMember[];
}
interface Asset {
  asset_id: string;
  scope_id?: string | null;
}
interface SharingPlace {
  id: string;
  label: string;
  count: number;
  canWrite: boolean;
  isDestination: boolean;
  audience?: readonly AudienceMember[];
}
interface SharingFacts {
  ownLabel: string;
  ownCount: number;
  total: number;
  truncated: boolean;
  places: SharingPlace[];
  destinationReason: string | null;
}
interface FactsInput {
  shared: readonly Asset[];
  ownCount: number;
  scopes: readonly Scope[];
  ownScopeId: string;
  shareTargetId?: string;
  truncated: boolean;
}

const { sharingFacts, SharingBody } = (await import(
  app("components/Sharing.tsx")
)) as {
  sharingFacts: (input: FactsInput) => SharingFacts;
  SharingBody: ComponentType<Record<string, unknown>>;
};

const NOOP = () => {};

const OWN: Scope = {
  id: "own",
  label: "Library",
  canWrite: true,
  personal: true,
};
const SHARED: Scope = {
  id: "share",
  label: "Sharing",
  canWrite: true,
  personal: false,
};
/** Somebody else's audience: it is in the shelf, and it is not writable. */
const THEIRS: Scope = {
  id: "tom",
  label: "Tom's photographs",
  canWrite: false,
  personal: false,
};

function asset(id: string, scopeId: string): Asset {
  return { asset_id: id, scope_id: scopeId };
}

function render(facts: SharingFacts): string {
  return renderToStaticMarkup(
    createElement(SharingBody, {
      facts,
      onOpenLibrary: NOOP,
      onSelect: NOOP,
    })
  );
}

/** The opening `<button …>` tag whose text is `label`. */
function buttonFor(html: string, label: string): string {
  const match = html.match(new RegExp(`<button[^>]*>${label}</button>`, "u"));
  return match ? match[0] : "";
}

describe("sharingFacts", () => {
  it("counts each place from the rows the shelf is showing", () => {
    const facts = sharingFacts({
      shared: [asset("a", "share"), asset("b", "share"), asset("c", "tom")],
      ownCount: 12,
      scopes: [OWN, SHARED, THEIRS],
      ownScopeId: "own",
      shareTargetId: "share",
      truncated: false,
    });
    expect(facts.ownCount).toBe(12);
    expect(facts.total).toBe(3);
    expect(facts.places.map((p) => [p.label, p.count])).toStrictEqual([
      ["Sharing", 2],
      ["Tom's photographs", 1],
    ]);
    expect(facts.places[1]!.canWrite).toBe(false);
    expect(facts.destinationReason).toBeNull();
  });

  it("keeps a mounted place with nothing in it, at zero", () => {
    const facts = sharingFacts({
      shared: [],
      ownCount: 4,
      scopes: [OWN, SHARED],
      ownScopeId: "own",
      shareTargetId: "share",
      truncated: false,
    });
    expect(facts.total).toBe(0);
    expect(facts.places).toStrictEqual([
      {
        id: "share",
        label: "Sharing",
        count: 0,
        canWrite: true,
        isDestination: true,
      },
    ]);
  });

  it("distinguishes no pointer at all from a pointer this device cannot reach", () => {
    const none = sharingFacts({
      shared: [],
      ownCount: 0,
      scopes: [OWN],
      ownScopeId: "own",
      truncated: false,
    });
    expect(none.destinationReason).toBe(
      "There is nowhere to share to on this device yet."
    );
    const unmounted = sharingFacts({
      shared: [],
      ownCount: 0,
      scopes: [OWN],
      ownScopeId: "own",
      shareTargetId: "elsewhere",
      truncated: false,
    });
    expect(unmounted.destinationReason).toBe(
      "Where your shares go isn't open on this device."
    );
  });
});

describe("SharingBody", () => {
  it("says nothing is here yet, and disables the way back out", () => {
    const html = render(
      sharingFacts({
        shared: [],
        ownCount: 6,
        scopes: [OWN, SHARED],
        ownScopeId: "own",
        shareTargetId: "share",
        truncated: false,
      })
    );
    expect(html).toContain("Nothing is in Sharing yet.");
    expect(html).not.toContain("In Sharing now");
    // Nothing to remove, so the control stands disabled carrying the reason.
    expect(buttonFor(html, "Select photographs")).toContain("disabled");
    expect(html).toContain("Nothing is here to take back out.");
    // Copying is still offered: the destination resolves.
    expect(buttonFor(html, "Open your library")).not.toContain("disabled");
  });

  it("heads the grid with the live count once something is in it", () => {
    const html = render(
      sharingFacts({
        shared: [asset("a", "share"), asset("b", "share")],
        ownCount: 6,
        scopes: [OWN, SHARED],
        ownScopeId: "own",
        shareTargetId: "share",
        truncated: false,
      })
    );
    expect(html).toContain("In Sharing now");
    expect(html).toContain("2 · newest first");
    expect(buttonFor(html, "Select photographs")).not.toContain("disabled");
  });

  it("refuses the copy row with the pointer's own reason, never silently", () => {
    const html = render(
      sharingFacts({
        shared: [],
        ownCount: 6,
        scopes: [OWN],
        ownScopeId: "own",
        truncated: false,
      })
    );
    const button = buttonFor(html, "Open your library");
    expect(button).toContain("disabled");
    expect(button).toContain(
      "There is nowhere to share to on this device yet."
    );
  });

  it("marks a place the member may only read", () => {
    const html = render(
      sharingFacts({
        shared: [asset("c", "tom")],
        ownCount: 6,
        scopes: [OWN, THEIRS],
        ownScopeId: "own",
        truncated: false,
      })
    );
    expect(html).toContain("Tom&#x27;s photographs");
    expect(html).toContain("read only");
    // Nobody's shares go there, so the destination note stays off it.
    expect(html).not.toContain("where your shares go");
  });

  it("names which place the member's own shares go to", () => {
    const html = render(
      sharingFacts({
        shared: [asset("a", "share"), asset("c", "tom")],
        ownCount: 6,
        scopes: [OWN, SHARED, THEIRS],
        ownScopeId: "own",
        shareTargetId: "share",
        truncated: false,
      })
    );
    expect(html).toContain("where your shares go");
    expect(html).toContain("read only");
  });

  it("says the counts are a floor while the window is truncated", () => {
    const html = render(
      sharingFacts({
        shared: [asset("a", "share")],
        ownCount: 200,
        scopes: [OWN, SHARED],
        ownScopeId: "own",
        shareTargetId: "share",
        truncated: true,
      })
    );
    expect(html).toContain(
      "These counts cover the 201 photographs loaded here."
    );
  });

  it("draws the roster for a place the host answered — issue #712 P7", () => {
    const html = render(
      sharingFacts({
        shared: [asset("a", "share")],
        ownCount: 6,
        scopes: [
          OWN,
          {
            ...SHARED,
            audience: [
              { memberId: "m-priya", name: "Priya", role: "admin" },
              { memberId: "m-sid", name: "Sid", role: "write" },
            ],
          },
        ],
        ownScopeId: "own",
        shareTargetId: "share",
        truncated: false,
      })
    );
    expect(html).toContain("Who has access");
    expect(html).toContain("Priya");
    expect(html).toContain("Sid");
    expect(html).toContain("admin");
    expect(html).toContain("write");
  });

  it("stays silent about the roster when no place's host answered it", () => {
    const html = render(
      sharingFacts({
        shared: [asset("a", "share")],
        ownCount: 6,
        scopes: [OWN, SHARED],
        ownScopeId: "own",
        shareTargetId: "share",
        truncated: false,
      })
    );
    // Absent, not an empty section: an unanswered roster must never read as
    // "nobody else can see this".
    expect(html).not.toContain("Who has access");
  });
});
