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
    expect(revoked.body.message).toContain("no longer shared");
    expect(audienceTitles(house.ravi)).toStrictEqual([]);
    const after = await call(house, {
      method: "GET",
      url: `/centraid/_vault/grants/${grant.grantId as string}`,
      deviceId: house.laptop,
    });
    expect(after.body.grant).toMatchObject({
      fulfillment: [{ peerVaultId: AUDIENCE, state: "removed" }],
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
