// World mechanics for the Commons deterministic simulator (issue #731). This
// half owns the seeded PRNG and the physical world — real on-disk vaults, their
// grants, the single write rail, the pull rail, crash-restart, and snapshot /
// stale-restore. The schedule and the golden invariants live in
// `commons-sim.test-fixtures.ts`; keeping them apart is what stops the model and the oracle
// from quietly agreeing with each other.

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { bootstrapVault } from "../bootstrap.js";
import { registerTallyCommands } from "../commands/tally.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { backupVault } from "../gateway/custody.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import {
  placeCommonsBootstrapBlobs,
  placeCommonsIncrementBlobs,
} from "./commons-blobs.test-fixtures.js";
import {
  applyCommonsBootstrap,
  applyCommonsIncrement,
  applyCommonsTombstone,
  exportCommonsSyncFrame,
  isCommonsIncrementUnusable,
} from "./commons-bootstrap.js";
import { readCommonsCursor } from "./commons-cursor.js";
import { signCommonsIntent } from "./commons-signature.js";
import type { GrantPlane } from "./commons-sim-grant-world.test-fixtures.js";
import type { CommonsCapability, CommonsMemberInput } from "./commons.js";
import {
  compileCommons,
  createCommonsGrant,
  executeCommonsCommand,
  queueCommonsIntent,
  settleCommonsIntent,
} from "./commons.js";

/** Every `now` the simulator hands the vault. Wall-clock time never decides
 * anything a seed is supposed to decide. */
export const NOW = "2031-05-06T07:08:09.000Z";

/** mulberry32 — small, fast, and identical on every platform. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  int: (bound: number) => number;
  pick: <T>(items: readonly T[]) => T | undefined;
}

export function rngFor(seed: number): Rng {
  const random = mulberry32(seed);
  const int = (bound: number): number => Math.floor(random() * bound);
  return {
    int,
    pick: (items) =>
      items.length === 0 ? undefined : items[int(items.length)],
  };
}

export interface Seat {
  index: number;
  vaultId: string;
  dir: string;
  snapshotDir: string;
  hasSnapshot: boolean;
  db: VaultDb;
  gateway: Gateway;
  partyId: string;
  credential: Credential;
  sealKey: Buffer;
  identitySeed: Buffer;
  /** `dpv:ServiceProvision`, the purpose every seeded consent grant names. */
  purposeConceptId: string;
  /**
   * Commands this seat has marked loud-on-purpose (issue #839). Registration
   * REWRITES `agent_capability.requires_confirmation` from the definition, so
   * a crash-restart re-registers the tally pack and would silently disarm the
   * gate; `attach` re-arms from this list instead.
   */
  confirmGated: string[];
}

export interface ExpenseFact {
  expenseId: string;
  deleted: boolean;
}

export interface Grant {
  key: string;
  grantId: string;
  groupId: string;
  steward: Seat;
  /** Every seat that has ever held a place in this grant. */
  cast: Seat[];
  /** Current roster the model believes in, keyed by seat index. */
  roster: Map<number, CommonsCapability>;
  /** Steps remaining in an open steward-transfer window. */
  awayFor: number;
  expected: Map<string, ExpenseFact>;
  refused: Set<string>;
}

export interface ParkedIntent {
  grant: Grant;
  actor: Seat;
  command: string;
  commandInput: Record<string, unknown>;
  nonce: string;
}

export interface World {
  root: string;
  seats: Seat[];
  grants: Grant[];
  parked: ParkedIntent[];
  trace: string[];
  failures: string[];
  stats: Record<string, number>;
  step: number;
  /** The share-grant plane (issue #839), when this program asked for one. */
  plane?: GrantPlane;
}

export interface SimOptions {
  seed: number;
  actions: number;
  seats: number;
  grants: number;
  /**
   * Build the share-grant plane and admit its verbs into the schedule (issue
   * #839). Off by default so the #731 seeds keep their exact programs.
   */
  grantPlane?: boolean;
}

export interface SimReport {
  seed: number;
  trace: string[];
  failures: string[];
  stats: Record<string, number>;
}

export interface Decision {
  accepted: boolean;
  reason?: string;
  sequence: number;
}

function openSeat(root: string, index: number): Seat {
  const vaultId = `vault-sim-${index}`;
  const dir = path.join(root, vaultId);
  const snapshotDir = path.join(root, `${vaultId}-snapshot`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });
  const db = openVaultDb({ dir });
  const boot = bootstrapVault(db, { vaultId, ownerName: `Seat ${index}` });
  const gateway = createGateway(db);
  registerTallyCommands(gateway);
  return {
    index,
    vaultId,
    dir,
    snapshotDir,
    hasSnapshot: false,
    db,
    gateway,
    partyId: boot.ownerPartyId,
    credential: {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    },
    sealKey: Buffer.from(db.sealKey),
    identitySeed: Buffer.from(db.identitySeed),
    purposeConceptId: boot.concepts["dpv:ServiceProvision"] as string,
    confirmGated: [],
  };
}

/** Mark one command Tier 3/4 at this seat: a non-owner caller parks on it. */
export function armConfirmGate(seat: Seat, commandName: string): void {
  if (!seat.confirmGated.includes(commandName))
    seat.confirmGated.push(commandName);
  seat.db.vault
    .prepare(
      `UPDATE agent_capability SET requires_confirmation = 1
        WHERE command_id = (SELECT command_id FROM agent_command WHERE name = ?)`
    )
    .run(commandName);
}

function attach(seat: Seat): void {
  seat.db = openVaultDb({
    dir: seat.dir,
    sealKey: seat.sealKey,
    identitySeed: seat.identitySeed,
  });
  seat.gateway = createGateway(seat.db);
  registerTallyCommands(seat.gateway);
  for (const commandName of seat.confirmGated) armConfirmGate(seat, commandName);
}

/** Crash-restart: drop the SQLite handles mid-program and come back from the
 * files alone. Anything the vault only held in memory is gone. */
export function reopenSeat(seat: Seat): void {
  seat.db.close();
  attach(seat);
}

export function snapshotSeat(seat: Seat): void {
  backupVault(seat.db, seat.snapshotDir);
  seat.hasSnapshot = true;
}

/** Restore a member's whole SQLite file from an earlier point in the program:
 * the cursor rewinds, the replica loses rows, and the next pull has to repair
 * it without replaying from zero. */
export function staleRestoreSeat(seat: Seat): void {
  seat.db.close();
  for (const [source, target] of [
    ["vault.backup.db", "vault.db"],
    ["journal.backup.db", "journal.db"],
  ] as const) {
    for (const suffix of ["-wal", "-shm"])
      rmSync(path.join(seat.dir, `${target}${suffix}`), { force: true });
    copyFileSync(
      path.join(seat.snapshotDir, source),
      path.join(seat.dir, target)
    );
  }
  attach(seat);
}

function knowParty(host: Seat, other: Seat): void {
  host.db.vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, birth_date,
          avatar_content_id, created_at, updated_at, ontology_version)
       VALUES (?, 'person', ?, ?, NULL, NULL, ?, ?, '1.4')
       ON CONFLICT(party_id) DO NOTHING`
    )
    .run(other.partyId, `Seat ${other.index}`, `Seat ${other.index}`, NOW, NOW);
}

export function seatInput(
  seat: Seat,
  capability: CommonsCapability
): CommonsMemberInput {
  return {
    partyId: seat.partyId,
    capability,
    vaultId: seat.vaultId,
    vault: seat.db,
  };
}

/** The steward's own seat, and only it: every other replica has to earn its
 * state by pulling, which is what makes the schedule interesting. */
export function stewardOnly(grant: Grant): CommonsMemberInput[] {
  return [seatInput(grant.steward, "read+write")];
}

function createGrant(steward: Seat, index: number, memberSeats: Seat[]): Grant {
  const created = steward.gateway.invoke(steward.credential, {
    command: "tally.create_group",
    input: {
      name: `Sim grant ${index}`,
      icon: "🧪",
      member_ids: memberSeats.map((seat) => seat.partyId),
    },
    purpose: "dpv:ServiceProvision",
  });
  if (created.status !== "executed")
    throw new Error(`sim group ${index} did not create: ${created.status}`);
  const groupId = (created as { output: { group_id: string } }).output.group_id;
  const record = createCommonsGrant({
    origin: steward.db.vault,
    ownerPartyId: steward.partyId,
    ownerVaultId: steward.vaultId,
    ownerVault: steward.db,
    containerType: "tally.group",
    containerId: groupId,
    members: memberSeats.map((seat) => seatInput(seat, "read+write")),
    now: NOW,
  });
  const grant: Grant = {
    key: `g${index}`,
    grantId: record.grantId,
    groupId,
    steward,
    cast: memberSeats,
    roster: new Map(memberSeats.map((seat) => [seat.index, "read+write"])),
    awayFor: 0,
    expected: new Map(),
    refused: new Set(),
  };
  // One initial push so every seat starts from the same projected truth.
  compileCommons({
    steward: steward.db,
    stewardVaultId: steward.vaultId,
    grantId: grant.grantId,
    seats: [
      seatInput(steward, "read+write"),
      ...memberSeats.map((seat) => seatInput(seat, "read+write")),
    ],
    now: NOW,
  });
  return grant;
}

export function createWorld(options: SimOptions): World {
  const root = tempDirSync("commons-sim-");
  const seats: Seat[] = [];
  for (let index = 0; index < options.seats; index += 1)
    seats.push(openSeat(root, index));
  for (const host of seats)
    for (const other of seats) if (host !== other) knowParty(host, other);
  const grants: Grant[] = [];
  // Overlapping membership on purpose: grant g is stewarded by seat g and
  // carries every other seat, so one vault is steward of A and member of B.
  for (let index = 0; index < options.grants; index += 1)
    grants.push(
      createGrant(
        seats[index]!,
        index,
        seats.filter((seat) => seat.index !== index)
      )
    );
  return {
    root,
    seats,
    grants,
    parked: [],
    trace: [],
    failures: [],
    stats: {},
    step: 0,
  };
}

export function closeWorld(world: World): void {
  for (const seat of world.seats) {
    try {
      seat.db.close();
    } catch {
      // A seat may already be closed by a crash-restart leg mid-teardown.
    }
  }
  rmSync(world.root, { recursive: true, force: true });
}

export interface Dump {
  group: Record<string, unknown> | null;
  expenses: Record<string, unknown>[];
  splits: Record<string, unknown>[];
  members: Record<string, unknown>[];
}

/** Canonical, ordered, table-level dump of one grant's live domain state. This
 * is deliberately domain rows only — never frame internals, op rows, or chain
 * hashes — so additive changes to the wire shape cannot break the oracle. Soft
 * deleted rows are excluded here; their absence is asserted separately. */
export function dumpGrant(db: VaultDb, groupId: string): Dump {
  const rows = (sql: string, ...params: string[]): Record<string, unknown>[] =>
    (db.vault.prepare(sql).all(...params) as Record<string, unknown>[]).map(
      (row) => ({ ...row })
    );
  const group =
    rows(
      `SELECT g.group_id, c.name, g.icon FROM tally_group g
         JOIN social_circle c ON c.circle_id = g.circle_id
        WHERE g.group_id = ?`,
      groupId
    )[0] ?? null;
  return {
    group,
    expenses: rows(
      `SELECT expense_id, description, amount_minor, paid_by, category
         FROM tally_expense
        WHERE group_id = ? AND deleted_at IS NULL
        ORDER BY description, expense_id`,
      groupId
    ),
    splits: rows(
      `SELECT e.description, s.party_id, s.share_minor
         FROM tally_expense_split s
         JOIN tally_expense e ON e.expense_id = s.expense_id
        WHERE e.group_id = ? AND e.deleted_at IS NULL
        ORDER BY e.description, s.party_id`,
      groupId
    ),
    members: rows(
      `SELECT m.party_id, m.capability FROM social_circle_member m
         JOIN tally_group g ON g.circle_id = m.circle_id
        WHERE g.group_id = ? ORDER BY m.party_id`,
      groupId
    ),
  };
}

export function dumpKey(db: VaultDb, groupId: string): string {
  return JSON.stringify(dumpGrant(db, groupId));
}

/** The one write rail the simulator uses: park the intent locally first, sign
 * as the member (or act as the steward), execute at the steward, then settle
 * the local intent the way a host would. Only the steward's own seat is
 * compiled, so every replica has to pull for itself. */
export function submit(
  world: World,
  grant: Grant,
  actor: Seat,
  command: string,
  commandInput: Record<string, unknown>,
  nonce: string
): Decision {
  const steward = grant.steward;
  const isMember = actor.index !== steward.index;
  if (isMember)
    queueCommonsIntent({
      seat: actor.db.vault,
      intentId: nonce,
      grantId: grant.grantId,
      actorPartyId: actor.partyId,
      command,
      commandInput,
      now: NOW,
    });
  const { decision } = executeCommonsCommand({
    steward: steward.db,
    gateway: steward.gateway,
    credential: steward.credential,
    stewardVaultId: steward.vaultId,
    grantId: grant.grantId,
    actorPartyId: actor.partyId,
    command,
    commandInput,
    seats: stewardOnly(grant),
    ...(isMember
      ? {
          memberSignature: signCommonsIntent(actor.db.identitySeed, {
            grantId: grant.grantId,
            actorPartyId: actor.partyId,
            command,
            commandInput,
            memberVaultId: actor.vaultId,
            nonce,
          }),
        }
      : {}),
    intentId: nonce,
    invocationId: nonce,
    now: NOW,
  });
  // The fork guard is the one refusal a host must treat as "come back later"
  // rather than "no": the write was never sequenced anywhere.
  const parked = decision.reason?.includes("not the current steward") === true;
  if (isMember)
    settleCommonsIntent({
      seat: actor.db.vault,
      intentId: nonce,
      status: decision.accepted ? "executed" : parked ? "parked" : "denied",
      ...(decision.reason ? { reason: decision.reason } : {}),
      now: NOW,
    });
  if (parked) world.parked.push({ grant, actor, command, commandInput, nonce });
  return decision;
}

/** One member pull, exercising BOTH rails (#750): the seat asks with its own
 * cursor, replays an ops-since-cursor increment when its cursor sits on the
 * chain, and re-baselines through the full snapshot frame when the increment
 * is unusable or its tail cannot be re-executed against this replica. Returns
 * whether the seat's domain state actually moved. */
export function pull(grant: Grant, seat: Seat): boolean {
  const before = dumpKey(seat.db, grant.groupId);
  const cursor = readCommonsCursor(seat.db.vault, grant.grantId, seat.vaultId);
  const frameFor = (afterSequence?: number) =>
    exportCommonsSyncFrame({
      steward: grant.steward.db.vault,
      identitySeed: grant.steward.db.identitySeed,
      stewardVaultId: grant.steward.vaultId,
      grantId: grant.grantId,
      memberVaultId: seat.vaultId,
      ...(afterSequence === undefined ? {} : { afterSequence }),
    });
  const applyFull = (frame: ReturnType<typeof frameFor>): void => {
    if (frame.state === "tombstone") {
      applyCommonsTombstone({ seat: seat.db, tombstone: frame.tombstone });
      return;
    }
    if (frame.state !== "bootstrap")
      throw new Error(`expected a full frame, got ${frame.state}`);
    placeCommonsBootstrapBlobs({
      source: grant.steward.db,
      seat: seat.db,
      wire: frame.wire,
    });
    applyCommonsBootstrap({ seat: seat.db, wire: frame.wire, now: NOW });
  };
  const frame = frameFor(cursor?.sequence);
  if (frame.state === "increment") {
    placeCommonsIncrementBlobs({
      source: grant.steward.db,
      seat: seat.db,
      increment: frame.increment,
    });
    try {
      applyCommonsIncrement({
        seat: seat.db,
        increment: frame.increment,
        now: NOW,
        applyCommand: replicaExecutor(seat),
      });
    } catch (error) {
      // Unusable-for-this-replica shapes re-baseline; faults still propagate.
      if (!isCommonsIncrementUnusable(error)) throw error;
      applyFull(frameFor());
    }
  } else applyFull(frame);
  return dumpKey(seat.db, grant.groupId) !== before;
}

/** The host seam a replica catches up through: the seat's own gateway, on the
 * canonical Commons rail, seeded so replayed commands mint the steward's ids. */
export function replicaExecutor(
  seat: Seat
): (
  command: string,
  commandInput: Record<string, unknown>,
  invocationId: string
) => ReturnType<Gateway["invokeCommonsCanonical"]> {
  return (command, commandInput, invocationId) =>
    seat.gateway.invokeCommonsCanonical(
      seat.credential,
      {
        command,
        input: commandInput,
        purpose: "dpv:ServiceProvision",
        invocationId,
      },
      { idSeed: invocationId }
    );
}

export function currentMembers(world: World, grant: Grant): Seat[] {
  return [...grant.roster.keys()].map((index) => world.seats[index]!);
}

/** Seats that steward nothing may be snapshotted and rewound; rewinding a
 * steward would destroy the single-writer log itself, which is outside the
 * model's contract. */
export function replicaOnlySeats(world: World): Seat[] {
  const stewards = new Set(world.grants.map((grant) => grant.steward.index));
  return world.seats.filter((seat) => !stewards.has(seat.index));
}
