import crypto from "node:crypto";
/*
 * Lifecycle-shared publish/delete helpers (issue #147, Concern 3).
 *
 * The point of these helpers is that no route hand-sequences
 * `publish → ensureRegistered → reconcile` (or `deleteApp → deregister →
 * reconcile`) itself. These tests pin that invariant: each helper drives the
 * full sequence — in order — against fakes, so a future edit that drops the
 * `reconcile()` call (the easy bug) fails here.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import * as automation from "@centraid/automation";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { writeFileMap } from "../routes/route-helpers.js";
import type { WorktreeStore } from "../worktree-store/index.js";
import {
  deleteAppAndReconcile,
  publishAndReconcile,
} from "./lifecycle-shared.js";
import type { LifecycleRouteOptions } from "./lifecycle-shared.js";

let appDir: string;
let calls: string[];

/** A fake store + options that record the order of lifecycle side effects. */
function makeOpts(): LifecycleRouteOptions {
  const store = {
    async snapshotSessionAppDir() {
      return appDir;
    },
    async publish() {
      calls.push("publish");
      return { versionTag: "v1", sha: "deadbeef" };
    },
    async deleteApp() {
      calls.push("deleteApp");
    },
    async closeSession() {
      calls.push("closeSession");
    },
  } as unknown as WorktreeStore;

  return {
    store,
    codeAppsDir: () => appDir,
    ensureRegistered: async () => {
      calls.push("ensureRegistered");
    },
    preparePublishedApp: async () => {
      calls.push("preparePublishedApp");
    },
    deregister: async () => {
      calls.push("deregister");
    },
    reconcile: () => {
      calls.push("reconcile");
    },
  };
}

describe("lifecycle-shared", () => {
  beforeEach(async () => {
    appDir = await tempDir(`gw-lifecycle-${crypto.randomUUID()}-`);
    calls = [];
  });

  afterEach(async () => {
    await fs.rm(appDir, { recursive: true, force: true });
  });

  test("publishAndReconcile validates, publishes, registers, reconciles, then closes", async () => {
    // A valid scaffolded automation app so manifest validation passes.
    await writeFileMap(
      appDir,
      automation.scaffoldAppFiles("notes", { prompt: "do it" })
    );

    await publishAndReconcile(makeOpts(), {
      appId: "notes",
      sessionId: "s1",
      appDir,
      message: "publish notes",
      ephemeralSession: true,
    });

    expect(calls).toStrictEqual([
      "publish",
      "ensureRegistered",
      "preparePublishedApp",
      "reconcile",
      "closeSession",
    ]);
  });

  test("publishAndReconcile keeps a non-ephemeral session open", async () => {
    await writeFileMap(
      appDir,
      automation.scaffoldAppFiles("notes", { prompt: "do it" })
    );

    await publishAndReconcile(makeOpts(), {
      appId: "notes",
      sessionId: "s1",
      appDir,
      message: "publish notes",
    });

    expect(calls).toStrictEqual([
      "publish",
      "ensureRegistered",
      "preparePublishedApp",
      "reconcile",
    ]);
  });

  test("publishAndReconcile rejects an invalid manifest before publishing", async () => {
    await fs.writeFile(
      path.join(appDir, "app.json"),
      "{ not valid json",
      "utf8"
    );

    await expect(
      (() =>
        publishAndReconcile(makeOpts(), {
          appId: "notes",
          sessionId: "s1",
          appDir,
          message: "publish notes",
        }))()
    ).rejects.toThrow(
      "app.json invalid (invalid_json): app.json is not valid JSON"
    );
    // Validation gates the whole sequence — nothing ran.
    expect(calls).toStrictEqual([]);
  });

  test("deleteAppAndReconcile deletes, deregisters, then reconciles — in order", async () => {
    await deleteAppAndReconcile(makeOpts(), "notes");
    expect(calls).toStrictEqual(["deleteApp", "deregister", "reconcile"]);
  });
});
