/*
 * The designed-state partition per blueprint (#839): every canonical state is
 * claimed by one side, so silence is impossible. `excluded` means structurally
 * unrepresentable and costs a reason plus a citation; "not built yet" is a GAP,
 * and writing one into `excluded` launders it into a non-goal.
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
      // The validator whitelists: an unknown block parses and is dropped.
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
      ].toSorted((left, right) => left.localeCompare(right));
      expect(claims).toStrictEqual(
        [...CANONICAL_DESIGNED_STATES].toSorted((left, right) =>
          left.localeCompare(right)
        )
      );
    }
  );

  it("spends a reason and a citation on every exclusion, and has none", () => {
    const table = BLUEPRINT_APPS.flatMap((id) =>
      (readManifest(id).states?.excluded ?? []).map((entry) => ({
        app: id,
        ...entry,
      }))
    );
    // The first real exclusion must REPLACE this pin with a check that every
    // entry carries a citation and a reason.
    expect(table).toStrictEqual([]);
  });

  it("rides along in the gallery manifest, so the shell needs one fetch", () => {
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
