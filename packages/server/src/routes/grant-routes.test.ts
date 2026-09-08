/*
 * The grant plane's owner surface, end to end (#825). What this pins that the
 * store's unit tests cannot: the wire keeps ABSENT apart from EMPTY on every
 * read, and a subject with no fulfillment strategy is refused at the door with
 * copy naming what the vault COULD do instead.
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
  createGateway,
  nowIso,
  openVaultDb,
  registerShareCommands,
  uuidv7,
} from "@centraid/vault";
import type { BootstrapResult, VaultDb } from "@centraid/vault";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { createGrantRefreshDoorbell } from "../serve/grant-fulfillment.js";
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
         (party_id, kind, display_name, sort_name, created_at, updated_at)
       VALUES (?, 'person', 'Ravi', 'Ravi', ?, ?)`
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
  // `build-gateway.ts`'s wiring in miniature (V-writer, V-delivery): the pack
  // is the only writer and delivery hangs off the post-commit doorbell, so
  // this file exercises the real path.
  const host = { vaultFor: (vaultId: string) => mounted.get(vaultId) };
  const doorbell = createGrantRefreshDoorbell({ host, windowMs: 0 });
  const gateway = createGateway(priya.vault, {
    onProvenanceCommitted: (entityTypes) =>
      doorbell.ring(ORIGIN, entityTypes ?? []),
  });
  registerShareCommands(gateway);
  const ownerCredential = {
    kind: "device" as const,
    deviceId: priya.boot.deviceId,
    deviceKey: priya.boot.deviceKey,
  };
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
        invoke: async (command, input) =>
          gateway.invoke(ownerCredential, {
            command,
            input,
          }),
      }),
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
    // No `fulfillmentPass`: the route does not deliver (V-delivery). The share
    // is HERE by the time the response is written — the write's own doorbell
    // carried it — and says so in the ruled vocabulary (V-phrases).
    expect(created.body).toMatchObject({ outcome: "created" });
    expect(created.body.fulfillmentPass).toBeUndefined();
    const grant = created.body.grant as Record<string, unknown>;
    expect(grant).toMatchObject({
      subjectType: "core.document",
      capability: "view",
      revokedAt: null,
      fulfillment: [{ peerVaultId: AUDIENCE, state: "delivered" }],
      phrase: "shared",
      reason: "the vault it addresses is holding it",
    });
    expect(audienceTitles(house.ravi)).toStrictEqual(["Trip plan"]);

    // Audience-first: all Ravi can reach, with the channel it arrives over.
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
    // The sentence is DERIVED: delivered, then taken back, so the owner hears
    // exactly that. "No longer shared" is the PHRASE (V-phrases), so the
    // message carries only the reason.
    expect(revoked.body).toMatchObject({
      grant: { phrase: "withdrawn", confirmed: true },
      message: "every copy it delivered has been removed",
    });
    expect(audienceTitles(house.ravi)).toStrictEqual([]);
    const after = await call(house, {
      method: "GET",
      url: `/centraid/_vault/grants/${grant.grantId as string}`,
      deviceId: house.laptop,
    });
    expect(after.body.grant).toMatchObject({
      fulfillment: [{ peerVaultId: AUDIENCE, state: "removed" }],
    });

    // `includeRevoked=1` separates "what stands" from "what was ever decided";
    // the two must not be one read.
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
    // (1) Never delivered: the audience is linked — since #903 nothing else
    // can be granted — but their vault is not mounted here, so the grant is
    // made and never carried. The sentence must not imply a peer was asked to
    // delete anything.
    const parked = world();
    parked.mounted.delete(AUDIENCE);
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
    // V-phrases: `withdrawn` settles CONFIRMED only because nothing was
    // delivered — no peer had anything to acknowledge.
    expect(undelivered.body).toMatchObject({
      grant: { phrase: "withdrawn", confirmed: true },
      message: "no copy had been delivered — there was nothing to remove",
    });
    // Per LOCUS (V-locus): a person's copy lives in THEIR vault, so the honest
    // promise names it.
    expect(undelivered.body.promise).toBe(
      "their vault is asked to remove its copy; it is no longer shared either way"
    );

    // (2) Delivered, then the audience vault left this host: the removal was
    // sent and unconfirmed, and the owner hears that rather than a promise
    // this host cannot witness.
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
    // Asked, NOT confirmed — the copy may not be called removed until the peer
    // says it is (V-phrases).
    expect(unconfirmed.body.message).toBe(
      "removal sent to vlt_ravi; the peer has not acknowledged it"
    );
    expect(unconfirmed.body.grant).toMatchObject({
      phrase: "withdrawn",
      confirmed: false,
    });
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

    // A stranger's id must not borrow "nothing is shared with them".
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
    // …and a known party with nothing shared still answers the empty list.
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
      fulfillment: { view: "closure-reprojection", edit: "replica-intent" },
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
