/*
 * The pending-parent child-write probe (#922 G2).
 *
 * A member creates a project offline and immediately adds a task to it. The
 * project's row exists only as an overlay under a `pending:` id, so the task's
 * `project_id` carries an id no canonical row will ever have. This probe does
 * not fix that; it MEASURES it — how many actions on the eight apps can take
 * a pending parent id — and holds the count so the surface cannot widen
 * unnoticed while the fix is designed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  isPendingRowId,
  stablePendingRowId,
} from "../apps/_shared/pending-overlay.js";

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
  test("a pending row id is recognizable wherever a child write carries one", () => {
    expect(isPendingRowId(stablePendingRowId("intent-1", "project"))).toBe(
      true
    );
    expect(isPendingRowId("project-7")).toBe(false);
    expect(isPendingRowId(undefined)).toBe(false);
  });

  test("the child-write surface is counted and held", () => {
    const edges = probe();
    const byApp = new Map<string, number>();
    for (const edge of edges)
      byApp.set(edge.appId, (byApp.get(edge.appId) ?? 0) + 1);
    // The number this probe exists to report. A new action taking a parent id
    // a projection mints must move it, which is the point.
    expect(edges.length).toMatchInlineSnapshot(`66`);
    expect([...byApp.entries()].sort()).toMatchInlineSnapshot(`
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
          10,
        ],
      ]
    `);
  });
});
