/*
 * The grant plane's owner surface, end to end (#825): a share is said as a
 * sentence and kept in the same gesture, read back audience-first and
 * subject-first, and ended by one revoke that carries the removal out.
 *
 * What this pins that the store's unit tests cannot: the wire keeps ABSENT
 * apart from EMPTY on every read — a person this vault has never reached
 * carries `channel: null` beside `grants: []`, and a grant nobody can see is
 * `not_found` rather than an empty answer — and a subject the vault has no
 * fulfillment strategy for is refused at the door with copy that says what it
 * COULD do instead.
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
  nowIso,
  openVaultDb,
  uuidv7,
} from "@centraid/vault";
import type { BootstrapResult, VaultDb } from "@centraid/vault";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { makeGrantRouteHandler } from "./grant-routes.js";

const ORIGIN = "vlt_priya";
const AUDIENCE = "vlt_ravi";

interface Side {
  vault: VaultDb;
  boot: BootstrapResult;
}

interface World {
  priya: Side;
  ravi: Side;
  raviParty: string;
  documentId: string;
  laptop: string;
  /** What this host has mounted — mutable, so a test can take a peer away. */
  mounted: Map<string, VaultDb>;
  handler: ReturnType<typeof makeGrantRouteHandler>;
}

function openSide(root: string, name: string, vaultId: string): Side {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const vault = openVaultDb({ dir });
  return { vault, boot: bootstrapVault(vault, { ownerName: name, vaultId }) };
}

/** One document — the smallest whole subject a grant can carry. */
function seedDocument(side: Side, title: string): string {
  const now = nowIso();
  const blob = side.vault.blobs.ingestSync(Buffer.from(`bytes-of-${title}`));
  const contentId = uuidv7();
  side.vault.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language,
          creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, 'text/plain', ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?)`
    )
    .run(
      contentId,
      blobUriFor(blob.sha256),
      blob.sha256,
      blob.byteSize,
      title,
      side.boot.ownerPartyId,
      side.boot.deviceId,
      now
    );
  const documentId = uuidv7();
  side.vault.vault
    .prepare(
      `INSERT INTO core_document
         (document_id, title, current_content_id, created_at, updated_at,
          deleted_at, purge_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`
    )
    .run(documentId, title, contentId, now, now);
  return documentId;
}

/** Priya, her laptop, her document, and Ravi's vault co-hosted and linked. */
function world(options: { linked?: boolean } = {}): World {
  const root = tempDirSync("centraid-grant-route-");
  const gatewayDb = GatewayDatabase.open(path.join(root, "gateway"));
  const enrollments = EnrollmentStore.open(gatewayDb);
  const laptop = enrollments.enroll({
    endpointId: "device-laptop",
    vaultIds: [ORIGIN],
    label: "laptop",
    ownerLabel: "Priya",
  });
  const priya = openSide(root, "priya", ORIGIN);
  const ravi = openSide(root, "ravi", AUDIENCE);
  const now = nowIso();
  const raviParty = uuidv7();
  priya.vault.vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, created_at, updated_at,
          ontology_version)
       VALUES (?, 'person', 'Ravi', 'Ravi', ?, ?, '1.4')`
    )
    .run(raviParty, now, now);
  if (options.linked !== false)
    priya.vault.vault
      .prepare(
        `INSERT INTO share_party_vault_binding
           (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
         VALUES (?, ?, ?, NULL, ?, NULL)`
      )
      .run(uuidv7(), raviParty, AUDIENCE, now);
  const mounted = new Map<string, VaultDb>([
    [ORIGIN, priya.vault],
    [AUDIENCE, ravi.vault],
  ]);
  return {
    priya,
    ravi,
    raviParty,
    documentId: seedDocument(priya, "Trip plan"),
    laptop: laptop.endpointId,
    mounted,
    handler: makeGrantRouteHandler({
      enrollments,
      currentVault: () => ({
        vaultId: ORIGIN,
        db: priya.vault,
        ownerPartyId: priya.boot.ownerPartyId,
      }),
      host: { vaultFor: (vaultId) => mounted.get(vaultId) },
    }),
  };
}

async function call(
  house: World,
  input: {
    method: "GET" | "POST";
    url: string;
    deviceId?: string;
    body?: Record<string, unknown>;
  }
): Promise<{
  handled: boolean;
  status: number;
  body: Record<string, unknown>;
}> {
  const req = Readable.from([
    Buffer.from(JSON.stringify(input.body ?? {})),
  ]) as IncomingMessage;
  req.method = input.method;
  req.url = input.url;
  req.headers =
    input.deviceId === undefined
      ? {}
      : { [AUTHED_DEVICE_HEADER]: input.deviceId };
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
  const handled = await house.handler(req, res);
  return { handled, status, body: raw ? JSON.parse(raw) : {} };
}

function audienceTitles(side: Side): string[] {
  return (
    side.vault.vault
      .prepare("SELECT title FROM core_document ORDER BY title")
      .all() as { title: string }[]
  ).map((row) => row.title);
}

describe("routes/grants", () => {
  test("a share is said and kept in one gesture, then read from both sides", async () => {
    const house = world();
    const created = await call(house, {
      method: "POST",
      url: "/centraid/_vault/grants",
      deviceId: house.laptop,
      body: {
        audienceKind: "party",
        audienceId: house.raviParty,
        subjectType: "core.document",
        subjectId: house.documentId,
        capability: "view",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      outcome: "created",
      fulfillmentPass: { origin: "mounted" },
    });
    const grant = created.body.grant as Record<string, unknown>;
    expect(grant).toMatchObject({
      subjectType: "core.document",
      capability: "view",
      revokedAt: null,
      fulfillment: [{ peerVaultId: AUDIENCE, state: "delivered" }],
    });
    expect(audienceTitles(house.ravi)).toStrictEqual(["Trip plan"]);

    // Audience-first: everything Ravi can reach, in one query, with the
    // channel it would be delivered over.
    const reach = await call(house, {
      method: "GET",
      url: `/centraid/_vault/grants?partyId=${house.raviParty}`,
      deviceId: house.laptop,
    });
    expect(reach.status).toBe(200);
    expect(reach.body).toMatchObject({
      channel: { state: "live", vaultId: AUDIENCE },
    });
    expect(reach.body.grants as unknown[]).toHaveLength(1);

    // Subject-first: the object side of the same fact.
    const sheet = await call(house, {
      method: "GET",
      url: `/centraid/_vault/grants?subjectType=core.document&subjectId=${house.documentId}`,
      deviceId: house.laptop,
    });
    expect((sheet.body.grants as Record<string, unknown>[])[0]).toMatchObject({
      grantId: grant.grantId,
    });

    // Saying it twice does not mint a rival grant.
    const again = await call(house, {
      method: "POST",
      url: "/centraid/_vault/grants",
      deviceId: house.laptop,
      body: {
        audienceKind: "party",
        audienceId: house.raviParty,
        subjectType: "core.document",
        subjectId: house.documentId,
        capability: "view",
      },
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ outcome: "exists" });

    const revoked = await call(house, {
      method: "POST",
      url: `/centraid/_vault/grants/${grant.grantId as string}/revoke`,
      deviceId: house.laptop,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ outcome: "revoked" });
    // The sentence is DERIVED: this copy really was delivered and really was
    // taken back, so the owner is told exactly that and nothing softer.
    expect(revoked.body.message).toBe(
      "no longer shared; every copy it delivered has been removed"
    );
    expect(audienceTitles(house.ravi)).toStrictEqual([]);
    const after = await call(house, {
      method: "GET",
      url: `/centraid/_vault/grants/${grant.grantId as string}`,
      deviceId: house.laptop,
    });
    expect(after.body.grant).toMatchObject({
      fulfillment: [{ peerVaultId: AUDIENCE, state: "removed" }],
    });

    // A revoked grant leaves the live answer and stays in the history one:
    // `includeRevoked=1` is the difference between "what stands" and "what
    // was ever decided", and the two must not be the same read.
    const live = await call(house, {
      method: "GET",
      url: `/centraid/_vault/grants?audienceKind=party&audienceId=${house.raviParty}`,
      deviceId: house.laptop,
    });
    expect(live.body.grants).toStrictEqual([]);
    const history = await call(house, {
      method: "GET",
      url: `/centraid/_vault/grants?audienceKind=party&audienceId=${house.raviParty}&includeRevoked=1`,
      deviceId: house.laptop,
    });
    const past = history.body.grants as Record<string, unknown>[];
    expect(past).toHaveLength(1);
    expect(past[0]).toMatchObject({ grantId: grant.grantId });
    expect(past[0]!.revokedAt).toBeTypeOf("string");
  });

  test("revoking says which of the three removals actually happened", async () => {
    // (1) Nothing was ever delivered — an audience with no channel parks at
    // an invitation and holds no copy. The sentence must not imply a peer was
    // asked to delete something it never had.
    const parked = world({ linked: false });
    const never = await call(parked, {
      method: "POST",
      url: "/centraid/_vault/grants",
      deviceId: parked.laptop,
      body: {
        audienceKind: "party",
        audienceId: parked.raviParty,
        subjectType: "core.document",
        subjectId: parked.documentId,
        capability: "view",
      },
    });
    expect(never.status).toBe(201);
    const undelivered = await call(parked, {
      method: "POST",
      url: `/centraid/_vault/grants/${(never.body.grant as Record<string, unknown>).grantId as string}/revoke`,
      deviceId: parked.laptop,
    });
    expect(undelivered.body.message).toBe(
      "no longer shared; no delivered copy remains — nothing needed removing"
    );

    // (2) Delivered, then the audience vault is not mounted here any more.
    // The removal was sent and nobody confirmed it — the owner is told so
    // rather than being promised a deletion this host cannot witness.
    const house = world();
    const created = await call(house, {
      method: "POST",
      url: "/centraid/_vault/grants",
      deviceId: house.laptop,
      body: {
        audienceKind: "party",
        audienceId: house.raviParty,
        subjectType: "core.document",
        subjectId: house.documentId,
        capability: "view",
      },
    });
    const grantId = (created.body.grant as Record<string, unknown>)
      .grantId as string;
    expect(audienceTitles(house.ravi)).toStrictEqual(["Trip plan"]);
    house.mounted.delete(AUDIENCE);
    const unconfirmed = await call(house, {
      method: "POST",
      url: `/centraid/_vault/grants/${grantId}/revoke`,
      deviceId: house.laptop,
    });
    expect(unconfirmed.body.message).toBe(
      "no longer shared; a vault holding a copy has been asked to remove it and has not yet confirmed"
    );
    // Honest to the end: the peer still holds it, and the row says so.
    expect(audienceTitles(house.ravi)).toStrictEqual(["Trip plan"]);
    expect(unconfirmed.body.grant).toMatchObject({
      fulfillment: [{ peerVaultId: AUDIENCE, state: "remove_sent" }],
    });
  });

  test("a subject with no fulfillment strategy is refused, with what it can do instead", async () => {
    const house = world();
    const secret = await call(house, {
      method: "POST",
      url: "/centraid/_vault/grants",
      deviceId: house.laptop,
      body: {
        audienceKind: "party",
        audienceId: house.raviParty,
        subjectType: "locker.item",
        subjectId: uuidv7(),
        capability: "view",
      },
    });
    expect(secret.status).toBe(400);
    expect(secret.body.error).toBe("subject_not_offerable");
    expect(secret.body.message).toContain("locker.item");

    // Offerable for view, not for edit: the refusal says which is which.
    const edit = await call(house, {
      method: "POST",
      url: "/centraid/_vault/grants",
      deviceId: house.laptop,
      body: {
        audienceKind: "party",
        audienceId: house.raviParty,
        subjectType: "media.asset",
        subjectId: uuidv7(),
        capability: "edit",
      },
    });
    expect(edit.status).toBe(400);
    expect(edit.body).toMatchObject({ error: "capability_not_offerable" });
    expect(edit.body.message).toContain("view");
  });

  test("absent never arrives dressed as empty", async () => {
    const house = world({ linked: false });
    const unreached = await call(house, {
      method: "GET",
      url: `/centraid/_vault/grants?partyId=${house.raviParty}`,
      deviceId: house.laptop,
    });
    // Never reached is `null`; nothing shared is `[]`. Two facts, two shapes.
    expect(unreached.body.channel).toBeNull();
    expect(unreached.body.grants).toStrictEqual([]);

    const unknown = await call(house, {
      method: "GET",
      url: `/centraid/_vault/grants/${uuidv7()}`,
      deviceId: house.laptop,
    });
    expect(unknown.status).toBe(404);

    const unasked = await call(house, {
      method: "GET",
      url: "/centraid/_vault/grants",
      deviceId: house.laptop,
    });
    expect(unasked.status).toBe(400);
    expect(unasked.body.error).toBe("query_required");

    // A stranger's id must not borrow "nothing is shared with them": this
    // vault has never heard of them, which is its own answer.
    const strangers = await Promise.all(
      [
        `/centraid/_vault/grants?partyId=${uuidv7()}`,
        `/centraid/_vault/grants?audienceKind=party&audienceId=${uuidv7()}`,
        `/centraid/_vault/grants?audienceKind=circle&audienceId=${uuidv7()}`,
      ].map((url) =>
        call(house, { method: "GET", url, deviceId: house.laptop })
      )
    );
    for (const stranger of strangers) {
      expect(stranger.status).toBe(404);
      expect(stranger.body.error).toBe("audience_not_found");
    }
    // …and a party this vault DOES know, with nothing shared, still answers
    // the empty list. Two facts, two answers.
    const known = await call(house, {
      method: "GET",
      url: `/centraid/_vault/grants?audienceKind=party&audienceId=${house.raviParty}`,
      deviceId: house.laptop,
    });
    expect(known.status).toBe(200);
    expect(known.body.grants).toStrictEqual([]);
  });

  test("the offerable registry is readable, and a caller without a device is not", async () => {
    const house = world();
    const subjects = await call(house, {
      method: "GET",
      url: "/centraid/_vault/grants/subjects",
      deviceId: house.laptop,
    });
    expect(subjects.status).toBe(200);
    expect(subjects.body.subjects).toContainEqual({
      subjectType: "tally.group",
      capabilities: ["view", "edit"],
      fulfillment: { view: "closure-reprojection", edit: "commons-routing" },
    });

    const anonymous = await call(house, {
      method: "GET",
      url: "/centraid/_vault/grants/subjects",
    });
    expect(anonymous.status).toBe(403);

    // Paths outside the plane are claimed by nobody here.
    const elsewhere = await call(house, {
      method: "GET",
      url: "/centraid/_vault/status",
      deviceId: house.laptop,
    });
    expect(elsewhere.handled).toBe(false);
  });
});
