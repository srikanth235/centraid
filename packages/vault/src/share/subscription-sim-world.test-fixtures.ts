/*
 * Physical world for the SUBSCRIPTION simulator (#839, #929): seeded PRNG and
 * real on-disk vaults, one per seat. The schedule and the oracle live in
 * `subscription-sim.test-fixtures.ts`; the share plane's own slots live in
 * `subscription-sim-plane.test-fixtures.ts`.
 *
 * It carries no membership plane of its own any more. A seat is a vault with a
 * gateway and an owner; who may read what is one thing — a standing answer —
 * and this file's only job is to make the vaults real.
 */

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { bootstrapVault } from "../bootstrap.js";
import { registerTallyCommands } from "../commands/tally.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import type { SharePlane } from "./subscription-sim-plane.test-fixtures.js";

export const NOW = "2031-05-06T07:08:09.000Z";

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
  db: VaultDb;
  gateway: Gateway;
  partyId: string;
  credential: Credential;
  /** A reopen re-registers tally and would disarm confirmation; re-armed here. */
  confirmGated: string[];
}

export interface World {
  root: string;
  seats: Seat[];
  trace: string[];
  failures: string[];
  pinned: string[];
  stats: Record<string, number>;
  step: number;
  plane?: SharePlane;
}

export interface SimOptions {
  seed: number;
  actions: number;
  seats: number;
}

export interface SimReport {
  seed: number;
  trace: string[];
  failures: string[];
  pinned: string[];
  stats: Record<string, number>;
}

function openSeat(root: string, index: number): Seat {
  const vaultId = `vault-sim-${index}`;
  const dir = path.join(root, vaultId);
  mkdirSync(dir, { recursive: true });
  const db = openVaultDb({ dir });
  const boot = bootstrapVault(db, { vaultId, ownerName: `Seat ${index}` });
  const gateway = createGateway(db);
  registerTallyCommands(gateway);
  return {
    index,
    vaultId,
    dir,
    db,
    gateway,
    partyId: boot.ownerPartyId,
    credential: {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    },
    confirmGated: [],
  };
}

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

/** Every seat knows every other party by name, the way a linked owner does. */
function knowParty(host: Seat, other: Seat): void {
  host.db.vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, birth_date,
          avatar_content_id, created_at, updated_at)
       VALUES (?, 'person', ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(party_id) DO NOTHING`
    )
    .run(other.partyId, `Seat ${other.index}`, `Seat ${other.index}`, NOW, NOW);
}

export function createWorld(options: SimOptions): World {
  const root = tempDirSync("subscription-sim-");
  const seats: Seat[] = [];
  for (let index = 0; index < options.seats; index += 1)
    seats.push(openSeat(root, index));
  for (const host of seats)
    for (const other of seats) if (host !== other) knowParty(host, other);
  return {
    root,
    seats,
    trace: [],
    failures: [],
    pinned: [],
    stats: {},
    step: 0,
  };
}

export function closeWorld(world: World): void {
  for (const seat of world.seats) {
    try {
      seat.db.close();
    } catch {
      // Already closed by a reopen leg.
    }
  }
  rmSync(world.root, { recursive: true, force: true });
}
