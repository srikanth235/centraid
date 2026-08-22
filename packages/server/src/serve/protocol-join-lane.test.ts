/*
 * PROTOCOL JOIN LANE (issue #839, gaps G11 + G12).
 *
 * Runs on the PR path at its 3-seat floor and again nightly at width — the
 * `protocol-join` job in `.github/workflows/e2e.yml` raises
 * `CENTRAID_JOIN_SEATS` and keeps the vitest JSON report as evidence.
 *
 * Every other suite in this repo that exercises two vaults talking to each
 * other calls the vault package directly: `grant-fulfillment.test.ts` builds a
 * `Map` of mounted vaults, `grant-routes.test.ts` hand-rolls an
 * `IncomingMessage`. Nothing JOINS — nothing puts N seats on ONE gateway and
 * makes them speak the real wire. This lane is that missing rig: one `serve()`
 * daemon, N mounted vaults, and one iroh tunnel client per seat, so every
 * assertion below travels the same transport a paired phone uses.
 *
 * ── The v1 reach this rig respects ──────────────────────────────────────────
 *
 * A grant is fulfilled by resolving the audience vault through the HOST
 * gateway's own registry (docs/protocol.md, "Cross-host grant delivery is an
 * open gap"). A grant to a vault on a DIFFERENT gateway parks at `syncing` and
 * stays there — deliberately, not as an error. So the join topology is one
 * gateway with N mounted vaults, never N gateways. When #825's cross-host
 * follow-up lands, this file is where the second gateway joins.
 *
 * ── Seats ───────────────────────────────────────────────────────────────────
 *
 * A seat here is a VAULT IDENTITY plus the device that reaches it, not a
 * client bundle: `seat()` in `host-platform.ts` is a build-time constant, so
 * "custodian vs viewer" cannot be varied at runtime. `CENTRAID_JOIN_SEATS`
 * raises N for the nightly job; the laws are the same at every N.
 *
 * ── What this lane does NOT cover ───────────────────────────────────────────
 *
 * The skew test below asserts the update wall with SYNTHETIC version integers.
 * A real pinned-N−1-client artifact lane (build an older client, run it against
 * today's gateway) is out of scope here: the protocol window is a single point
 * (`GATEWAY_PROTOCOL_VERSION === GATEWAY_MIN_PROTOCOL_VERSION === 3`), so no
 * legal N−1 client exists to pin, and producing one is a release-pipeline
 * change — tracked under #842 W5.3, not here.
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
/** Owner decisions awaiting confirmation; `_vault` has no ROUTES constant for it. */
const PARKED_PATH = "/centraid/_vault/parked";

/**
 * Seats in the join. Three is the floor the laws need (an origin, an addressed
 * audience, and a bystander that proves addressing is real); the nightly job
 * raises it so fan-out and severance are asserted at width.
 */
const SEAT_COUNT = Math.max(3, Number(process.env.CENTRAID_JOIN_SEATS ?? 3));

interface Seat {
  readonly label: string;
  readonly vaultId: string;
  readonly plane: VaultPlane;
  /** The party row in the ORIGIN vault that stands for this seat's owner. */
  partyId: string;
  client: TunnelClient;
  connection: Connection;
}

interface JoinWorld {
  handle: GatewayServeHandle;
  endpoint: GatewayEndpointHandle;
  enrollments: EnrollmentStore;
  seats: Seat[];
  /** Seat 0 — the vault whose subjects are shared. */
  origin: Seat;
}

const worlds: JoinWorld[] = [];
const dataDirs: string[] = [];

/** Every seat, endpoint, gateway and temp dir this file opened. */
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

/** One gateway, `SEAT_COUNT` mounted vaults, one live tunnel client per seat. */
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
      // The iroh forwarder stamps the QUIC-proved EndpointId; the endpoint
      // below stamps the same header, so this seam reads the REAL identity of
      // whichever seat opened the stream.
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
      // Each seat is its own OWNER: co-hosted vaults belonging to different
      // people is the topology v1 grants actually reach. Enrolment precedes
      // the dial because the endpoint's `authorize` seam reads it.
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
  // Every audience seat gets a party row in the origin vault, bound to that
  // seat's real vault id — the binding is what a grant resolves through.
  for (const seat of seats.slice(1)) seat.partyId = linkSeat(world, seat);
  return world;
}

/** A person in the origin vault whose vault binding names `seat`. */
function linkSeat(world: JoinWorld, seat: Seat): string {
  const now = nowIso();
  const partyId = uuidv7();
  const db = world.origin.plane.db.vault;
  db.prepare(
    `INSERT INTO core_party
       (party_id, kind, display_name, sort_name, created_at, updated_at,
        ontology_version)
     VALUES (?, 'person', ?, ?, ?, ?, '1.4')`
  ).run(partyId, seat.label, seat.label, now, now);
  db.prepare(
    `INSERT INTO share_party_vault_binding
       (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
     VALUES (?, ?, ?, NULL, ?, NULL)`
  ).run(uuidv7(), partyId, seat.vaultId, now);
  return partyId;
}

/** One document in the origin vault — the smallest whole subject a grant carries. */
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

/** Live + revoked grant rows this vault holds over one subject. */
function grantRowCount(world: JoinWorld, subjectId: string): number {
  return (
    world.origin.plane.db.vault
      .prepare("SELECT COUNT(*) AS n FROM share_grant WHERE subject_id = ?")
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

/** One request from one seat, over that seat's own iroh connection. */
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

/** Say a standing share of `documentId` to `audience`, over the wire. */
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
    expect(created.body).toMatchObject({
      outcome: "created",
      fulfillmentPass: { origin: "mounted" },
      grant: {
        subjectType: "core.document",
        capability: "view",
        revokedAt: null,
        fulfillment: [{ peerVaultId: addressed.vaultId, state: "delivered" }],
      },
    });
    expect(documentTitles(addressed)).toStrictEqual(["Trip plan"]);
    // Addressing is real, not ambient: a co-hosted vault that was not named
    // receives nothing, even though the fulfillment engine can reach it.
    for (const bystander of world.seats.slice(2))
      expect(documentTitles(bystander)).toStrictEqual([]);

    // A seat reads its OWN vault's grant plane; the origin's is not its to
    // see, and the refusal is the vault-scope one, never an empty list.
    const trespass = await ask(addressed, {
      method: "GET",
      target: ROUTES.vaultGrants,
      vaultId: world.origin.vaultId,
    });
    expect(trespass.status).toBe(403);
    expect(trespass.body).toMatchObject({ error: "vault_not_enrolled" });

    // Fan out the same subject to every remaining seat: N delivered copies,
    // one gesture each, all over the tunnel.
    for (const seat of world.seats.slice(2)) {
      // Sequential on purpose: each gesture runs its own fulfillment pass over
      // the subject, and overlapping them would hide which pass delivered.
      // oxlint-disable-next-line no-await-in-loop -- one pass per gesture
      const shared = await shareDocument(world, documentId, seat);
      expect(shared.status).toBe(201);
    }
    for (const seat of world.seats.slice(1))
      expect(documentTitles(seat)).toStrictEqual(["Trip plan"]);

    // Saying it three times AT ONCE, down three bi-streams of one live
    // connection: created-or-exists is decided in the vault, so concurrency
    // cannot mint a rival grant over the same (audience, subject, capability).
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

    // SEVERED, not idle. The subject moves on and is shared with a second
    // seat; that gesture runs a fulfillment pass over the whole subject, so a
    // grant that were merely dormant would ride it back into the first seat.
    world.origin.plane.db.vault
      .prepare("UPDATE core_document SET title = ? WHERE document_id = ?")
      .run("Trip plan (final)", documentId);
    expect((await shareDocument(world, documentId, kept)).status).toBe(201);
    expect(documentTitles(kept)).toStrictEqual(["Trip plan (final)"]);
    expect(documentTitles(severed)).toStrictEqual([]);
    // Removal takes the whole PROJECTION, not just the row that named it. A
    // content item left behind would be an unreachable copy of the bytes the
    // owner just took back — invisible to `documentTitles`, and the shape a
    // row-only delete would leave.
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
    // Make the command confirm-gated. Tier 3/4 routing parks for EVERY
    // non-owner caller (gateway.ts), which is the state this law is about.
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

    // RECONNECT: drop this seat's transport entirely and join again as a new
    // device of the same owner. A parked payload is vault state, so it must
    // outlive the connection that produced it — nothing re-parks, nothing is
    // replayed, and the decision is still owed.
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

    // SETTLE — the only exit. There is no unpark verb in this product.
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

    // Pinned behaviour, gateway.ts:1579 — journal denial commits BEFORE vault
    // settlement, so a crash in that gap leaves the payload present. Any
    // retry, even an accidental approve, must finish the original denial
    // rather than execute. This asserts the recovery, not a wish.
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
    // The live gateway this rig just booted judges green against today's
    // client — the control case that makes every refusal below meaningful.
    expect(judgeGatewayInfo(info.body)).toMatchObject({ ok: true });
    expect(info.body).toMatchObject({
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
    });

    // An N-1 CLIENT against this live gateway: refused by the mutual window.
    // Synthetic integers, because the window is a single point and no legal
    // N-1 client exists to build (see the file header).
    const older = GATEWAY_PROTOCOL_VERSION - 1;
    expect(
      protocolsCompatible({
        localProtocol: older,
        localMin: older,
        peerProtocol: info.body.protocolVersion as number,
        peerMin: info.body.minSupportedProtocol as number,
      })
    ).toBe(false);

    // The refusal a client SHOWS is one wall with the documented copy, and it
    // carries no `info` — there is nothing to half-connect with.
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

    // NO FALLBACK MODE, stated as a sweep: across every neighbouring protocol
    // integer, exactly one — today's — is accepted. Older and newer both wall,
    // and nothing in between degrades into a reduced-feature connect.
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
    // The window is a single point today; a widening bump must move this line
    // deliberately rather than let a silent fallback appear.
    expect(GATEWAY_MIN_PROTOCOL_VERSION).toBe(GATEWAY_PROTOCOL_VERSION);
  }, 120_000);
});
