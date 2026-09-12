/*
 * SAME-OWNER PLACEMENT, end to end (#726 P2, reduced to one call by #928 A7):
 * both vaults are open in this process, so the route places synchronously and
 * the durable history is the access receipt.
 *
 * This file also owns `[law:share-receipt-authority]` — the durable
 * cross-vault ACCESS AUDIT, which is what an owner is shown when they ask
 * "what left this vault, to whom?". Its worth is entirely in the two
 * directions being true at once: a receipt for every placement whose rows
 * actually landed, and NO receipt for one that was refused. A receipt for a
 * placement nobody made is a false accusation; one missing for a placement
 * that landed is exactly the silence the audit exists to prevent. It moved
 * here from `share-edge-store.ts` with the door it guarded.
 */

import { mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import { tempDirSync } from "@centraid/test-kit/temp-dir";
import {
  blobUriFor,
  bootstrapVault,
  openVaultDb,
  placeItemsInVault,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { VaultLinksStore } from "../serve/vault-links-store.js";
import { makePlacementRouteHandler } from "./placement-routes.js";

function receiptCount(db: GatewayDatabase): number {
  return (
    db.db.prepare("SELECT count(*) AS n FROM share_access_receipts").get() as {
      n: number;
    }
  ).n;
}

interface Household {
  gatewayDb: GatewayDatabase;
  links: VaultLinksStore;
  work: VaultDb;
  personal: VaultDb;
  neighbour: VaultDb;
  laptop: string;
  phone: string;
  handler: ReturnType<typeof makePlacementRouteHandler>;
}

const WORK = "vlt_work";
const PERSONAL = "vlt_personal";
/** Another person's vault, co-hosted here and linked to Ada's. */
const NEIGHBOUR = "vlt_neighbour";

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
  // A second PERSON on the same box: their own owner, their own vault. This
  // is the pair `cross_owner_give_retired` exists for.
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
  const handler = makePlacementRouteHandler({
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

/** Both owners approve the WORK ↔ NEIGHBOUR link — an APPROVED cross-owner
 *  pair, so the refusal below is a ruling and not a missing permission. */
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

/** One content item, the smallest thing an edge can carry. */
function seedNote(vault: VaultDb, title: string): string {
  const contentId = `content-${title}`;
  const now = new Date().toISOString();
  const blob = vault.blobs.ingestSync(Buffer.from(`bytes-of-${title}`));
  vault.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, content_uri, sha256, byte_size, language,
          creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`
    )
    .run(contentId, blobUriFor(blob.sha256), blob.sha256, blob.byteSize, now);
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

describe("[law:share-receipt-authority] POST/GET /centraid/_gateway/edges", () => {
  test("[law:share-receipt-authority] a placement completes in one call and answers its receipt", async () => {
    const house = household();
    const noteId = seedNote(house.work, "one");
    const answer = await give(house, house.laptop, "edge-local", [noteId]);
    expect(answer.status).toBe(200);
    expect(answer.body.status).toBe("completed");
    expect(answer.body.accessReceiptId).toBeTypeOf("string");
    expect(answer.body.createdByDevice).toBe(house.laptop);
    expect(noteCount(house.personal)).toBe(1);
  });

  test("every device of one owner sees the same placements (#750)", async () => {
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

  test("[law:share-receipt-authority] a replayed placement token projects once and receipts once", async () => {
    const house = household();
    const noteId = seedNote(house.work, "replay");
    const first = await give(house, house.laptop, "edge-replay", [noteId]);
    // A replay from ANOTHER of the owner's devices is still the same
    // placement, and answers the recorded one rather than placing again.
    const again = await give(house, house.phone, "edge-replay", [noteId]);
    expect(again.status).toBe(200);
    expect(again.body.accessReceiptId).toBe(first.body.accessReceiptId);
    expect(noteCount(house.personal)).toBe(1);
    expect(receiptCount(house.gatewayDb)).toBe(1);
  });

  test("[law:share-receipt-authority] a placement this gateway could not perform leaves no receipt", async () => {
    const house = household();
    const noteId = seedNote(house.work, "fails");
    const failing = makePlacementRouteHandler({
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
      place: () => {
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
    expect(answer.status).toBe(502);
    expect(answer.body.error).toBe("placement_failed");
    expect(noteCount(house.personal)).toBe(0);
    // NOTHING landed, so nothing is audited — and the token is still free.
    expect(receiptCount(house.gatewayDb)).toBe(0);

    // A later attempt with a working vault completes the SAME placement.
    const retried = await give(house, house.laptop, "edge-parked", [noteId]);
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe("completed");
    expect(receiptCount(house.gatewayDb)).toBe(1);
  });

  test("[law:share-receipt-authority] a vault this gateway has not opened is a retryable 503, not a placement", async () => {
    const house = household();
    const noteId = seedNote(house.work, "unopened");
    const closed = makePlacementRouteHandler({
      gatewayDatabase: house.gatewayDb,
      enrollments: EnrollmentStore.open(house.gatewayDb),
      links: house.links,
      vaultFor: (vaultId) => (vaultId === WORK ? house.work : undefined),
      partyIdFor: () => "edge-party",
    });
    const answer = await call(
      { ...house, handler: closed },
      {
        method: "POST",
        deviceId: house.laptop,
        body: {
          edgeId: "edge-closed",
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
    expect(answer.status).toBe(503);
    expect(answer.body.error).toBe("vault_not_open");
    expect(receiptCount(house.gatewayDb)).toBe(0);
  });

  test("[law:share-receipt-authority] a move places the album and releases the source in one call", async () => {
    const house = household();
    const noteId = seedNote(house.work, "moved");
    const moved = await call(house, {
      method: "POST",
      deviceId: house.laptop,
      body: {
        edgeId: "edge-move",
        originVaultId: WORK,
        audienceVaultId: PERSONAL,
        mode: "snapshot",
        kind: "move",
        itemType: "core.content_item",
        itemIds: [noteId],
        verbs: "read",
      },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.kind).toBe("move");
    expect(noteCount(house.personal)).toBe(1);
    expect(noteCount(house.work)).toBe(0);
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
    // Not `not_found`: the link is real and approved, so hiding the pair would
    // be a lie. The verb is not served, and the copy names the grant plane.
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("cross_owner_give_retired");
    expect(refused.body.message).toBe(
      "giving a copy to another person's vault has been replaced by sharing — grant them the album, folder or document instead"
    );
    // Refused at the door: no receipt, nothing in Bo's vault.
    expect(receiptCount(house.gatewayDb)).toBe(0);
    expect(noteCount(house.neighbour)).toBe(0);

    // The owner's own two vaults are untouched by the retirement.
    const placed = await give(house, house.laptop, "edge-own", [noteId]);
    expect(placed.status).toBe(200);
    expect(placed.body.status).toBe("completed");
    expect(noteCount(house.personal)).toBe(1);
  });

  test("[law:share-receipt-authority] a malformed scope is refused at the wire door, loudly, and audits nothing", async () => {
    const house = household();
    const answer = await give(house, house.laptop, "edge-bad", []);
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe("invalid_edge");
    expect(receiptCount(house.gatewayDb)).toBe(0);
  });
});

/*
 * A CRASH AT EVERY STEP, THEN THE RETRY (#1014, V3).
 *
 * A placement is three transactions over three databases — the origin's
 * authority, the audience's projection, and for a move the origin's release —
 * and the receipt is written after all three. So the interesting question is
 * not "does the happy path work" but "what does the phone's outbox find when
 * it retries the same token after a kill at each step".
 */
describe("a placement killed part-way (#1014, V3)", () => {
  /** Where the process dies. `place` is the whole vault half of the act. */
  type Kill = "before-place" | "after-place";

  function dying(house: Household, kill: Kill): Household["handler"] {
    const real = placeItemsInVault;
    return makePlacementRouteHandler({
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
      place: (input) => {
        if (kill === "before-place")
          throw new Error("killed before the vaults");
        // The vault work really happened; the receipt never got written.
        real(input);
        throw new Error("killed after the vaults, before the receipt");
      },
    });
  }

  function attemptCount(db: GatewayDatabase): number {
    return (
      db.db
        .prepare("SELECT count(*) AS n FROM share_placement_attempts")
        .get() as { n: number }
    ).n;
  }

  test("resumes to exactly one audience row and one receipt", async () => {
    const house = household();
    const noteId = seedNote(house.work, "resumed");

    // Killed AFTER the vaults: the item is in the audience and the gateway has
    // no receipt. Before #1014 nothing on the gateway recorded that this
    // placement had begun at all.
    const first = await call(
      { ...house, handler: dying(house, "after-place") },
      {
        method: "POST",
        deviceId: house.laptop,
        body: {
          edgeId: "edge-crash",
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
    expect(first.status).toBe(502);
    expect(noteCount(house.personal)).toBe(1);
    expect(receiptCount(house.gatewayDb)).toBe(0);
    // The unfinished act is visible instead of silent.
    expect(attemptCount(house.gatewayDb)).toBe(1);

    // The outbox retries the same token. Each vault step is idempotent by id,
    // so the resume converges rather than placing a second copy.
    const retried = await give(house, house.laptop, "edge-crash", [noteId]);
    expect(retried.status).toBe(200);
    expect(noteCount(house.personal)).toBe(1);
    expect(receiptCount(house.gatewayDb)).toBe(1);
    // And the attempt is superseded by the receipt.
    expect(attemptCount(house.gatewayDb)).toBe(0);
  });

  test("a move killed after the vaults leaves the item in one vault, not both", async () => {
    const house = household();
    const noteId = seedNote(house.work, "moved-crash");
    const body = {
      edgeId: "edge-move-crash",
      originVaultId: WORK,
      audienceVaultId: PERSONAL,
      mode: "snapshot",
      kind: "move",
      itemType: "core.content_item",
      itemIds: [noteId],
      verbs: "read",
    };
    const killed = await call(
      { ...house, handler: dying(house, "after-place") },
      { method: "POST", deviceId: house.laptop, body }
    );
    expect(killed.status).toBe(502);

    const retried = await call(house, {
      method: "POST",
      deviceId: house.laptop,
      body,
    });
    expect(retried.status).toBe(200);
    expect(noteCount(house.personal)).toBe(1);
    expect(noteCount(house.work)).toBe(0);
    expect(receiptCount(house.gatewayDb)).toBe(1);
  });

  test("a move killed after the receipt still releases the origin on retry", async () => {
    const house = household();
    const noteId = seedNote(house.work, "release-crash");
    const body = {
      edgeId: "edge-release-crash",
      originVaultId: WORK,
      audienceVaultId: PERSONAL,
      mode: "snapshot",
      kind: "move",
      itemType: "core.content_item",
      itemIds: [noteId],
      verbs: "read",
    };
    const noRelease = makePlacementRouteHandler({
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
      release: () => {
        throw new Error("killed after the receipt, before the release");
      },
    });
    const killed = await call(
      { ...house, handler: noRelease },
      { method: "POST", deviceId: house.laptop, body }
    );
    expect(killed.status).toBe(502);
    // The window this ORDER chooses: in both vaults, receipted, recoverable.
    expect(noteCount(house.personal)).toBe(1);
    expect(noteCount(house.work)).toBe(1);
    expect(receiptCount(house.gatewayDb)).toBe(1);
    expect(attemptCount(house.gatewayDb)).toBe(1);

    // The retry must NOT short-circuit on the receipt: nothing else ever
    // revisits a receipted placement, so the item would sit in both forever.
    const retried = await call(house, {
      method: "POST",
      deviceId: house.laptop,
      body,
    });
    expect(retried.status).toBe(200);
    expect(noteCount(house.personal)).toBe(1);
    expect(noteCount(house.work)).toBe(0);
    expect(receiptCount(house.gatewayDb)).toBe(1);
    expect(attemptCount(house.gatewayDb)).toBe(0);
  });

  test("refuses a token re-addressed to a different placement", async () => {
    const house = household();
    const first = seedNote(house.work, "first");
    const second = seedNote(house.work, "second");
    await call(
      { ...house, handler: dying(house, "before-place") },
      {
        method: "POST",
        deviceId: house.laptop,
        body: {
          edgeId: "edge-reused",
          originVaultId: WORK,
          audienceVaultId: PERSONAL,
          mode: "snapshot",
          kind: "add",
          itemType: "core.content_item",
          itemIds: [first],
          verbs: "read",
        },
      }
    );
    // ONE TOKEN IS ONE ACT: a retry that re-addresses a placement in flight
    // would place items nobody asked for under a token the caller believes
    // settled.
    const reused = await give(house, house.laptop, "edge-reused", [second]);
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("placement_id_reused");
    expect(noteCount(house.personal)).toBe(0);
  });
});
