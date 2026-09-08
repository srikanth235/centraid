/*
 * A PROJECTED ROW'S EDIT IS FORWARDED, NOT EXECUTED (#996, R10).
 *
 * Red-first against the wave 7 tree: `forwardProjectedEdit` shipped as a
 * question nothing asked, so an `edit`-grant member editing a row their vault
 * holds through a subscription had it written LOCALLY — into a row the origin
 * owns, which the very next `update` overwrites without telling anyone. These
 * two cases pin the whole contract: the intent reaches the origin and settles
 * with the ORIGIN's outcome and `commit_seq`, and a host that cannot reach the
 * origin says so instead of writing the row here.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { readReplicaIntentOutcome } from "@centraid/vault";

import type { ProjectedEditForwarder } from "../serve/projected-edit.js";
import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { handleReplicaIntent } from "./replica-intent-route.js";
import type { ReplicaIntentDispatcher } from "./replica-intent-route.js";
import { expectedPayloadHash } from "./replica-intent-shape.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

const AUTHORITY = "authority-shared-album";
const ORIGIN_VAULT = "vault-priya";
/** The audience's id for the row; the origin's is deliberately different. */
const AUDIENCE_ROW = "01927f00-0000-7000-8000-0000000000a1";
const ORIGIN_ROW = "01927f00-0000-7000-8000-0000000000b2";
const ENTITY = "media.asset";

describe("an edit of a projected row", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function projectedPlane(): Promise<VaultPlane> {
    const dir = await tempDir(`replica-projected-${crypto.randomUUID()}-`);
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger,
      enableWalShipper: false,
    });
    cleanups.push(
      () => fs.rm(dir, { recursive: true, force: true }),
      () => plane.stop()
    );
    const now = new Date().toISOString();
    plane.db.vault
      .prepare(
        `INSERT INTO share_subscription
           (authority_id, audience_vault_id, origin_vault_id, subject_type,
            cursor_epoch, cursor_seq, state, subscribed_at)
         VALUES (?, ?, ?, 'core.collection', 'epoch-1', 7, 'subscribed', ?)`
      )
      .run(AUTHORITY, plane.boot.vaultId, ORIGIN_VAULT, now);
    plane.db.vault
      .prepare(
        "INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at) VALUES (?, ?, ?)"
      )
      .run(AUDIENCE_ROW, ENTITY, now);
    plane.db.vault
      .prepare(
        `INSERT INTO share_subscription_lineage
           (authority_id, target_type, target_id, origin_item_id, origin_row_version)
         VALUES (?, ?, ?, ?, 41)`
      )
      .run(AUTHORITY, ENTITY, AUDIENCE_ROW, ORIGIN_ROW);
    return plane;
  }

  function request(payload: unknown): IncomingMessage {
    return Object.assign(Readable.from([JSON.stringify(payload)]), {
      headers: {},
      method: "POST",
      url: "/centraid/_vault/replica/intents",
    }) as unknown as IncomingMessage;
  }

  function response(): {
    res: ServerResponse;
    body: () => Record<string, unknown>;
  } {
    let output = "";
    const res = {
      statusCode: 0,
      setHeader: vi.fn<ServerResponse["setHeader"]>(),
      end: (value?: string) => {
        output = value ?? "";
      },
    } as unknown as ServerResponse;
    return { res, body: () => JSON.parse(output) as Record<string, unknown> };
  }

  const INPUT = { asset_id: AUDIENCE_ROW, title: "Sunset, retitled" };
  const BASE = [{ entity: ENTITY, rowId: AUDIENCE_ROW, version: 3 }];

  function body(intentId: string): Record<string, unknown> {
    return {
      intentId,
      appId: "photos",
      action: "rename_asset",
      input: INPUT,
      baseVersions: BASE,
      payloadHash: expectedPayloadHash("photos", "rename_asset", INPUT, BASE),
    };
  }

  const access = {
    canWrite: true,
    rememberDevice: true,
    deviceId: "device-member",
    appId: "photos",
  };

  test("is carried to the origin and settles with the ORIGIN's outcome", async () => {
    const plane = await projectedPlane();
    const dispatch = vi.fn<ReplicaIntentDispatcher>();
    const forward = vi.fn<ProjectedEditForwarder>().mockResolvedValue({
      status: "executed",
      commitSeq: 9_001,
    });

    const sent = response();
    await handleReplicaIntent(request(body("intent-projected-1")), sent.res, {
      plane,
      access,
      dispatch,
      forwardProjectedEdit: forward,
    });

    // NOT EXECUTED HERE. The local dispatcher never sees a row it does not own.
    expect(dispatch).not.toHaveBeenCalled();
    expect(sent.res.statusCode).toBe(200);
    expect(sent.body()).toMatchObject({
      outcome: { intentId: "intent-projected-1", status: "executed" },
    });
    // The envelope is addressed with the ORIGIN's id and version, out of
    // lineage — the audience's id names no row in the vault that executes it.
    expect(forward).toHaveBeenCalledOnce();
    expect(forward.mock.calls[0]![0]).toMatchObject({
      audienceVaultId: plane.boot.vaultId,
      route: {
        authorityId: AUTHORITY,
        entity: ENTITY,
        originVaultId: ORIGIN_VAULT,
        originItemId: ORIGIN_ROW,
        originRowVersion: 41,
      },
    });
    // The commit the seat waits for is the ORIGIN's, durably.
    expect(
      readReplicaIntentOutcome(
        plane.db.vault,
        "intent-projected-1",
        access.deviceId
      )?.commitSeq
    ).toBe(9_001);
  });

  test("stays in flight when the origin cannot be reached, and never lands locally", async () => {
    const plane = await projectedPlane();
    const dispatch = vi.fn<ReplicaIntentDispatcher>();

    const first = response();
    await handleReplicaIntent(request(body("intent-projected-2")), first.res, {
      plane,
      access,
      dispatch,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(first.res.statusCode).toBe(202);
    expect(first.body()).toMatchObject({
      accepted: true,
      outcome: { status: "in-flight" },
    });
    // `sending`, so the retry that finds a reachable origin consumes it.
    expect(
      readReplicaIntentOutcome(
        plane.db.vault,
        "intent-projected-2",
        access.deviceId
      )?.status
    ).toBe("sending");
  });
});
