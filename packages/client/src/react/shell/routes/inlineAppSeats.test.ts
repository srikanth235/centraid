import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  INLINE_APP_DISABLED_SEATS,
  isDisabledOnSeat,
} from "./inlineAppSeats.js";

// Cross-checks the synchronous table above against the real manifests it
// mirrors — the drift tripwire the module's own doc comment promises. Walks
// UP from this test file rather than importing @centraid/blueprints, since
// that package's runtime entry pulls in Node-only app-engine validation that
// the client package must not depend on; a raw fs read of app.json is safe.
const BLUEPRINTS_APPS_DIR = path.resolve(
  import.meta.dirname,
  "../../../../../../packages/blueprints/apps"
);

function bundledAppIds(): string[] {
  return readdirSync(BLUEPRINTS_APPS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .toSorted();
}

function disabledOnFromManifest(id: string): readonly string[] {
  const manifestPath = path.join(BLUEPRINTS_APPS_DIR, id, "app.json");
  if (!existsSync(manifestPath)) return [];
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    seats?: { disabledOn?: readonly string[] };
  };
  return parsed.seats?.disabledOn ?? [];
}

describe("inline app disabled seats", () => {
  it("matches every bundled app.json's seats.disabledOn exactly", () => {
    const fromManifests: Record<string, readonly string[]> = {};
    for (const id of bundledAppIds()) {
      const disabledOn = disabledOnFromManifest(id);
      if (disabledOn.length > 0) fromManifests[id] = disabledOn;
    }
    // Only apps that actually declare a restriction show up on either side —
    // an app.json with an empty `disabledOn` needs no entry in the table.
    expect(INLINE_APP_DISABLED_SEATS).toStrictEqual(fromManifests);
  });

  it("Locker refuses the viewer seat (docs/blueprint-seats.md S5)", () => {
    expect(isDisabledOnSeat("locker", "viewer")).toBe(true);
    expect(isDisabledOnSeat("locker", "custodian")).toBe(false);
  });

  it("an app with no restriction mounts on every seat", () => {
    expect(isDisabledOnSeat("tasks", "viewer")).toBe(false);
    expect(isDisabledOnSeat("tasks", "custodian")).toBe(false);
  });
});
