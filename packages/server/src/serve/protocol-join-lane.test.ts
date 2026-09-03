/*
 * PROTOCOL JOIN LANE (#839): one `serve()` daemon, N mounted vaults, one iroh
 * client per seat, so every assertion travels the real transport. The laws
 * hold at every N (`CENTRAID_JOIN_SEATS` raises it nightly).
 *
 * ONE gateway with N vaults, never N gateways: a grant resolves its audience
 * through the host gateway's registry, and a cross-host grant parks at
 * `syncing` deliberately (docs/protocol.md).
 *
 * The skew test uses SYNTHETIC version integers because the window is a single
 * point, so no legal N−1 client exists to build (#842 W5.3).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  judgeGatewayInfo,
  protocolsCompatible,
  ROUTES,
} from "@centraid/core/protocol";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  createTunnelClient,
  startGatewayEndpoint,
  tunnelRequest,
} from "@centraid/tunnel";
import type {
  Connection,
  GatewayEndpointHandle,
  TunnelClient,
} from "@centraid/tunnel";
import { blobUriFor, nowIso, uuidv7 } from "@centraid/vault";

import { EnrollmentStore } from "./enrollment-store.ts";
import { GatewayDatabase } from "./gateway-db.ts";
import { PairingTicketStore } from "./pairing-store.ts";
import { serve } from "./serve.ts";
import type { GatewayServeHandle } from "./serve.ts";
import type { VaultPlane } from "./vault-plane.ts";

const LOOPBACK_SECRET = "join-lane-loopback-secret";
const DEVICE_HEADER = "x-test-device";
const VAULT_HEADER = "x-centraid-vault";
const PARKED_PATH = "/centraid/_vault/parked";

/** The floor the laws need: origin, addressed audience, bystander. */
const SEAT_COUNT = Math.max(3, Number(process.env.CENTRAID_JOIN_SEATS ?? 3));

interface Seat {
  readonly label: string;
  readonly vaultId: string;
  readonly plane: VaultPlane;
  /** The party row in the ORIGIN vault for this seat's owner. */
  partyId: string;
  client: TunnelClient;
  connection: Connection;
}

interface JoinWorld {
  handle: GatewayServeHandle;
  endpoint: GatewayEndpointHandle;
  enrollments: EnrollmentStore;
  seats: Seat[];
  origin: Seat;
}

const worlds: JoinWorld[] = [];
const dataDirs: string[] = [];

async function closeEverything(): Promise<void> {
  await Promise.all(
    worlds.splice(0).map(async (world) => {
      await Promise.all(
        world.seats.map((seat) => seat.client.close().catch(() => undefined))
      );
      await world.endpoint.close().catch(() => undefined);
      await world.handle.close().catch(() => undefined);
    })
  );
  await Promise.all(
    dataDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
}

async function joinWorld(): Promise<JoinWorld> {
  const dataDir = await tempDir("protocol-join-");
  dataDirs.push(dataDir);
  const database = GatewayDatabase.open(dataDir, { lock: "exclusive" });
  const enrollments = EnrollmentStore.open(database);
  const tickets = PairingTicketStore.open(database);
  const handle = await serve({
    paths: { dataDir, vaultDir: path.join(dataDir, "vault") },
    gatewayDatabase: database,
    token: LOOPBACK_SECRET,
    deviceAccess: {
      // The header the iroh forwarder stamps: a REAL QUIC-proved identity.
      deviceKeyFor: (req) => {
        const value = req.headers[DEVICE_HEADER];
        return typeof value === "string" ? value : undefined;
      },
      vaultsFor: (deviceKey) => enrollments.vaultsFor(deviceKey),
    },
    devicePairing: { enrollments, tickets },
  });
  const endpoint = await startGatewayEndpoint({
    upstream: () => ({ baseUrl: handle.url, token: LOOPBACK_SECRET }),
    authorize: (endpointId) => enrollments.isEnrolled(endpointId),
    pair: () => ({ ok: false, error: "not_used" }),
    requestHeaders: (endpointId) => ({ [DEVICE_HEADER]: endpointId }),
    relays: "disabled",
  });

  const vaultIds = [handle.vaults.defaultVaultId()];
  for (let index = 1; index < SEAT_COUNT; index += 1)
    vaultIds.push(handle.vaults.create(`Seat ${index}`).vaultId);

  const ticket = endpoint.ticket();
  const seats = await Promise.all(
    vaultIds.map(async (vaultId, index): Promise<Seat> => {
      const label = index === 0 ? "origin" : `seat-${index}`;
      const client = await createTunnelClient({ relays: "disabled" });
      // Each seat is its own OWNER. Enrolment precedes the dial: the
      // endpoint's `authorize` seam reads it.
      enrollments.enroll({
        endpointId: client.endpointId,
        vaultIds: [vaultId],
        label: `${label}-device`,
        ownerLabel: label,
      });
      const plane = handle.vaults.get(vaultId);
      if (!plane) throw new Error(`vault ${vaultId} is not mounted`);
      return {
        label,
        vaultId,
        plane,
        partyId: "",
        client,
        connection: await client.connect(ticket),
      };
    })
  );

  const world: JoinWorld = {
    handle,
    endpoint,
    enrollments,
    seats,
    origin: seats[0]!,
  };
  worlds.push(world);
  for (const seat of seats.slice(1)) seat.partyId = linkSeat(world, seat);
  return world;
}

function linkSeat(world: JoinWorld, seat: Seat): string {
  const now = nowIso();
  const partyId = uuidv7();
  const db = world.origin.plane.db.vault;
  db.prepare(
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, created_at, updated_at)
     VALUES (?, 'person', ?, ?, ?, ?)`
  ).run(partyId, seat.label, seat.label, now, now);
  db.prepare(
    `INSERT INTO share_party_vault_binding
       (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
     VALUES (?, ?, ?, NULL, ?, NULL)`
  ).run(uuidv7(), partyId, seat.vaultId, now);
  return partyId;
}

/** The smallest whole subject a grant carries. */
function seedDocument(world: JoinWorld, title: string): string {
  const db = world.origin.plane.db;
  const now = nowIso();
  const blob = db.blobs.ingestSync(Buffer.from(`bytes-of-${title}`));
  const contentId = uuidv7();
  db.vault
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
      world.origin.plane.boot.ownerPartyId,
      world.origin.plane.boot.deviceId,
      now
    );
  const documentId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_document
         (document_id, title, current_content_id, created_at, updated_at,
          deleted_at, purge_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`
    )
    .run(documentId, title, contentId, now, now);
  return documentId;
}

function grantRowCount(world: JoinWorld, subjectId: string): number {
  return (
    world.origin.plane.db.vault
      .prepare(
        `SELECT COUNT(*) AS n FROM share_authority
          WHERE subject_id = ? AND principal_kind IN ('person','circle')`
      )
      .get(subjectId) as { n: number }
  ).n;
}

function documentTitles(seat: Seat): string[] {
  return (
    seat.plane.db.vault
      .prepare("SELECT title FROM core_document ORDER BY title")
      .all() as { title: string }[]
  ).map((row) => row.title);
}

interface WireAnswer {
  status: number;
  body: Record<string, unknown>;
}

async function ask(
  seat: Seat,
  input: {
    method: string;
    target: string;
    vaultId?: string;
    body?: Record<string, unknown>;
  }
): Promise<WireAnswer> {
  const response = await tunnelRequest(seat.connection, {
    method: input.method,
    target: input.target,
    headers: {
      [VAULT_HEADER]: input.vaultId ?? seat.vaultId,
      "content-type": "application/json",
    },
    ...(input.body ? { body: Buffer.from(JSON.stringify(input.body)) } : {}),
  });
  const text = response.body.toString("utf8");
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

function shareDocument(
  world: JoinWorld,
  documentId: string,
  audience: Seat
): Promise<WireAnswer> {
  return ask(world.origin, {
    method: "POST",
    target: ROUTES.vaultGrants,
    body: {
      audienceKind: "party",
      audienceId: audience.partyId,
      subjectType: "core.document",
      subjectId: documentId,
      capability: "view",
    },
  });
}

describe("protocol join lane", () => {
  afterEach(closeEverything);

  test("a grant crosses mounted vaults over the real transport, and only the addressed seat receives it", async () => {
    const world = await joinWorld();
    const documentId = seedDocument(world, "Trip plan");
    const addressed = world.seats[1]!;

    const created = await shareDocument(world, documentId, addressed);
    expect(created.status).toBe(201);
    // No `fulfillmentPass` (V-delivery): the route does not deliver. The share
    // is HERE by the time the response is written — the WRITE's own doorbell
    // woke the loop — which the rows below prove over the real transport.
    expect(created.body).toMatchObject({
      outcome: "created",
      grant: {
        subjectType: "core.document",
        capability: "view",
        revokedAt: null,
        fulfillment: [{ peerVaultId: addressed.vaultId, state: "delivered" }],
        phrase: "shared",
      },
    });
    expect(documentTitles(addressed)).toStrictEqual(["Trip plan"]);
    // Addressing is real, not ambient: an unnamed co-host gets nothing.
    for (const bystander of world.seats.slice(2))
      expect(documentTitles(bystander)).toStrictEqual([]);

    // A seat reads only its OWN grant plane; refusal is vault-scope, not an
    // empty list.
    const trespass = await ask(addressed, {
      method: "GET",
      target: ROUTES.vaultGrants,
      vaultId: world.origin.vaultId,
    });
    expect(trespass.status).toBe(403);
    expect(trespass.body).toMatchObject({ error: "vault_not_enrolled" });

    for (const seat of world.seats.slice(2)) {
      // oxlint-disable-next-line no-await-in-loop -- one pass per gesture
      const shared = await shareDocument(world, documentId, seat);
      expect(shared.status).toBe(201);
    }
    for (const seat of world.seats.slice(1))
      expect(documentTitles(seat)).toStrictEqual(["Trip plan"]);

    // Created-or-exists is decided in the vault, so racing bi-streams cannot
    // mint a rival grant.
    const raced = seedDocument(world, "Race plan");
    const answers = await Promise.all(
      [0, 1, 2].map(() => shareDocument(world, raced, addressed))
    );
    expect(
      answers.filter((answer) => answer.body.outcome === "created")
    ).toHaveLength(1);
    expect(
      answers.filter((answer) => answer.body.outcome === "exists")
    ).toHaveLength(2);
    expect(grantRowCount(world, raced)).toBe(1);
  }, 120_000);

  test("revocation propagates across the join and severs delivery, not merely pauses it", async () => {
    const world = await joinWorld();
    const documentId = seedDocument(world, "Trip plan");
    const severed = world.seats[1]!;
    const kept = world.seats[2]!;

    const created = await shareDocument(world, documentId, severed);
    const grant = created.body.grant as { grantId: string };
    expect(documentTitles(severed)).toStrictEqual(["Trip plan"]);

    const revoked = await ask(world.origin, {
      method: "POST",
      target: `${ROUTES.vaultGrants}/${grant.grantId}/revoke`,
      body: {},
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({
      grant: {
        fulfillment: [{ peerVaultId: severed.vaultId, state: "removed" }],
      },
    });
    expect(documentTitles(severed)).toStrictEqual([]);

    // SEVERED, not idle: the next gesture's full pass would ride a merely
    // dormant grant back into the first seat.
    world.origin.plane.db.vault
      .prepare("UPDATE core_document SET title = ? WHERE document_id = ?")
      .run("Trip plan (final)", documentId);
    expect((await shareDocument(world, documentId, kept)).status).toBe(201);
    expect(documentTitles(kept)).toStrictEqual(["Trip plan (final)"]);
    expect(documentTitles(severed)).toStrictEqual([]);
    // Removal takes the whole PROJECTION: a content item left behind is a
    // copy of bytes the owner took back.
    const residue = severed.plane.db.vault
      .prepare(
        `SELECT (SELECT COUNT(*) FROM core_document) AS documents,
                (SELECT COUNT(*) FROM core_content_item) AS contents`
      )
      .get() as { documents: number; contents: number };
    expect({ ...residue }).toStrictEqual({ documents: 0, contents: 0 });
  }, 120_000);

  test("a parked payload survives a transport reconnect, then settles once and never unparks", async () => {
    const world = await joinWorld();
    const origin = world.origin;
    const taskCount = (): number =>
      (
        origin.plane.db.vault
          .prepare("SELECT COUNT(*) AS n FROM schedule_task")
          .get() as { n: number }
      ).n;
    const before = taskCount();

    origin.plane.enrollApp("planner");
    origin.plane.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });
    // Confirm-gated: tier 3/4 routing parks for EVERY non-owner caller.
    origin.plane.db.vault
      .prepare(
        `UPDATE agent_capability SET requires_confirmation = 1
          WHERE command_id = (SELECT command_id FROM agent_command
                               WHERE name = 'schedule.add_task')`
      )
      .run();
    const invoked = await origin.plane.bridgeFor("planner")({
      op: "invoke",
      payload: {
        command: "schedule.add_task",
        input: { title: "call the plumber" },
        purpose: "dpv:ServiceProvision",
      },
    });
    expect(invoked.ok).toBe(true);
    const parkedOutcome = invoked.result as {
      status: string;
      invocationId: string;
    };
    expect(parkedOutcome.status).toBe("parked");
    expect(taskCount()).toBe(before);

    const listed = await ask(origin, {
      method: "GET",
      target: PARKED_PATH,
    });
    expect(listed.status).toBe(200);
    expect(listed.body.parked).toMatchObject([
      {
        invocationId: parkedOutcome.invocationId,
        command: "schedule.add_task",
      },
    ]);

    // A parked payload is vault state: it outlives its connection, and a
    // reconnect replays nothing.
    await origin.client.close();
    const rejoined = await createTunnelClient({ relays: "disabled" });
    const ownerId = world.enrollments.owners.ownerOf(origin.vaultId);
    if (!ownerId) throw new Error("the origin vault lost its owner");
    world.enrollments.enroll({
      endpointId: rejoined.endpointId,
      vaultIds: [origin.vaultId],
      label: "origin-device-2",
      ownerId,
    });
    origin.client = rejoined;
    origin.connection = await rejoined.connect(world.endpoint.ticket());
    const afterReconnect = await ask(origin, {
      method: "GET",
      target: PARKED_PATH,
    });
    expect(afterReconnect.body.parked).toMatchObject([
      { invocationId: parkedOutcome.invocationId },
    ]);

    // SETTLE is the only exit; there is no unpark verb.
    const denied = await ask(origin, {
      method: "POST",
      target: `${PARKED_PATH}/${parkedOutcome.invocationId}`,
      body: { approve: false },
    });
    expect(denied.status).toBe(200);
    expect(denied.body).toMatchObject({ status: "denied" });
    expect(
      (await ask(origin, { method: "GET", target: PARKED_PATH })).body.parked
    ).toStrictEqual([]);

    // Journal denial commits BEFORE vault settlement, so a retry crashing in
    // that gap must finish the denial, never execute.
    const retried = await ask(origin, {
      method: "POST",
      target: `${PARKED_PATH}/${parkedOutcome.invocationId}`,
      body: { approve: true },
    });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ status: "denied" });
    expect(taskCount()).toBe(before);
  }, 120_000);

  test("an N-1 client meets one update wall over the real transport, with no fallback mode", async () => {
    const world = await joinWorld();
    const info = await ask(world.origin, {
      method: "GET",
      target: ROUTES.gatewayInfo,
    });
    expect(info.status).toBe(200);
    expect(judgeGatewayInfo(info.body)).toMatchObject({ ok: true });
    expect(info.body).toMatchObject({
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
    });

    // N-1 client, refused by the mutual window (synthetic — see header).
    const older = GATEWAY_PROTOCOL_VERSION - 1;
    expect(
      protocolsCompatible({
        localProtocol: older,
        localMin: older,
        peerProtocol: info.body.protocolVersion as number,
        peerMin: info.body.minSupportedProtocol as number,
      })
    ).toBe(false);

    const wall = judgeGatewayInfo({
      ...info.body,
      protocolVersion: older,
      minSupportedProtocol: older,
    });
    expect(wall).toStrictEqual({
      ok: false,
      reason: "protocol_mismatch",
      detail:
        `protocol incompatible: gateway protocol ${older} ` +
        `(minSupported ${older}); this client is protocol ` +
        `${GATEWAY_PROTOCOL_VERSION} (minSupported ${GATEWAY_MIN_PROTOCOL_VERSION}). ` +
        "Update the older side. Product version is not used for this check.",
    });
    expect(wall).not.toHaveProperty("info");

    // NO FALLBACK MODE: exactly one integer connects, none degrades.
    const span = GATEWAY_PROTOCOL_VERSION + 3;
    const outcomes = Array.from({ length: span }, (_unused, version) => {
      const judged = judgeGatewayInfo({
        ...info.body,
        protocolVersion: version,
        minSupportedProtocol: version,
      });
      return judged.ok ? "connect" : judged.reason;
    });
    expect(outcomes).toStrictEqual(
      Array.from({ length: span }, (_unused, version) =>
        version === GATEWAY_PROTOCOL_VERSION ? "connect" : "protocol_mismatch"
      )
    );
    // A widening bump must move this line, never a silent fallback.
    expect(GATEWAY_MIN_PROTOCOL_VERSION).toBe(GATEWAY_PROTOCOL_VERSION);
  }, 120_000);
});
