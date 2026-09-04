import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  auditPendingProjections,
  isDestructiveAction,
} from "./pending-projection-tripwire.js";
import type { AppProjectionInput } from "./pending-projection-tripwire.js";

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

function realApps(): AppProjectionInput[] {
  return APPS.map((appId) => {
    const manifest = JSON.parse(
      readFileSync(path.join(APPS_DIR, appId, "app.json"), "utf8")
    ) as { actions?: { name: string }[] };
    return {
      appId,
      actionNames: (manifest.actions ?? []).map((action) => action.name),
      source: readFileSync(
        path.join(APPS_DIR, appId, "pending-projection.ts"),
        "utf8"
      ),
    };
  });
}

describe("destructive pending projections", () => {
  test("[law:pending-destructive-projection] every destructive action on the eight apps projects a delete or a tombstone", () => {
    const audit = auditPendingProjections(realApps());
    expect(audit.findings).toStrictEqual([]);
    // The per-app tally is evidence, so it is asserted rather than printed: a
    // destructive action that quietly becomes an exclusion moves a number here.
    expect(audit.counts).toStrictEqual([
      {
        appId: "agenda",
        actions: 7,
        destructive: 1,
        delete: 0,
        tombstone: 0,
        excluded: 1,
      },
      {
        appId: "docs",
        actions: 15,
        destructive: 3,
        delete: 1,
        tombstone: 1,
        excluded: 1,
      },
      {
        appId: "locker",
        actions: 16,
        destructive: 3,
        delete: 2,
        tombstone: 1,
        excluded: 0,
      },
      {
        appId: "notes",
        actions: 15,
        destructive: 4,
        delete: 1,
        tombstone: 1,
        excluded: 2,
      },
      {
        appId: "people",
        actions: 28,
        destructive: 3,
        delete: 1,
        tombstone: 0,
        excluded: 2,
      },
      {
        appId: "photos",
        actions: 18,
        destructive: 5,
        delete: 2,
        tombstone: 1,
        excluded: 2,
      },
      {
        appId: "tally",
        actions: 21,
        destructive: 3,
        delete: 1,
        tombstone: 1,
        excluded: 1,
      },
      {
        appId: "tasks",
        actions: 11,
        destructive: 3,
        delete: 1,
        tombstone: 0,
        excluded: 2,
      },
    ]);
    // Every app is actually scanned: a projection module the parser fails to
    // read would report zero destructive actions and pass silently.
    expect(audit.counts.map((each) => each.appId)).toStrictEqual([...APPS]);
    expect(
      audit.counts.reduce((total, each) => total + each.destructive, 0)
    ).toBeGreaterThan(0);
    for (const app of audit.counts) {
      expect(
        app.delete + app.tombstone + app.excluded,
        `${app.appId} destructive actions must all be judged`
      ).toBe(app.destructive);
    }
  });

  test("a destructive action whose projection only patches is a finding", () => {
    const audit = auditPendingProjections([
      {
        appId: "synthetic",
        actionNames: ["add", "delete", "remove-tag"],
        source: `export const p = definePendingProjection({
          appId: "synthetic",
          actions: {
            add: ({ input }) => [pendingUpsert("a.b", "1", input)],
            delete: ({ input }) => pendingPatch("a.b", input.id, input, ["title"]),
            "remove-tag": { excluded: true, reason: "no row id in the payload" },
          },
        });`,
      },
    ]);
    expect(audit.findings).toStrictEqual([
      { appId: "synthetic", action: "delete", verdict: "missing" },
    ]);
    expect(audit.counts[0]).toStrictEqual({
      appId: "synthetic",
      actions: 3,
      destructive: 2,
      delete: 0,
      tombstone: 0,
      excluded: 1,
    });
  });

  test("an exclusion without a written reason is not an exclusion", () => {
    const audit = auditPendingProjections([
      {
        appId: "synthetic",
        actionNames: ["delete"],
        source: `actions: { delete: { excluded: true } },`,
      },
    ]);
    expect(audit.findings).toStrictEqual([
      { appId: "synthetic", action: "delete", verdict: "missing" },
    ]);
  });

  test("a destructive action the projection map never mentions is a finding", () => {
    const audit = auditPendingProjections([
      {
        appId: "synthetic",
        actionNames: ["purge-everything"],
        source: `actions: { add: ({ input }) => [] },`,
      },
    ]);
    expect(audit.findings).toStrictEqual([
      { appId: "synthetic", action: "purge-everything", verdict: "unhandled" },
    ]);
  });

  test("only destructive names are judged", () => {
    expect(
      ["delete", "remove-tag", "discard", "purge-all", "unlink"].every(
        isDestructiveAction
      )
    ).toBe(true);
    expect(
      ["add", "edit", "save-project", "deliver", "removeless"].some(
        isDestructiveAction
      )
    ).toBe(false);
  });
});
