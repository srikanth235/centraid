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
import { VaultLinksStore } from "../serve/vault-links-store.js";
import { makeEdgesRouteHandler } from "./edges-routes.js";

function queuedEffectIds(db: GatewayDatabase): string[] {
  return (
    db.db
      .prepare(
        "SELECT effect_id FROM share_effects WHERE status = 'queued' ORDER BY created_at"
      )
      .all() as unknown as { effect_id: string }[]
  ).map((row) => row.effect_id);
}

interface Household {
  gatewayDb: GatewayDatabase;
  links: VaultLinksStore;
  work: VaultDb;
  personal: VaultDb;
  neighbour: VaultDb;
  laptop: string;
  phone: string;
  handler: ReturnType<typeof makeEdgesRouteHandler>;
}

const WORK = "vlt_work";
const PERSONAL = "vlt_personal";
const NEIGHBOUR = "vlt_neighbour";

function openVault(root: string, name: string, vaultId: string): VaultDb {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const vault = openVaultDb({ dir });
  bootstrapVault(vault, { ownerName: name, vaultId });
  return vault;
}

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
  enrollments.enroll({
    endpointId: "device-neighbour",
    vaultIds: [NEIGHBOUR],
    label: "neighbour-laptop",
    ownerLabel: "Bo",
  });
  const work = openVault(root, "work", WORK);
  const personal = openVault(root, "personal", PERSONAL);
  const neighbour = openVault(root, "neighbour", NEIGHBOUR);
  const links = VaultLinksStore.open(gatewayDb);
  const vaultFor = (vaultId: string): VaultDb | undefined =>
    vaultId === WORK
      ? work
      : vaultId === PERSONAL
        ? personal
        : vaultId === NEIGHBOUR
          ? neighbour
          : undefined;
  const handler = makeEdgesRouteHandler({
    gatewayDatabase: gatewayDb,
    enrollments,
    links,
    vaultFor,
    partyIdFor: () => "edge-party",
  });
  return {
    gatewayDb,
    links,
    work,
    personal,
    neighbour,
    laptop: laptop.endpointId,
    phone: phone.endpointId,
    handler,
  };
}

function linkNeighbour(house: Household): void {
  const link = house.links.propose({
    fromVaultId: WORK,
    fromPublicKey: "key-work",
    toVaultId: NEIGHBOUR,
    toPublicKey: "key-neighbour",
  });
  house.links.approve(link.linkId, NEIGHBOUR);
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
      partyIdFor: () => "edge-party",
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
    expect(answer.status).toBe(202);
    expect(answer.body.status).toBe("parked");
    expect(answer.body.reason).toBe(
      "the audience vault is read-only right now"
    );
    expect(noteCount(house.personal)).toBe(0);
    expect(queuedEffectIds(house.gatewayDb)).toStrictEqual([
      "give:edge-parked",
    ]);

    const retried = await give(house, house.laptop, "edge-parked", [noteId]);
    expect(retried.body.status).toBe("completed");
    expect(readEdgeRow(house.gatewayDb, "edge-parked")!.status).toBe(
      "completed"
    );
    expect(queuedEffectIds(house.gatewayDb)).toStrictEqual([]);
  });

  test("a cross-owner pair is refused as retired, while same-owner placement still lands (#825)", async () => {
    const house = household();
    linkNeighbour(house);
    const noteId = seedNote(house.work, "for-bo");
    const refused = await call(house, {
      method: "POST",
      deviceId: house.laptop,
      body: {
        edgeId: "edge-to-bo",
        originVaultId: WORK,
        audienceVaultId: NEIGHBOUR,
        mode: "snapshot",
        kind: "add",
        itemType: "core.content_item",
        itemIds: [noteId],
        verbs: "read",
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("cross_owner_give_retired");
    expect(refused.body.message).toBe(
      "giving a copy to another person's vault has been replaced by sharing — grant them the album, folder or document instead"
    );
    expect(readEdgeRow(house.gatewayDb, "edge-to-bo")).toBeUndefined();
    expect(queuedEffectIds(house.gatewayDb)).toStrictEqual([]);
    expect(noteCount(house.neighbour)).toBe(0);

    const placed = await give(house, house.laptop, "edge-own", [noteId]);
    expect(placed.status).toBe(200);
    expect(placed.body.status).toBe("completed");
    expect(noteCount(house.personal)).toBe(1);
  });

  test("a malformed scope is refused at the wire door, loudly", async () => {
    const house = household();
    const answer = await give(house, house.laptop, "edge-bad", []);
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe("invalid_edge");
  });
});
