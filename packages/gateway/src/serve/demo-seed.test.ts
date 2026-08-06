import { existsSync } from "node:fs";
import path from "node:path";
// Scenario seeds end-to-end (issue #290 phase 1): every blueprint seed.js
// runs in the real handler worker against a real vault plane through the
// demo bridge — the same path the demo route drives — then purges clean.
// This is the schema-drift tripwire: a command a generator calls that no
// longer exists (or whose input changed) fails HERE, not on an owner's
// first click.

import { afterEach, describe, expect, test } from "vitest";

import { runHandler } from "@centraid/app-engine";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { openVaultPlane } from "./vault-plane.js";
import type { VaultPlane } from "./vault-plane.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const TIME_ENGINE_MODULE_URL = import.meta.resolve("@centraid/time-engine");

const cleanups: Array<() => Promise<void> | void> = [];
describe("demo-seed", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });
  function openPlane(dir: string): VaultPlane {
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());
    return plane;
  }

  const BLUEPRINTS = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "blueprints",
    "apps"
  );

  async function loadSeed(
    plane: VaultPlane,
    appId: string,
    appsDir: string
  ): Promise<void> {
    const seedFile = path.join(BLUEPRINTS, appId, "seed.js");
    expect(existsSync(seedFile), `${appId} ships seed.js`).toBe(true);
    const outcome = await runHandler({
      app: { id: appId, dir: path.join(appsDir, appId) },
      handlerFile: seedFile,
      handlerKind: "action",
      args: { input: { seed: 1, now: new Date().toISOString() } },
      timeoutMs: 60_000,
      vault: plane.demoBridgeFor(appId),
      timeModuleUrl: TIME_ENGINE_MODULE_URL,
    });
    expect(outcome.ok, `${appId} seed: ${outcome.error ?? ""}`).toBe(true);
  }

  test("every shipped scenario seeds through the demo register and purges clean", async () => {
    const dir = await tempDir();
    const plane = openPlane(dir);
    const appsDir = path.join(dir, "apps");

    await forEachSequentially(
      ["agenda", "docs", "tasks", "notes", "people", "photos", "tally"],
      (appId) => loadSeed(plane, appId, appsDir)
    );

    const status = plane.demoStatus();
    const byApp = new Map(status.map((s) => [s.appId, s.rows]));
    expect([...byApp.keys()].sort()).toStrictEqual([
      "agenda",
      "docs",
      "notes",
      "people",
      "photos",
      "tally",
      "tasks",
    ]);
    for (const [appId, rows] of byApp)
      expect(rows, `${appId} seeded rows`).toBeGreaterThan(0);

    // Every seeded ENTITY carries seed.demo provenance and one registry row —
    // provenance may hold several rows per entity (a task added then completed
    // writes twice), the registry exactly one.
    const provCounts = plane.db.journal
      .prepare(
        `SELECT count(DISTINCT entity_type || ':' || entity_id) AS n
         FROM consent_provenance WHERE prov_activity = 'seed.demo'`
      )
      .get() as { n: number };
    const registered = plane.db.vault
      .prepare("SELECT count(*) AS n FROM consent_seed_row")
      .get() as {
      n: number;
    };
    expect(provCounts.n).toBe(registered.n);

    // Purge everything: registry empty, domain tables empty of demo rows.
    const purge = plane.purgeDemo();
    expect(purge.blocked).toStrictEqual([]);
    expect(purge.purged).toBe(registered.n);
    expect(plane.demoStatus()).toStrictEqual([]);
    for (const table of [
      "schedule_task",
      "knowledge_note",
      "tally_expense",
      "people_profile",
      "core_event",
      "core_document",
      "media_media_asset",
    ]) {
      const left = plane.db.vault
        .prepare(`SELECT count(*) AS n FROM ${table}`)
        .get() as {
        n: number;
      };
      expect(left.n, `${table} empty after purge`).toBe(0);
    }
  });

  // The photo roll is the one scenario whose bytes ship BESIDE its generator
  // (issue #708): seed.js reads `sample/*.png` off its own directory through
  // `import.meta.url`. A missing image, a lost `files:` entry, or a renamed
  // sample would still "seed" — as zero assets — so this asserts the shape the
  // grid, the favorites filter and the album rail actually render.
  test("the photos scenario lands a full camera roll, favorites and an album", async () => {
    const dir = await tempDir();
    const plane = openPlane(dir);
    await loadSeed(plane, "photos", path.join(dir, "apps"));

    const count = (sql: string): number =>
      (plane.db.vault.prepare(sql).get() as { n: number }).n;
    expect(count("SELECT count(*) AS n FROM media_media_asset")).toBe(18);
    expect(
      count("SELECT count(*) AS n FROM media_media_asset WHERE favorite = 1")
    ).toBe(2);
    // Every asset carries what the grid needs to paint without a round trip:
    // real bytes, dimensions, a capture time, and a ThumbHash placeholder.
    expect(
      count(
        `SELECT count(*) AS n FROM media_media_asset a
           JOIN core_content_item c ON c.content_id = a.content_id
           JOIN core_content_derivative d
             ON d.content_id = a.content_id AND d.variant = 'thumbhash'
          WHERE a.width IS NOT NULL AND a.height IS NOT NULL
            AND a.captured_at IS NOT NULL AND c.byte_size > 0`
      )
    ).toBe(18);
    // Face proposals (issue #712): the portrait frames stage regions through
    // the ordinary enrichment publisher, so People and the triage verb have a
    // queue to answer on a fresh vault. Every seeded region must arrive
    // UNANSWERED — a seed that pre-confirmed them would hide the one flow the
    // scenario exists to exercise.
    expect(count("SELECT count(*) AS n FROM media_face_region")).toBe(8);
    expect(
      count(
        "SELECT count(*) AS n FROM media_face_region WHERE review_state = 'proposed'"
      )
    ).toBe(8);
    expect(
      count(
        "SELECT count(*) AS n FROM media_face_region WHERE bbox_json IS NULL"
      )
    ).toBe(0);
    // Two people to name a confirmed face as; face review never invents one.
    expect(
      count(
        "SELECT count(*) AS n FROM core_party WHERE display_name IN ('Ana Ribeiro','Marco Salas')"
      )
    ).toBe(2);

    const album = plane.db.vault
      .prepare(
        "SELECT collection_id, cover_content_id FROM core_collection WHERE name = 'Tahoe scouting'"
      )
      .get() as { collection_id: string; cover_content_id: string | null };
    expect(album.cover_content_id).not.toBeNull();
    expect(
      (
        plane.db.vault
          .prepare(
            `SELECT count(*) AS n FROM core_collection_entry
              WHERE collection_id = ? AND target_type = 'media.media_asset'`
          )
          .get(album.collection_id) as { n: number }
      ).n
    ).toBe(4);
  });

  test("the demo bridge refuses non-scenario ops and non-owner registers stay impossible", async () => {
    const dir = await tempDir();
    const plane = openPlane(dir);
    const bridge = plane.demoBridgeFor("tasks");
    const refused = await bridge({
      op: "changes",
      payload: { entities: ["schedule.task"] },
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not part of the scenario surface/u);
  });
});
