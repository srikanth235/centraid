// A FoundationDB-style deterministic simulator for the Commons sharing plane
// (issue #731). One seeded PRNG drives a random program of steward writes,
// signed member intents, pulls, roster/capability churn, steward-transfer
// windows, compaction, crash-restarts, and stale-restores across several real
// on-disk vaults, then forces quiescence and checks the golden invariants.
// Nothing here touches the gateway HTTP layer; every step is a vault-package
// call, so a failing seed replays byte-for-byte from the seed alone.
//
// This half owns the schedule and the oracle; `commons-sim-world.test-fixtures.ts` owns the
// physical world and the two rails (write, pull).

import {
  removeCommonsMember,
  upsertCommonsMember,
} from "./commons-lifecycle.js";
import type {
  Decision,
  Grant,
  Rng,
  Seat,
  SimOptions,
  SimReport,
  World,
} from "./commons-sim-world.test-fixtures.js";
import {
  NOW,
  closeWorld,
  createWorld,
  currentMembers,
  dumpGrant,
  dumpKey,
  pull,
  reopenSeat,
  replicaOnlySeats,
  rngFor,
  seatInput,
  snapshotSeat,
  staleRestoreSeat,
  stewardOnly,
  submit,
} from "./commons-sim-world.test-fixtures.js";
import type { CommonsCapability } from "./commons.js";
import {
  compactCommonsOperations,
  compileCommons,
  readCommonsGrant,
  transferCommonsSteward,
} from "./commons.js";

/** Weighted schedule. Writes deliberately outnumber pulls so replicas fall
 * behind, yet every disruptive leg still fires several times in one program. */
export const ACTION_WEIGHTS = {
  member_intent: 26,
  steward_write: 16,
  member_pull: 22,
  invalid_write: 8,
  delete_expense: 7,
  membership_change: 5,
  capability_change: 5,
  steward_transfer: 3,
  compaction: 5,
  crash_restart: 4,
  snapshot_member: 3,
  stale_restore: 3,
} as const;

type ActionName = keyof typeof ACTION_WEIGHTS;

const ACTION_NAMES = Object.keys(ACTION_WEIGHTS) as ActionName[];
const TOTAL_WEIGHT = ACTION_NAMES.reduce(
  (sum, name) => sum + ACTION_WEIGHTS[name],
  0
);

function pickAction(rng: Rng): ActionName {
  let ticket = rng.int(TOTAL_WEIGHT);
  for (const name of ACTION_NAMES) {
    ticket -= ACTION_WEIGHTS[name];
    if (ticket < 0) return name;
  }
  return "member_pull";
}

function expenseInput(
  grant: Grant,
  payer: Seat,
  description: string,
  amount: number
): Record<string, unknown> {
  return {
    group_id: grant.groupId,
    description,
    amount_minor: amount,
    paid_by: payer.partyId,
    category: "food",
    splits: [{ party_id: payer.partyId, share_minor: amount }],
  };
}

/** Roster + capability truth the model believes, and therefore the oracle for
 * "this write MUST have been refused". */
function mustRefuse(grant: Grant, actor: Seat): boolean {
  if (grant.awayFor > 0) return true;
  if (actor.index === grant.steward.index) return false;
  const capability = grant.roster.get(actor.index);
  return capability === undefined || capability === "read";
}

function recordWrite(
  world: World,
  grant: Grant,
  actor: Seat,
  description: string,
  decision: Decision
): void {
  if (mustRefuse(grant, actor) && decision.accepted)
    world.failures.push(
      `#${world.step} ${grant.key}: seat ${actor.index} write "${description}" was accepted while the model says it must refuse`
    );
  if (!decision.accepted) {
    if (!grant.expected.has(description)) grant.refused.add(description);
    return;
  }
  const row = grant.steward.db.vault
    .prepare(
      "SELECT expense_id FROM tally_expense WHERE group_id = ? AND description = ?"
    )
    .get(grant.groupId, description) as { expense_id: string } | undefined;
  if (!row) {
    world.failures.push(
      `#${world.step} ${grant.key}: accepted write "${description}" left no row at the steward`
    );
    return;
  }
  grant.expected.set(description, {
    expenseId: row.expense_id,
    deleted: false,
  });
}

function traceDecision(decision: Decision): string {
  return decision.accepted
    ? "accepted"
    : `refused(${decision.reason ?? "unknown"})`;
}

function writeAction(
  world: World,
  rng: Rng,
  grant: Grant,
  actor: Seat,
  invalid: boolean
): void {
  const description = `${grant.key}-s${actor.index}-n${world.step}`;
  const amount = 100 + rng.int(900);
  const commandInput = expenseInput(grant, actor, description, amount);
  // An invalid write is structurally well formed but semantically impossible:
  // the splits do not sum to the amount, so the handler refuses inside the
  // steward's own transaction and the op is appended as `refused`.
  if (invalid)
    commandInput["splits"] = [
      { party_id: actor.partyId, share_minor: amount + 1 },
    ];
  const decision = submit(
    world,
    grant,
    actor,
    "tally.add_expense",
    commandInput,
    `intent-${world.step}`
  );
  if (invalid) {
    if (decision.accepted)
      world.failures.push(
        `#${world.step} ${grant.key}: a splits-mismatch write was accepted`
      );
    grant.refused.add(description);
    return;
  }
  recordWrite(world, grant, actor, description, decision);
  world.trace.push(
    `#${world.step} write ${grant.key} seat=${actor.index} "${description}" -> ${traceDecision(decision)}`
  );
}

function deleteAction(world: World, rng: Rng, grant: Grant): void {
  const chosen = rng.pick(
    [...grant.expected.entries()].filter(([, fact]) => !fact.deleted)
  );
  const actor = rng.pick([grant.steward, ...currentMembers(world, grant)]);
  if (!chosen || !actor) return;
  const [description, fact] = chosen;
  const decision = submit(
    world,
    grant,
    actor,
    "tally.delete_expense",
    { expense_id: fact.expenseId },
    `intent-${world.step}`
  );
  if (decision.accepted) fact.deleted = true;
  world.trace.push(
    `#${world.step} delete ${grant.key} "${description}" -> ${traceDecision(decision)}`
  );
}

function membershipAction(world: World, rng: Rng, grant: Grant): void {
  if (grant.awayFor > 0) return;
  const outside = grant.cast.filter((seat) => !grant.roster.has(seat.index));
  // Never strand the grant without an eligible successor steward.
  const removable = grant.roster.size > 1 ? currentMembers(world, grant) : [];
  const removing =
    outside.length === 0 || (removable.length > 0 && rng.int(2) === 0);
  const seat = rng.pick(removing ? removable : outside);
  if (!seat) return;
  if (removing) {
    removeCommonsMember({
      steward: grant.steward.db.vault,
      grantId: grant.grantId,
      actorPartyId: grant.steward.partyId,
      memberPartyId: seat.partyId,
      now: NOW,
    });
    grant.roster.delete(seat.index);
  } else {
    upsertCommonsMember({
      steward: grant.steward.db.vault,
      grantId: grant.grantId,
      actorPartyId: grant.steward.partyId,
      member: seatInput(seat, "read+write"),
      now: NOW,
    });
    grant.roster.set(seat.index, "read+write");
  }
  world.trace.push(
    `#${world.step} membership ${grant.key} seat=${seat.index} -> ${removing ? "removed" : "added"}`
  );
}

function capabilityAction(world: World, rng: Rng, grant: Grant): void {
  if (grant.awayFor > 0) return;
  const seat = rng.pick(currentMembers(world, grant));
  if (!seat) return;
  const capability: CommonsCapability =
    grant.roster.get(seat.index) === "read+write" ? "read" : "read+write";
  upsertCommonsMember({
    steward: grant.steward.db.vault,
    grantId: grant.grantId,
    actorPartyId: grant.steward.partyId,
    member: seatInput(seat, capability),
    now: NOW,
  });
  grant.roster.set(seat.index, capability);
  world.trace.push(
    `#${world.step} capability ${grant.key} seat=${seat.index} -> ${capability}`
  );
}

/** Open a steward-transfer window. Writes still addressed at the old steward
 * must park on the fork guard until stewardship comes home. */
function transferAction(world: World, rng: Rng, grant: Grant): void {
  if (grant.awayFor > 0) return;
  const successor = [...grant.roster.entries()].find(
    ([, capability]) => capability === "read+write"
  );
  if (!successor) return;
  const seat = world.seats[successor[0]]!;
  transferCommonsSteward({
    steward: grant.steward.db.vault,
    grantId: grant.grantId,
    actorPartyId: grant.steward.partyId,
    successorPartyId: seat.partyId,
    now: NOW,
  });
  grant.awayFor = 2 + rng.int(6);
  world.trace.push(
    `#${world.step} steward_transfer ${grant.key} -> seat ${seat.index} for ${grant.awayFor} steps`
  );
}

function restoreSteward(world: World, grant: Grant): void {
  transferCommonsSteward({
    steward: grant.steward.db.vault,
    grantId: grant.grantId,
    actorPartyId: grant.steward.partyId,
    successorPartyId: grant.steward.partyId,
    now: NOW,
  });
  grant.awayFor = 0;
  world.trace.push(`#${world.step} steward_restored ${grant.key}`);
}

function runAction(world: World, rng: Rng, name: ActionName): void {
  const grant = rng.pick(world.grants);
  if (!grant) return;
  world.stats[name] = (world.stats[name] ?? 0) + 1;
  switch (name) {
    case "member_intent": {
      const actor = rng.pick(grant.cast);
      if (actor) writeAction(world, rng, grant, actor, false);
      break;
    }
    case "steward_write":
      writeAction(world, rng, grant, grant.steward, false);
      break;
    case "invalid_write": {
      const actor = rng.pick([grant.steward, ...grant.cast]);
      if (actor) writeAction(world, rng, grant, actor, true);
      break;
    }
    case "delete_expense":
      deleteAction(world, rng, grant);
      break;
    case "member_pull": {
      const seat = rng.pick(currentMembers(world, grant));
      if (seat) pull(grant, seat);
      break;
    }
    case "membership_change":
      membershipAction(world, rng, grant);
      break;
    case "capability_change":
      capabilityAction(world, rng, grant);
      break;
    case "steward_transfer":
      transferAction(world, rng, grant);
      break;
    case "compaction":
      compactCommonsOperations(grant.steward.db.vault, grant.grantId);
      break;
    case "crash_restart": {
      const seat = rng.pick(world.seats);
      if (seat) {
        reopenSeat(seat);
        world.trace.push(`#${world.step} crash_restart seat=${seat.index}`);
      }
      break;
    }
    case "snapshot_member": {
      const seat = rng.pick(replicaOnlySeats(world));
      if (seat) {
        snapshotSeat(seat);
        world.trace.push(`#${world.step} snapshot seat=${seat.index}`);
      }
      break;
    }
    case "stale_restore": {
      const seat = rng.pick(
        replicaOnlySeats(world).filter((candidate) => candidate.hasSnapshot)
      );
      if (seat) {
        staleRestoreSeat(seat);
        world.trace.push(`#${world.step} stale_restore seat=${seat.index}`);
      }
      break;
    }
  }
}

function retryParked(world: World): void {
  for (let pass = 0; pass < 2; pass += 1)
    for (const intent of world.parked.splice(0)) {
      const decision = submit(
        world,
        intent.grant,
        intent.actor,
        intent.command,
        intent.commandInput,
        intent.nonce
      );
      const description = intent.commandInput["description"];
      if (typeof description === "string")
        recordWrite(world, intent.grant, intent.actor, description, decision);
      // A parked delete that finally lands still has to move the model, or the
      // oracle would demand a row the steward correctly retired.
      const expenseId = intent.commandInput["expense_id"];
      if (decision.accepted && typeof expenseId === "string")
        for (const fact of intent.grant.expected.values())
          if (fact.expenseId === expenseId) fact.deleted = true;
      world.trace.push(
        `retry ${intent.grant.key} seat=${intent.actor.index} ${intent.nonce} -> ${traceDecision(decision)}`
      );
    }
}

/** Force quiescence: stewardship comes home, every parked intent is retried,
 * and every member pulls to a fixpoint. Anything still divergent afterwards is
 * a real defect, not a race the schedule simply had not finished. */
function quiesce(world: World): void {
  for (const grant of world.grants)
    if (grant.awayFor > 0) restoreSteward(world, grant);
  retryParked(world);
  for (const grant of world.grants)
    compileCommons({
      steward: grant.steward.db,
      stewardVaultId: grant.steward.vaultId,
      grantId: grant.grantId,
      seats: stewardOnly(grant),
      now: NOW,
    });
  for (let round = 0; round < 8; round += 1) {
    let moved = false;
    for (const grant of world.grants)
      for (const seat of grant.cast) if (pull(grant, seat)) moved = true;
    if (!moved) return;
  }
  world.failures.push("members never reached a pull fixpoint in 8 rounds");
}

/** Invariant 2a: every acknowledged write is present at the steward, and no
 * row exists that no acknowledged write put there. */
function checkExpectedRows(world: World, grant: Grant): void {
  const acknowledged = [...grant.expected.entries()]
    .filter(([, fact]) => !fact.deleted)
    .map(([description]) => description)
    .toSorted();
  const actual = (
    grant.steward.db.vault
      .prepare(
        `SELECT description FROM tally_expense
          WHERE group_id = ? AND deleted_at IS NULL ORDER BY description`
      )
      .all(grant.groupId) as { description: string }[]
  ).map((row) => row.description);
  if (JSON.stringify(actual) !== JSON.stringify(acknowledged))
    world.failures.push(
      `${grant.key}: steward rows ${JSON.stringify(actual)} != acknowledged ${JSON.stringify(acknowledged)}`
    );
}

/** Invariant 2b: a refused write leaves nothing behind, anywhere. */
function checkRefusedAbsent(world: World, grant: Grant): void {
  for (const description of grant.refused) {
    if (grant.expected.has(description)) continue;
    for (const seat of [grant.steward, ...grant.cast]) {
      const found = seat.db.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM tally_expense WHERE group_id = ? AND description = ?"
        )
        .get(grant.groupId, description) as { n: number };
      if (found.n !== 0)
        world.failures.push(
          `${grant.key}: refused write "${description}" left ${found.n} row(s) at seat ${seat.index}`
        );
    }
  }
}

/** Invariant 3: no cursor anywhere claims to have seen more than the grant has
 * ever sequenced. */
function checkCursors(world: World, grant: Grant): void {
  const head = readCommonsGrant(
    grant.steward.db.vault,
    grant.grantId
  ).lastSequence;
  for (const seat of [grant.steward, ...grant.cast]) {
    const rows = seat.db.vault
      .prepare(
        "SELECT member_vault_id, sequence FROM share_commons_cursor WHERE grant_id = ?"
      )
      .all(grant.grantId) as { member_vault_id: string; sequence: number }[];
    for (const row of rows)
      if (row.sequence > head)
        world.failures.push(
          `${grant.key}: cursor for ${row.member_vault_id} at seat ${seat.index} is ${row.sequence} > head ${head}`
        );
  }
}

/** Invariant 4a: a deleted item never comes back to life. */
function checkNoResurrection(world: World, grant: Grant): void {
  for (const [description, fact] of grant.expected) {
    if (!fact.deleted) continue;
    for (const seat of [grant.steward, ...grant.cast]) {
      const alive = seat.db.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM tally_expense
            WHERE group_id = ? AND description = ? AND deleted_at IS NULL`
        )
        .get(grant.groupId, description) as { n: number };
      if (alive.n !== 0)
        world.failures.push(
          `${grant.key}: deleted "${description}" resurrected at seat ${seat.index}`
        );
    }
  }
}

/** Invariant 4b: one grant's ops never place rows in another grant's replica
 * scope. A seat holding no place in this grant holds none of its rows either. */
function checkScopeIsolation(world: World, grant: Grant): void {
  for (const seat of world.seats) {
    if (seat.index === grant.steward.index || grant.roster.has(seat.index))
      continue;
    const leaked = seat.db.vault
      .prepare("SELECT COUNT(*) AS n FROM tally_expense WHERE group_id = ?")
      .get(grant.groupId) as { n: number };
    if (leaked.n !== 0)
      world.failures.push(
        `${grant.key}: seat ${seat.index} holds no place yet keeps ${leaked.n} row(s)`
      );
  }
}

/** Invariants 1 and 5: every replica matches the steward's projection, and a
 * replica that does not is in a NAMED parked state rather than silently
 * diverged. The only named state this schedule can produce is
 * `removed-from-roster`, whose tombstone scrubbed the commons on purpose. */
function checkConvergence(world: World, grant: Grant): void {
  const truth = dumpKey(grant.steward.db, grant.groupId);
  for (const seat of grant.cast) {
    const replica = dumpKey(seat.db, grant.groupId);
    if (replica === truth || !grant.roster.has(seat.index)) continue;
    world.failures.push(
      `${grant.key}: seat ${seat.index} diverged with no parked state\n  steward=${truth}\n  replica=${replica}`
    );
  }
}

function checkIntentsSettled(world: World): void {
  for (const seat of world.seats) {
    const pending = seat.db.vault
      .prepare(
        "SELECT COUNT(*) AS n FROM share_commons_intent WHERE status = 'queued'"
      )
      .get() as { n: number };
    if (pending.n !== 0)
      world.failures.push(
        `seat ${seat.index} still holds ${pending.n} unsettled intent(s) after quiescence`
      );
  }
}

/** A world where nothing converged because nothing existed would satisfy every
 * other check vacuously. Demand real replicated rows at a real member seat. */
function checkNonVacuous(world: World): void {
  let replicated = 0;
  for (const grant of world.grants)
    for (const seat of grant.cast)
      if (grant.roster.has(seat.index))
        replicated += dumpGrant(seat.db, grant.groupId).expenses.length;
  if (replicated === 0)
    world.failures.push(
      "no member replica held a single live row — the run proved nothing"
    );
}

function checkInvariants(world: World): void {
  for (const grant of world.grants) {
    checkExpectedRows(world, grant);
    checkRefusedAbsent(world, grant);
    checkCursors(world, grant);
    checkNoResurrection(world, grant);
    checkScopeIsolation(world, grant);
    checkConvergence(world, grant);
  }
  checkIntentsSettled(world);
  checkNonVacuous(world);
}

/** Run one seeded program end to end. Never throws for a domain failure — the
 * report carries the seed, the full action trace, and every broken invariant,
 * so the failing schedule replays exactly. */
export function runCommonsSimulation(options: SimOptions): SimReport {
  const rng = rngFor(options.seed);
  const world = createWorld(options);
  try {
    for (let step = 0; step < options.actions; step += 1) {
      world.step = step;
      for (const grant of world.grants)
        if (grant.awayFor > 0) {
          grant.awayFor -= 1;
          if (grant.awayFor === 0) restoreSteward(world, grant);
        }
      const name = pickAction(rng);
      try {
        runAction(world, rng, name);
      } catch (error) {
        // A throw is data, not control flow: the schedule keeps running so the
        // trace shows what the vault did next, and the report names the step.
        world.failures.push(
          `#${step} ${name} threw: ${error instanceof Error ? error.message : String(error)}`
        );
        world.trace.push(`#${step} ${name} THREW ${String(error)}`);
      }
    }
    world.step = options.actions;
    quiesce(world);
    checkInvariants(world);
  } finally {
    closeWorld(world);
  }
  return {
    seed: options.seed,
    trace: world.trace,
    failures: world.failures,
    stats: world.stats,
  };
}
