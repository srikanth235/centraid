// Shared seats for the #731 intent-lifecycle suites (stale-context
// scoping in commons-stale-lifecycle.test.ts, parked-intent expiry/cancel
// in commons-intent-lifecycle.test.ts). Three real on-disk vaults — steward Priya plus
// members Bob and Cara — so the intervening ops that make a composed intent
// stale are genuine `share_commons_op` rows produced by the ordinary command
// gateway, not hand-seeded fixtures.

import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { bootstrapVault } from "../bootstrap.js";
import { registerTallyCommands } from "../commands/tally.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso } from "../ids.js";
import {
  compileCommons,
  createCommonsGrant,
  executeCommonsCommand,
} from "./commons.js";

export interface Seat {
  vaultId: string;
  db: VaultDb;
  boot: ReturnType<typeof bootstrapVault>;
}

export const opened: VaultDb[] = [];
export const roots: string[] = [];

function openSeat(root: string, vaultId: string, ownerName: string): Seat {
  const dir = path.join(root, vaultId);
  mkdirSync(dir, { recursive: true });
  const db = openVaultDb({ dir });
  opened.push(db);
  return { vaultId, db, boot: bootstrapVault(db, { vaultId, ownerName }) };
}

function addParty(steward: VaultDb, seat: Seat, now: string): void {
  steward.vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, birth_date,
          avatar_content_id, created_at, updated_at, ontology_version)
       VALUES (?, 'person', ?, ?, NULL, NULL, ?, ?, '1.4')`
    )
    .run(
      seat.boot.ownerPartyId,
      seat.boot.displayName,
      seat.boot.displayName,
      now,
      now
    );
}

export function credential(seat: Seat): Credential {
  return {
    kind: "device",
    deviceId: seat.boot.deviceId,
    deviceKey: seat.boot.deviceKey,
  };
}

/** Priya (steward) plus Bob and Cara (read+write members), one Tally group
 * already shared as a commons grant, compiled into both member vaults. */
export function setup() {
  const root = tempDirSync("commons-stale-lifecycle-");
  roots.push(root);
  const priya = openSeat(root, "vault-priya", "Priya");
  const bob = openSeat(root, "vault-bob", "Bob");
  const cara = openSeat(root, "vault-cara", "Cara");
  const now = nowIso();
  addParty(priya.db, bob, now);
  addParty(priya.db, cara, now);
  const gateway = createGateway(priya.db);
  registerTallyCommands(gateway);
  const created = gateway.invoke(credential(priya), {
    command: "tally.create_group",
    input: {
      name: "Goa",
      icon: "🏖️",
      member_ids: [bob.boot.ownerPartyId, cara.boot.ownerPartyId],
    },
  });
  expect(created.status).toBe("executed");
  const groupId = (created as { output: { group_id: string } }).output.group_id;
  const grant = createCommonsGrant({
    origin: priya.db.vault,
    ownerPartyId: priya.boot.ownerPartyId,
    ownerVaultId: priya.vaultId,
    ownerVault: priya.db,
    containerType: "tally.group",
    containerId: groupId,
    members: [
      {
        partyId: bob.boot.ownerPartyId,
        capability: "read+write",
        vaultId: bob.vaultId,
        vault: bob.db,
      },
      {
        partyId: cara.boot.ownerPartyId,
        capability: "read+write",
        vaultId: cara.vaultId,
        vault: cara.db,
      },
    ],
    now,
  });
  const seats = [
    {
      partyId: priya.boot.ownerPartyId,
      capability: "read+write" as const,
      vaultId: priya.vaultId,
      vault: priya.db,
    },
    {
      partyId: bob.boot.ownerPartyId,
      capability: "read+write" as const,
      vaultId: bob.vaultId,
      vault: bob.db,
    },
    {
      partyId: cara.boot.ownerPartyId,
      capability: "read+write" as const,
      vaultId: cara.vaultId,
      vault: cara.db,
    },
  ];
  compileCommons({
    steward: priya.db,
    stewardVaultId: priya.vaultId,
    grantId: grant.grantId,
    seats,
    now,
  });

  // A plain incrementing counter, not `Date.now()`/`Math.random()` — this
  // package's tests are deterministic by convention (the sim harness's own
  // seeded mulberry32 PRNG exists precisely so failures reproduce).
  let priyaIntentSeq = 0;
  const executeAsPriya = (command: string, commandInput: unknown) =>
    executeCommonsCommand({
      steward: priya.db,
      gateway,
      credential: credential(priya),
      stewardVaultId: priya.vaultId,
      grantId: grant.grantId,
      actorPartyId: priya.boot.ownerPartyId,
      command,
      commandInput: commandInput as Record<string, unknown>,
      seats,
      intentId: `priya-${command}-${(priyaIntentSeq += 1)}`,
      now,
    });

  return {
    priya,
    bob,
    cara,
    gateway,
    groupId,
    grant,
    seats,
    now,
    executeAsPriya,
  };
}
