/*
 * The designed-state partition, per bundled blueprint (issue #839, gap G7).
 *
 * WHY THIS BLOCK EXISTS. Until now "which honest states does this app owe a
 * member" was only readable by eye, out of copy tables and component names —
 * `notes/components/States.tsx`, `agenda/view-copy.ts`'s `STATE_*`/`PARKED_*`/
 * `DENIED_*`, `tasks/logic.ts`'s `BoardStateName`, `docs/view-state.ts` +
 * `SeatStates.tsx` + `OFFLINE_BANNER`, `photos/view-copy.ts`'s `OFFLINE_COPY`
 * + `components/Permission.tsx`. Those are eight different vocabularies for
 * one product law, and a state an app simply never named was indistinguishable
 * from one it had decided not to have. `app.json#states` makes the answer
 * machine-readable, and the CLOSED partition makes the silence impossible:
 * every canonical state is claimed by exactly one side.
 *
 * WHY EVERY APP DESIGNS ALL SEVEN, AND `excluded` IS EMPTY EVERYWHERE.
 * `designed` is what the DESIGN calls for; `excluded` is what the design makes
 * structurally unrepresentable, and it costs a reason plus a citation — the
 * same evidence discipline as the engine contracts' own structural exclusions
 * (docs/blueprint-seats.md#engine-contracts). "Nobody has built it yet" is a
 * GAP, not an exclusion, and this umbrella exists to find gaps: writing an
 * unbuilt state into `excluded` would launder one into a non-goal.
 *
 * Checked app by app, none of the seven is structurally out of reach:
 *
 *   - `dayone` — every app has a first run, and every app already draws one:
 *     agenda `STATE_DAY_ONE`, notes `EMPTY_DAY_ONE`/`DayOne`, tasks
 *     `BoardStateName` `"day-one"`, docs `emptyStateView`'s `driveIsEmpty`
 *     ("the one first-run state"), people's `EmptyState` `first-run` variant,
 *     photos' `EMPTY_TITLE` + library body, locker's `List.tsx` empty pane.
 *     Tally's is held with its interface (#831), not designed away.
 *   - `pending`, `parked`, `denied`, `conflict` — all eight register a pending
 *     projection in `apps/_shared/pending-projections.ts`, and contract H's
 *     status grammar (`queued`/`parked`/`denied`/`conflict`/…) is SHARED, not
 *     per app. Locker's structural exclusion there is per ACTION (secret
 *     add/edit are online-only), not per app: its non-secret item actions
 *     still project, so the app still has the states. `conflict` is unbuilt
 *     everywhere today — no declaration supplies `baseVersions`, so
 *     `currentConflict` can never fire — which is exactly a gap worth seeing.
 *   - `offline`, `stale` — the reachability contract
 *     (docs/blueprint-seats.md, "Shared engines" row 3) stamps
 *     `data-gateway-status` on EVERY inline app root and every seat's replica
 *     can lag behind the vault. Neither fact is opt-out.
 *
 * So the honest partition today is uniform, and that is the strong claim, not
 * a weak one: no blueprint gets to skip a state, and a future skip has to
 * arrive as an `excluded` entry with a citation a reviewer can follow.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CANONICAL_DESIGNED_STATES,
  validateAppManifest,
} from "@centraid/server/engine";
import type { AppManifest } from "@centraid/server/engine";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

/** The eight bundled UI blueprints — the apps a member actually opens. */
const BLUEPRINT_APPS = [
  "agenda",
  "docs",
  "locker",
  "notes",
  "people",
  "photos",
  "tally",
  "tasks",
] as const;

function readManifest(id: string): AppManifest {
  return validateAppManifest(
    JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "apps", id, "app.json"), "utf8")
    )
  );
}

describe("app.json#states", () => {
  it("names the seven canonical states, in the issue's order", () => {
    expect([...CANONICAL_DESIGNED_STATES]).toStrictEqual([
      "dayone",
      "pending",
      "offline",
      "stale",
      "conflict",
      "parked",
      "denied",
    ]);
  });

  it.each(BLUEPRINT_APPS.map((id) => [id] as const))(
    "apps/%s declares a states block the real validator preserves",
    (id) => {
      // The validator returns a WHITELISTED projection — a block it does not
      // know about parses and is then silently dropped. Reading `states` off
      // the validated manifest (not off the raw JSON) is the assertion that
      // the block survives the round trip.
      const manifest = readManifest(id);
      expect(manifest.states).toBeDefined();
      expect(manifest.states?.designed).toStrictEqual([
        ...CANONICAL_DESIGNED_STATES,
      ]);
      expect(manifest.states?.excluded).toStrictEqual([]);
    }
  );

  it.each(BLUEPRINT_APPS.map((id) => [id] as const))(
    "apps/%s partitions every canonical state exactly once",
    (id) => {
      const states = readManifest(id).states;
      const claims = [
        ...(states?.designed ?? []),
        ...(states?.excluded ?? []).map((entry) => entry.state),
      ].toSorted();
      expect(claims).toStrictEqual([...CANONICAL_DESIGNED_STATES].toSorted());
    }
  );

  it("spends a reason and a citation on every exclusion, and has none", () => {
    // The whole exclusion table across the eight apps, asserted as one value:
    // empty today (see this file's header), and the first entry anyone adds
    // shows up in this diff with its evidence attached rather than slipping in
    // app by app.
    const table = BLUEPRINT_APPS.flatMap((id) =>
      (readManifest(id).states?.excluded ?? []).map((entry) => ({
        app: id,
        ...entry,
      }))
    );
    expect(table).toStrictEqual([]);
    for (const entry of table) {
      expect(entry.citation, `${entry.app}/${entry.state}`).toContain(".md");
      expect(entry.reason, `${entry.app}/${entry.state}`).not.toBe("");
    }
  });

  it("rides along in the gallery manifest, so the shell needs one fetch", () => {
    // `scripts/build-manifest.mjs` folds `states` in beside `seats`; this is
    // the check that the committed artifact was regenerated with it.
    const gallery = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "manifest.json"), "utf8")
    ) as {
      templates: Array<{ id: string; states?: { designed?: string[] } }>;
    };
    const withStates = gallery.templates
      .filter((template) => template.states !== undefined)
      .map((template) => template.id)
      .toSorted();
    expect(withStates).toStrictEqual([...BLUEPRINT_APPS].toSorted());
    for (const template of gallery.templates) {
      if (!template.states) continue;
      expect(
        template.states.designed,
        `${template.id} in manifest.json`
      ).toStrictEqual([...CANONICAL_DESIGNED_STATES]);
    }
  });

  it("stays optional for the UI-less automation manifests", () => {
    // 29 automation app.json files carry no interface and therefore no
    // designed states; the block must not become a load-time requirement.
    const gallery = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "manifest.json"), "utf8")
    ) as { templates: Array<{ id: string; kind?: string }> };
    const automations = gallery.templates.filter(
      (template) => template.kind === "automation"
    );
    expect(automations.length).toBeGreaterThan(0);
    for (const template of automations) {
      const manifest = validateAppManifest(
        JSON.parse(
          readFileSync(
            path.join(PACKAGE_ROOT, "automations", template.id, "app.json"),
            "utf8"
          )
        )
      );
      expect(
        manifest.states,
        `${template.id} declares no states`
      ).toBeUndefined();
    }
  });
});
