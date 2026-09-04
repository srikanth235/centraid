/*
 * The pending-parent child-write surface (#922 G2).
 *
 * A member creates a project offline and immediately adds a task to it. This
 * probe counts the actions on the eight apps that can take a parent id a
 * projection minted, and holds the number: with the id minted AT THE SEAT and
 * honoured by the origin, each of these is a write that now lands pointing at
 * the row the member is looking at — and a new one appearing is a new place
 * that has to be true.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { stablePendingRowId } from "../apps/_shared/pending-overlay.js";

const APPS = [
  "agenda",
  "docs",
  "locker",
  "notes",
  "people",
  "photos",
  "tally",
  "tasks",
] as const;

const APPS_DIR = path.join(import.meta.dirname, "..", "apps");

/** Columns a projection fills with an id `stablePendingRowId` minted. */
function pendingMintedKeys(source: string): Set<string> {
  const minted = new Set<string>();
  const variables = new Set<string>();
  // The declaration may span lines (`const id =\n  typeof … ? … : mint(…)`),
  // so the search runs over the whole module with `[\s\S]` rather than a line.
  for (const match of source.matchAll(
    /const\s+(?<name>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=[\s\S]{0,200}?stablePendingRowId\s*\(/gu
  )) {
    if (match.groups?.name) variables.add(match.groups.name);
  }
  for (const variable of variables) {
    for (const match of source.matchAll(
      new RegExp(
        String.raw`(?<column>[A-Za-z_]\w*_id)\s*:\s*` +
          variable +
          String.raw`\b`,
        "gu"
      )
    )) {
      if (match.groups?.column) minted.add(match.groups.column);
    }
  }
  return minted;
}

function actionInputKeys(manifest: {
  actions?: {
    name: string;
    input?: { properties?: Record<string, unknown> };
  }[];
}): { name: string; keys: string[] }[] {
  return (manifest.actions ?? []).map((action) => ({
    name: action.name,
    keys: Object.keys(action.input?.properties ?? {}),
  }));
}

interface Edge {
  appId: string;
  action: string;
  key: string;
}

function probe(): Edge[] {
  const edges: Edge[] = [];
  for (const appId of APPS) {
    const manifest = JSON.parse(
      readFileSync(path.join(APPS_DIR, appId, "app.json"), "utf8")
    ) as Parameters<typeof actionInputKeys>[0];
    const minted = pendingMintedKeys(
      readFileSync(path.join(APPS_DIR, appId, "pending-projection.ts"), "utf8")
    );
    for (const action of actionInputKeys(manifest)) {
      for (const key of action.keys) {
        if (minted.has(key)) edges.push({ appId, action: action.name, key });
      }
    }
  }
  return edges;
}

describe("pending-parent child writes", () => {
  // #922 G2 answered this probe: a minted id is the row's REAL id, so there is
  // nothing about its spelling to recognize. It is deterministic in (intent,
  // suffix) so a replayed intent projects the same row, and it is canonical in
  // shape so the origin can honour it. Pendingness moved to the overlay's own
  // column on the row, where a reader can see it.
  test("a minted row id is canonical in shape and stable across replays", () => {
    const minted = stablePendingRowId("intent-1", "project");
    expect(minted).toBe(stablePendingRowId("intent-1", "project"));
    expect(minted).not.toBe(stablePendingRowId("intent-1", "task"));
    expect(minted).not.toBe(stablePendingRowId("intent-2", "project"));
    expect(minted).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-8[\da-f]{3}-8[\da-f]{3}-[\da-f]{12}$/u
    );
    expect(minted).not.toContain("pending:");
  });

  test("the child-write surface is counted and held", () => {
    const edges = probe();
    const byApp = new Map<string, number>();
    for (const edge of edges)
      byApp.set(edge.appId, (byApp.get(edge.appId) ?? 0) + 1);
    // The number this probe exists to report. It moved 66 to 67 when Tasks'
    // `add` began accepting the id its own projection mints (#922 G2) — a new
    // action taking a minted id must move it, which is exactly the point.
    expect(edges.length).toMatchInlineSnapshot(`67`);
    expect([...byApp.entries()].sort(([a], [b]) => a.localeCompare(b)))
      .toMatchInlineSnapshot(`
      [
        [
          "docs",
          11,
        ],
        [
          "notes",
          9,
        ],
        [
          "people",
          16,
        ],
        [
          "tally",
          20,
        ],
        [
          "tasks",
          11,
        ],
      ]
    `);
  });
});
