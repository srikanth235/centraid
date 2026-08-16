/*
 * The owner-facing edge plane, end to end over the LOCAL transport (#726 P2,
 * reshaped by #750): the same reducer and the same outbox the peer transport
 * uses, with both vaults open in this process.
 *
 * What this pins that the reducer's unit tests cannot: an edge listed by
 * OWNER rather than by the device that made it (a phone must not show a
 * different share history than the laptop), a replayed POST that leaves
 * exactly one projection and one receipt, and a give this gateway could not
 * act on parking with an obligation that survives it.
 */

import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import { tempDirSync } from "@centraid/test-kit/temp-dir";
import { blobUriFor, bootstrapVault, openVaultDb } from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { readEdgeRow } from "../serve/share-edge-row.js";
import { listQueuedEffects } from "../serve/share-effects.js";
import { VaultLinksStore } from "../serve/vault-links-store.js";
import { makeEdgesRouteHandler } from "./edges-routes.js";

interface Household {
  gatewayDb: GatewayDatabase;
  links: VaultLinksStore;
  work: VaultDb;
  personal: VaultDb;
  laptop: string;
  phone: string;
  handler: ReturnType<typeof makeEdgesRouteHandler>;
}

const WORK = "vlt_work";
const PERSONAL = "vlt_personal";

function openVault(root: string, name: string, vaultId: string): VaultDb {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const vault = openVaultDb({ dir });
  bootstrapVault(vault, { ownerName: name, vaultId });
  return vault;
}

/** One owner, two of their own vaults, two of their own devices. */
function household(): Household {
  const root = tempDirSync("centraid-edges-route-");
  const gatewayDb = GatewayDatabase.open(path.join(root, "gateway"));
  const enrollments = EnrollmentStore.open(gatewayDb);
  const laptop = enrollments.enroll({
    endpointId: "device-laptop",
    vaultIds: [WORK, PERSONAL],
    label: "laptop",
    ownerLabel: "Ada",
  });
  const phone = enrollments.enroll({
    endpointId: "device-phone",
    vaultIds: [WORK, PERSONAL],
    label: "phone",
    ownerId: laptop.ownerId,
  });
  const work = openVault(root, "work", WORK);
  const personal = openVault(root, "personal", PERSONAL);
  const links = VaultLinksStore.open(gatewayDb);
  const handler = makeEdgesRouteHandler({
    gatewayDatabase: gatewayDb,
    enrollments,
    links,
    vaultFor: (vaultId) =>
      vaultId === WORK ? work : vaultId === PERSONAL ? personal : undefined,
  });
  return {
    gatewayDb,
    links,
    work,
    personal,
    laptop: laptop.endpointId,
    phone: phone.endpointId,
    handler,
  };
}

async function call(
  house: Household,
  input: {
    method: "GET" | "POST";
    deviceId: string;
    body?: Record<string, unknown>;
  }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Readable.from([
    Buffer.from(JSON.stringify(input.body ?? {})),
  ]) as IncomingMessage;
  req.method = input.method;
  req.url = "/centraid/_gateway/edges";
  req.headers = { [AUTHED_DEVICE_HEADER]: input.deviceId };
  let status = 0;
  let raw = "";
  const res = {
    setHeader: () => undefined,
    end(value?: string | Buffer) {
      if (value) raw += value.toString();
    },
    get statusCode() {
      return status;
    },
    set statusCode(value: number) {
      status = value;
    },
  } as unknown as ServerResponse;
  await house.handler(req, res);
  return { status, body: raw ? JSON.parse(raw) : {} };
}

/** One content item, the smallest thing an edge can carry. */
function seedNote(vault: VaultDb, title: string): string {
  const contentId = `content-${title}`;
  const now = new Date().toISOString();
  const blob = vault.blobs.ingestSync(Buffer.from(`bytes-of-${title}`));
  vault.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language,
          creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, 'text/plain', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`
    )
    .run(
      contentId,
      blobUriFor(blob.sha256),
      blob.sha256,
      blob.byteSize,
      title,
      now
    );
  return contentId;
}

function give(
  house: Household,
  deviceId: string,
  edgeId: string,
  itemIds: string[]
): Promise<{ status: number; body: Record<string, unknown> }> {
  return call(house, {
    method: "POST",
    deviceId,
    body: {
      edgeId,
      originVaultId: WORK,
      audienceVaultId: PERSONAL,
      mode: "snapshot",
      kind: "add",
      itemType: "core.content_item",
      itemIds,
      verbs: "read",
    },
  });
}

function noteCount(vault: VaultDb): number {
  return (
    vault.vault
      .prepare("SELECT count(*) AS n FROM core_content_item")
      .get() as { n: number }
  ).n;
}

describe("POST/GET /centraid/_gateway/edges", () => {
  test("a give completes over the local transport and answers its receipt", async () => {
    const house = household();
    const noteId = seedNote(house.work, "one");
    const answer = await give(house, house.laptop, "edge-local", [noteId]);
    expect(answer.status).toBe(200);
    expect(answer.body.status).toBe("completed");
    expect(answer.body.accessReceiptId).toBeTypeOf("string");
    expect(answer.body.createdByDevice).toBe(house.laptop);
    expect(noteCount(house.personal)).toBe(1);
  });

  test("every device of one owner sees the same edges (#750)", async () => {
    const house = household();
    const noteId = seedNote(house.work, "shared-history");
    await give(house, house.laptop, "edge-from-laptop", [noteId]);

    const fromPhone = await call(house, {
      method: "GET",
      deviceId: house.phone,
    });
    const edges = fromPhone.body.edges as Array<Record<string, unknown>>;
    expect(edges.map((edge) => edge.edgeId)).toStrictEqual([
      "edge-from-laptop",
    ]);
    // Provenance survives the widening: the list says WHICH device acted.
    expect(edges[0]!.createdByDevice).toBe(house.laptop);
    const fromLaptop = await call(house, {
      method: "GET",
      deviceId: house.laptop,
    });
    expect(fromLaptop.body).toStrictEqual(fromPhone.body);
  });

  test("replaying the same edge projects once, receipts once, and needs no second effect", async () => {
    const house = household();
    const noteId = seedNote(house.work, "replay");
    const first = await give(house, house.laptop, "edge-replay", [noteId]);
    const again = await give(house, house.phone, "edge-replay", [noteId]);
    // A replay from ANOTHER of the owner's devices is still the same edge…
    expect(again.status).toBe(409);
    const third = await give(house, house.laptop, "edge-replay", [noteId]);
    expect(third.body.accessReceiptId).toBe(first.body.accessReceiptId);
    expect(noteCount(house.personal)).toBe(1);
    expect(
      (
        house.gatewayDb.db
          .prepare("SELECT count(*) AS n FROM share_access_receipts")
          .get() as { n: number }
      ).n
    ).toBe(1);
    // The outbox holds ONE obligation for this edge, and it is discharged.
    expect(
      (
        house.gatewayDb.db
          .prepare("SELECT effect_id, status FROM share_effects")
          .all() as Array<{ effect_id: string; status: string }>
      ).map((row) => `${row.effect_id}:${row.status}`)
    ).toStrictEqual(["give:edge-replay:done"]);
  });

  test("a give this gateway cannot act on parks with a live obligation", async () => {
    const house = household();
    const noteId = seedNote(house.work, "fails");
    const failing = makeEdgesRouteHandler({
      gatewayDatabase: house.gatewayDb,
      enrollments: EnrollmentStore.open(house.gatewayDb),
      links: house.links,
      vaultFor: (vaultId) =>
        vaultId === WORK
          ? house.work
          : vaultId === PERSONAL
            ? house.personal
            : undefined,
      share: () => {
        throw new Error("the audience vault is read-only right now");
      },
    });
    const answer = await call(
      { ...house, handler: failing },
      {
        method: "POST",
        deviceId: house.laptop,
        body: {
          edgeId: "edge-parked",
          originVaultId: WORK,
          audienceVaultId: PERSONAL,
          mode: "snapshot",
          kind: "add",
          itemType: "core.content_item",
          itemIds: [noteId],
          verbs: "read",
        },
      }
    );
    // 202: this gateway could not act — a state about US, not about a peer.
    expect(answer.status).toBe(202);
    expect(answer.body.status).toBe("parked");
    expect(answer.body.reason).toBe(
      "the audience vault is read-only right now"
    );
    expect(noteCount(house.personal)).toBe(0);
    // The obligation outlives the attempt: still queued, ready to retry.
    const queued = listQueuedEffects(house.gatewayDb, "deliver-give");
    expect(queued.map((row) => row.effectId)).toStrictEqual([
      "give:edge-parked",
    ]);

    // A later attempt with a working vault completes the SAME edge.
    const retried = await give(house, house.laptop, "edge-parked", [noteId]);
    expect(retried.body.status).toBe("completed");
    expect(readEdgeRow(house.gatewayDb, "edge-parked")!.status).toBe(
      "completed"
    );
    expect(listQueuedEffects(house.gatewayDb, "deliver-give")).toHaveLength(0);
  });

  test("a malformed scope is refused at the wire door, loudly", async () => {
    const house = household();
    const answer = await give(house, house.laptop, "edge-bad", []);
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe("invalid_edge");
  });
});
