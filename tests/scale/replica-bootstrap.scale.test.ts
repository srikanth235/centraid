import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { generateVolumeFixture } from "@centraid/test-kit/volume-fixture";
import { YEAR3_PENDING_INTENT_VOLUMES } from "@centraid/test-kit/year3-replica";
import { YEAR3_DISTRIBUTIONS } from "@centraid/test-kit/year3-vault";

import { NodeSqliteDriver } from "../../packages/client/src/replica/node-sqlite-test-driver.js";
import { makeReplicaRouteHandler } from "../../packages/server/src/routes/replica-routes.js";
import { EnrollmentStore } from "../../packages/server/src/serve/enrollment-store.js";
import { runWithVaultContext } from "../../packages/server/src/serve/vault-context.js";
import { openVaultPlane } from "../../packages/server/src/serve/vault-plane.js";
import type { VaultPlane } from "../../packages/server/src/serve/vault-plane.js";
import type { VaultRegistry } from "../../packages/server/src/serve/vault-registry.js";
import { goldenYear3Replica } from "../helpers/factories.js";
import { exerciseWindowedBootstrap } from "../quality/replica-bootstrap-fixture.js";

const OWNER = "tests/scale/replica-bootstrap.scale.test.ts";

describe("replica-bootstrap.scale", () => {
  test("windowed bootstrap converges after an in-flight deletion at volume", async () => {
    const fixture = generateVolumeFixture({
      seed: 458,
      parties: 0,
      photos: 0,
      conversations: 0,
      replicaRows: 50_000,
    });
    // The volume fixture types row values as Record<string, unknown>; the
    // deterministic string/number values it emits are all valid ReplicaValues, so
    // bridge the two fixture shapes explicitly for the bootstrap harness.
    const source = fixture.replicaRows as unknown as Parameters<
      typeof exerciseWindowedBootstrap
    >[0];
    const result = await exerciseWindowedBootstrap(source, 2_000, 24_999);
    const passed =
      result.rows === 49_999 &&
      result.cursor.seq === 11 &&
      result.durationMs < 20_000;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: "Replica convergence at 50k rows",
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: result.durationMs,
          unit: "ms",
          budget: 20_000,
        },
        { name: "converged rows", value: result.rows, unit: "rows" },
      ],
    });
    expect(result.rows).toBe(49_999);
    expect(result.cursor.seq).toBe(11);
    expect(result.durationMs).toBeLessThan(20_000);
  });

  // ── issue #750: the SERVER side of the same 50k walk ──────────────────
  //
  // The test above drives the client walk against a stub server; this one
  // proves the gateway's windowed bootstrap route (#419) at the same volume:
  // every response is bounded by `window` (no request serializes the full
  // 50k-row shape into one JSON envelope), and the continuation token is a
  // stateless resume cursor — the walk continues across a full vault-plane
  // stop/reopen without losing or duplicating a row.
  test("the gateway pages 50k rows bounded and resumes its cursor across a restart", async () => {
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    const dir = await tempDir(
      `replica-bootstrap-scale-${crypto.randomUUID()}-`
    );
    let plane: VaultPlane = openVaultPlane({
      bootstrap: true,
      dir,
      logger,
      enableWalShipper: false,
    });
    const enrollments = EnrollmentStore.open(path.join(dir, "gateway.db"));
    onTestFinished(async () => {
      plane.stop();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const deviceKey = "scale-device";
    enrollments.enroll({
      endpointId: deviceKey,
      vaultIds: [plane.boot.vaultId],
      label: "Scale device",
      rememberDevice: true,
    });
    plane.approveGrant("agenda", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", table: "task", verbs: "read+act" }],
    });

    const ROWS = 50_000;
    const WINDOW = 20_000;
    plane.db.vault.exec("BEGIN IMMEDIATE");
    try {
      const insert = plane.db.vault.prepare(
        `INSERT INTO schedule_task
           (task_id, owner_party_id, title, status, priority)
         VALUES (?, ?, ?, 'needs-action', 0)`
      );
      for (let index = 0; index < ROWS; index += 1) {
        insert.run(
          `task-${index.toString().padStart(6, "0")}`,
          plane.boot.ownerPartyId,
          `Task ${index}`
        );
      }
      plane.db.vault.exec("COMMIT");
    } catch (error) {
      plane.db.vault.exec("ROLLBACK");
      throw error;
    }

    const handler = makeReplicaRouteHandler(
      { current: () => plane } as unknown as VaultRegistry,
      {
        enrollments,
        dispatchIntent: () => Promise.resolve({ status: "executed" as const }),
      }
    );
    const page = async (
      query: string
    ): Promise<{
      status: number;
      page: {
        rows: Array<{ entity: string; rowId: string }>;
        complete: boolean;
        next?: string;
      };
    }> => {
      const req = Object.assign(Readable.from([]), {
        url: `/centraid/_vault/replica/bootstrap${query}`,
        method: "GET",
        headers: {},
      }) as unknown as IncomingMessage;
      let body = "";
      const res = {
        statusCode: 200,
        setHeader: () => undefined,
        write: (chunk: string | Buffer) => {
          body += String(chunk);
          return true;
        },
        end: (chunk?: string | Buffer) => {
          if (chunk !== undefined) body += String(chunk);
        },
        on: () => undefined,
        off: () => undefined,
      } as unknown as ServerResponse;
      await runWithVaultContext(
        { vaultId: plane.boot.vaultId, deviceKey },
        () => handler(req, res)
      );
      return {
        status: res.statusCode,
        page: JSON.parse(body) as {
          rows: Array<{ entity: string; rowId: string }>;
          complete: boolean;
          next?: string;
        },
      };
    };

    const started = performance.now();
    const seen = new Set<string>();
    let taskRowsDelivered = 0;
    let pages = 0;
    let maxRowsPerPage = 0;
    let restarted = false;
    let query = `?window=${WINDOW}`;
    for (;;) {
      // Sequential by construction: each page's query embeds the previous
      // page's continuation token.
      // oxlint-disable-next-line no-await-in-loop
      const result = await page(query);
      expect(result.status).toBe(200);
      pages += 1;
      maxRowsPerPage = Math.max(maxRowsPerPage, result.page.rows.length);
      for (const row of result.page.rows) {
        if (row.entity !== "schedule.task") continue;
        taskRowsDelivered += 1;
        seen.add(row.rowId);
      }
      if (result.page.complete) break;
      expect(result.page.next).toBeTruthy();
      if (!restarted) {
        // Stop the gateway's vault plane mid-walk and reopen it from disk: the
        // continuation token must remain a valid resume point (same epoch, same
        // shape catalog) across the restart.
        restarted = true;
        plane.stop();
        plane = openVaultPlane({ dir, logger, enableWalShipper: false });
      }
      query = `?window=${WINDOW}&after=${encodeURIComponent(result.page.next!)}`;
    }
    const durationMs = performance.now() - started;

    // Bounded: no response carried more than one window — the full 50k-row
    // shape was never loaded into a single JSON envelope.
    expect(maxRowsPerPage).toBeLessThanOrEqual(WINDOW);
    expect(pages).toBeGreaterThanOrEqual(Math.ceil(ROWS / WINDOW));
    expect(restarted).toBe(true);
    // Resumable: every row arrived EXACTLY once across the restart boundary —
    // no gap (seen.size) and no duplicate (delivered count).
    expect(seen.size).toBe(ROWS);
    expect(taskRowsDelivered).toBe(ROWS);
    expect(durationMs).toBeLessThan(30_000);
  });

  // ── issue #927 P4: the GOLDEN phone replica ──────────────────────────────
  //
  // The two tests above prove the WALK — the client side against a stub, the
  // server side against the real route. Neither leaves an artifact behind, so
  // every later journey rig would have to walk 50,000 rows again before it
  // could measure anything. This one materializes the walk's OUTPUT once: the
  // SQLite file a phone holds after a full bootstrap of the golden year-3
  // vault, plus the outbox at each of the converge journey's three volumes
  // (N = 1, 10, 40).
  //
  // Deliberately additive — the assertions above are untouched. The rows
  // arrive through the vault's own `readReplicaRows` and the client's own
  // `ReplicaSqliteStore.bootstrap`, and the outbox through the phone's own
  // `SqliteIntentStore`, so what this asserts about the artifact is an
  // assertion about the real apply path.
  test.each(YEAR3_PENDING_INTENT_VOLUMES)(
    "the golden phone replica materializes with %i pending intents",
    async (pending) => {
      const replica = await goldenYear3Replica({ pendingIntents: pending });
      // The declared year-3 phone volume, in full.
      expect(replica.rows).toBe(YEAR3_DISTRIBUTIONS.replicaRows);
      expect(replica.pendingIntents).toBe(pending);
      expect(replica.bytes).toBeGreaterThan(0);

      // Reopen the artifact exactly as a phone would: a fixture nothing can
      // open is not a fixture.
      const driver = new NodeSqliteDriver();
      driver.exec(
        `ATTACH DATABASE '${replica.file.replaceAll("'", "''")}' AS golden`
      );
      const rows = driver.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM golden.replica_row"
      )[0]!.n;
      const queued = driver.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM golden.replica_intent_outbox
            WHERE state = 'queued'`
      )[0]!.n;
      driver.close();
      expect(rows).toBe(YEAR3_DISTRIBUTIONS.replicaRows);
      expect(queued).toBe(pending);

      await recordQualityResult({
        lane: "scale",
        owner: OWNER,
        name: `Golden phone replica at ${YEAR3_DISTRIBUTIONS.replicaRows} rows, ${pending} pending intents`,
        status: "passed",
        measurements: [
          { name: "replica rows", value: replica.rows, unit: "rows" },
          { name: "pending intents", value: pending, unit: "count" },
          { name: "replica on disk", value: replica.bytes, unit: "bytes" },
          { name: "build", value: replica.buildMs, unit: "ms" },
          {
            name: "golden fixture cache hit",
            value: replica.cacheHit ? 1 : 0,
            unit: "count",
          },
        ],
      });
    },
    600_000
  );
});
