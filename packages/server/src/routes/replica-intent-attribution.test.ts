import crypto from "node:crypto";
/*
 * L4 attribution through the replica-intent path (#599 decision 8).
 *
 * A write replayed from a phone must name the PERSON who made it, not only
 * the hardware that carried it — and it must name them by id, so a rename on
 * the gateway cannot fork or strand their history. The owner travels with
 * the intent (`replica-intent-context.ts`), lands on the invoke request in
 * `VaultPlane.bridgeFor`, and is written into the invocation's journal
 * receipt.
 */
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, afterEach, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { plainSqliteRow } from "@centraid/test-kit/sqlite";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { handleReplicaIntent } from "./replica-intent-route.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];
describe("replica-intent-attribution suite", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function plane(): Promise<VaultPlane> {
    const dir = await tempDir(`intent-attribution-${crypto.randomUUID()}-`);
    const opened = openVaultPlane({
      bootstrap: true,
      dir,
      logger,
      enableWalShipper: false,
    });
    cleanups.push(
      () => fs.rm(dir, { recursive: true, force: true }),
      () => opened.stop()
    );
    return opened;
  }

  function request(body: unknown): IncomingMessage {
    return Object.assign(Readable.from([JSON.stringify(body)]), {
      headers: {},
      method: "POST",
      url: "/centraid/_vault/replica/intents",
    }) as unknown as IncomingMessage;
  }

  function response(): ServerResponse {
    return {
      statusCode: 0,
      setHeader: () => undefined,
      end: () => undefined,
    } as unknown as ServerResponse;
  }

  /** The one receipt the invocation left, decoded. */
  function receiptDetail(vault: VaultPlane): Record<string, unknown> {
    const row = vault.db.audit
      .prepare(
        `SELECT detail_json FROM access_receipt
        WHERE action = 'act schedule.add_task' AND decision = 'allow'
        ORDER BY receipt_id DESC LIMIT 1`
      )
      .get() as { detail_json: string | null } | undefined;
    expect(
      row,
      "expected an allow receipt for the replayed write"
    ).toBeDefined();
    return JSON.parse(row?.detail_json ?? "{}") as Record<string, unknown>;
  }

  async function replayOfflineWrite(
    vault: VaultPlane,
    access: { deviceId: string; ownerId?: string }
  ): Promise<string> {
    vault.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });
    const input = { title: "buy milk" };
    const body = {
      intentId: `intent-${crypto.randomUUID()}`,
      appId: "planner",
      action: "add_task",
      input,
      payloadHash: crypto
        .createHash("sha256")
        .update(JSON.stringify({ action: "add_task", appId: "planner", input }))
        .digest("hex"),
    };
    await handleReplicaIntent(request(body), response(), {
      plane: vault,
      access: {
        canWrite: true,
        rememberDevice: true,
        deviceId: access.deviceId,
        appId: "planner",
        ...(access.ownerId === undefined ? {} : { ownerId: access.ownerId }),
      },
      // The real bridge — this is the seam under test, so it is not stubbed.
      dispatch: async () => {
        const result = await vault.bridgeFor("planner")({
          op: "invoke",
          payload: { command: "schedule.add_task", input },
        });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        return { status: "executed" };
      },
    });
    return body.intentId;
  }

  test("a replayed offline write journals the acting owner id", async () => {
    const vault = await plane();

    await replayOfflineWrite(vault, {
      deviceId: "sid-phone",
      ownerId: "owner-sid-01",
    });

    expect(receiptDetail(vault)).toMatchObject({
      actingOwner: "owner-sid-01",
    });
    expect(
      plainSqliteRow(
        vault.db.vault.prepare("SELECT count(*) AS n FROM schedule_task").get()
      )
    ).toStrictEqual({
      n: 1,
    });
  });

  test("the attribution is the id, so a rename leaves it exactly as written", async () => {
    const vault = await plane();
    const dir = await tempDir(
      `intent-attribution-roster-${crypto.randomUUID()}-`
    );
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const database = GatewayDatabase.open(dir);
    cleanups.push(() => database.close());
    const enrollments = EnrollmentStore.open(database);
    const sid = enrollments.enroll({
      endpointId: "sid-phone",
      vaultIds: ["vault-family"],
      label: "Sid phone",
      ownerLabel: "Sid",
    });

    await replayOfflineWrite(vault, {
      deviceId: "sid-phone",
      ownerId: sid.ownerId,
    });
    const before = receiptDetail(vault);
    enrollments.owners.rename(sid.ownerId, "Siddharth");

    // The journal is append-only and keys on the id — the row is untouched, and
    // it still resolves to the (renamed) person.
    expect(receiptDetail(vault)).toStrictEqual(before);
    expect(before).toMatchObject({ actingOwner: sid.ownerId });
    expect(enrollments.owners.get(sid.ownerId)?.label).toBe("Siddharth");
  });

  test("an app cannot name another device to claim that device intent", async () => {
    const vault = await plane();
    // Sid's phone queued a write offline; the gateway replayed it and the
    // intent's outcome row now names `sid-phone`.
    const intentId = await replayOfflineWrite(vault, { deviceId: "sid-phone" });

    // A later call arrives with NO host device context (no replica-intent scope,
    // no request device key) and supplies the pair itself. `intentDeviceId` is
    // the vault's only ownership evidence — if the payload could set it, the
    // check would compare the forgery against itself and pass.
    const forged = await vault.bridgeFor("planner")({
      op: "invoke",
      payload: {
        command: "schedule.add_task",
        input: { title: "not mine to settle" },
        intentId,
        intentDeviceId: "sid-phone",
      },
    });

    expect(forged.ok).toBe(false);
    expect(String((forged as { error?: string }).error)).toContain(
      "is not owned by this device"
    );
    // And nothing was written under the hijacked intent.
    expect(
      plainSqliteRow(
        vault.db.vault.prepare("SELECT count(*) AS n FROM schedule_task").get()
      )
    ).toStrictEqual({
      n: 1,
    });
  });

  test("a write with no resolvable owner journals none rather than guessing", async () => {
    const vault = await plane();

    await replayOfflineWrite(vault, { deviceId: "anonymous-host" });

    expect(receiptDetail(vault)).not.toHaveProperty("actingOwner");
  });
});
