/* Steward-absence detection and local Commons instrumentation (#731).
 *
 * The load-bearing claims: absence escalates on ELAPSED SILENCE (not failure
 * count), it never escalates while this device itself cannot show a working
 * link, and the counters the fixed-window-sync decision needs actually move. */

import { describe, expect, test } from "vitest";

import {
  COMMONS_STEWARD_ABSENT_AFTER_MS,
  COMMONS_STEWARD_DEGRADED_AFTER_MS,
  commonsObservabilityForVault,
  readCommonsStewardStatus,
  recordCommonsDeviceReach,
  recordCommonsPull,
} from "./commons-observability.js";
import { pullPeerCommons } from "./peer-commons-client.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import { makeSide } from "./peer-give.test-fixtures.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const GRANT = "grant-under-test";
const SEAT = "vlt_seat";

function at(base: number, offsetMs: number): string {
  return new Date(base + offsetMs).toISOString();
}

function seat(name: string): ReturnType<typeof makeSide>["vault"] {
  return makeSide(name).vault;
}

describe("commons steward-absence detection", () => {
  test("escalates reachable → degraded → absent on elapsed silence", () => {
    const vault = seat("absence-escalation");
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    const pull = (offsetMs: number, ok: boolean) => {
      const now = at(base, offsetMs);
      // A resolved dial — even a refusal — proves the local link works.
      recordCommonsDeviceReach(vault.vault, now);
      return recordCommonsPull({
        db: vault.vault,
        grantId: GRANT,
        memberVaultId: SEAT,
        stewardVaultId: "vlt_steward",
        outcome: ok ? "noop" : "unreachable",
        now,
      });
    };

    expect(pull(0, true).presence).toBe("reachable");
    // Many consecutive failures inside the window are still "reachable": a
    // laptop closed overnight fails a lot and its steward is fine.
    expect(pull(HOUR, false).presence).toBe("reachable");
    expect(pull(2 * HOUR, false).presence).toBe("reachable");
    expect(pull(6 * HOUR, false).consecutiveFailures).toBe(3);

    const degraded = pull(2 * DAY, false);
    expect(degraded.presence).toBe("degraded");
    expect(degraded.silentForMs).toBeGreaterThanOrEqual(
      COMMONS_STEWARD_DEGRADED_AFTER_MS
    );

    const absent = pull(9 * DAY, false);
    expect(absent.presence).toBe("absent");
    expect(absent.silentForMs).toBeGreaterThanOrEqual(
      COMMONS_STEWARD_ABSENT_AFTER_MS
    );
    expect(absent.lastContactAt).toBe(at(base, 0));
    expect(absent.stewardVaultId).toBe("vlt_steward");

    // Contact closes the episode and banks its duration.
    const back = pull(9 * DAY + HOUR, true);
    expect(back.presence).toBe("reachable");
    expect(back.silentForMs).toBeUndefined();
    const summary = commonsObservabilityForVault({
      db: vault,
      vaultId: SEAT,
      now: at(base, 9 * DAY + HOUR),
    });
    expect(summary.grants).toHaveLength(0); // no grant row: counters only
    const status = readCommonsStewardStatus({
      db: vault.vault,
      grantId: GRANT,
      memberVaultId: SEAT,
      now: at(base, 9 * DAY + HOUR),
    });
    expect(status.presence).toBe("reachable");
  });

  test("never cries absence while this device has no working link", () => {
    const vault = seat("absence-offline");
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    // One successful contact, with link evidence, then the device goes dark:
    // every later dial THROWS, so no round trip is ever recorded again.
    recordCommonsDeviceReach(vault.vault, at(base, 0));
    recordCommonsPull({
      db: vault.vault,
      grantId: GRANT,
      memberVaultId: SEAT,
      outcome: "noop",
      now: at(base, 0),
    });
    const fail = (offsetMs: number) =>
      recordCommonsPull({
        db: vault.vault,
        grantId: GRANT,
        memberVaultId: SEAT,
        outcome: "unreachable",
        now: at(base, offsetMs),
      });

    expect(fail(HOUR).presence).toBe("reachable");
    expect(fail(2 * DAY).presence).toBe("link-down");
    // Nine days of failures on a device that cannot show a single round trip
    // is still NOT an absent steward — we simply do not know.
    expect(fail(9 * DAY).presence).toBe("link-down");
    expect(fail(30 * DAY).presence).toBe("link-down");

    // A device that touched the network once and then flew for a week proves
    // nothing either: stale link evidence must not unlock escalation.
    recordCommonsDeviceReach(vault.vault, at(base, 3 * DAY));
    expect(fail(30 * DAY).presence).toBe("link-down");
    // Fresh evidence, gathered while this steward stayed silent, does.
    recordCommonsDeviceReach(vault.vault, at(base, 30 * DAY));
    expect(fail(30 * DAY).presence).toBe("absent");
  });

  test("a named divergence fault parks the seat instead of aging into absence", () => {
    const vault = seat("absence-parked");
    const now = new Date().toISOString();
    recordCommonsDeviceReach(vault.vault, now);
    const parked = recordCommonsPull({
      db: vault.vault,
      grantId: GRANT,
      memberVaultId: SEAT,
      outcome: "parked",
      fault: "history-diverged",
      now,
    });
    expect(parked.presence).toBe("parked");
    expect(parked.fault).toBe("history-diverged");
    // The steward ANSWERED, so this is not an absence episode.
    expect(parked.silentForMs).toBeUndefined();
  });
});

describe("commons sync instrumentation", () => {
  test("counts pull outcomes, reachable ratio and absence durations per grant", () => {
    const vault = seat("instrumentation");
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    const record = (
      offsetMs: number,
      outcome: "noop" | "tail" | "snapshot" | "unreachable"
    ) =>
      recordCommonsPull({
        db: vault.vault,
        grantId: GRANT,
        memberVaultId: SEAT,
        outcome,
        now: at(base, offsetMs),
      });
    record(0, "snapshot");
    record(HOUR, "tail");
    record(2 * HOUR, "unreachable");
    record(3 * HOUR, "unreachable");
    record(4 * HOUR, "noop");
    record(5 * HOUR, "noop");

    const status = readCommonsStewardStatus({
      db: vault.vault,
      grantId: GRANT,
      memberVaultId: SEAT,
      now: at(base, 5 * HOUR),
    });
    expect(status.presence).toBe("reachable");
    expect(status.consecutiveFailures).toBe(0);

    const row = vault.vault
      .prepare(
        `SELECT attempts, contacts, pull_noop, pull_tail, pull_snapshot,
                pull_unreachable, absence_episodes, absent_ms, longest_absence_ms
           FROM share_commons_steward_contact
          WHERE grant_id = ? AND member_vault_id = ?`
      )
      .get(GRANT, SEAT);
    // Spread: node:sqlite hands back a null-prototype row, and toStrictEqual
    // compares prototypes.
    expect({ ...row }).toStrictEqual({
      attempts: 6,
      contacts: 4,
      pull_noop: 2,
      pull_tail: 1,
      pull_snapshot: 1,
      pull_unreachable: 2,
      // One episode: opened at +2h, closed by the contact at +4h.
      absence_episodes: 1,
      absent_ms: 2 * HOUR,
      longest_absence_ms: 2 * HOUR,
    });
  });

  test("summarizes op-log size, member lag and parked-intent dwell per grant", () => {
    const side = makeSide("instrumentation-summary");
    const vault = side.vault;
    const now = new Date().toISOString();
    const created = new Date(Date.parse(now) - 10_000).toISOString();
    vault.vault
      .prepare(
        `INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
         VALUES ('circle-1', ?, 'summary', 'custom')`
      )
      .run(side.ownerPartyId);
    vault.vault
      .prepare(
        `INSERT INTO share_circle_grant
           (grant_id, circle_id, container_type, container_id, plane,
            departure_policy, implicit_circle, steward_party_id, created_at,
            last_sequence, checkpoint_sequence, chain_head_sequence,
            chain_head_hash)
         VALUES (?, ?, 'media.asset', 'asset-1', 'commons',
                 'remove-member-only', 1, ?, ?, 10, 4, 10, 'head')`
      )
      .run(GRANT, "circle-1", side.ownerPartyId, now);
    const op = vault.vault.prepare(
      `INSERT INTO share_commons_op
         (grant_id, sequence, op_id, kind, actor_party_id, outcome, created_at,
          prev_hash, op_hash)
       VALUES (?, ?, ?, 'command', ?, 'executed', ?, 'p', 'h')`
    );
    for (let sequence = 1; sequence <= 10; sequence += 1)
      op.run(GRANT, sequence, `op-${sequence}`, side.ownerPartyId, now);
    const cursor = vault.vault.prepare(
      `INSERT INTO share_commons_cursor (grant_id, member_vault_id, sequence, updated_at)
       VALUES (?, ?, ?, ?)`
    );
    cursor.run(GRANT, "vlt_a", 10, now);
    cursor.run(GRANT, "vlt_b", 3, now);
    const intent = vault.vault.prepare(
      `INSERT INTO share_commons_intent
         (intent_id, grant_id, actor_party_id, command, input_json,
          based_on_sequence, status, created_at, settled_at)
       VALUES (?, ?, ?, 'tally.add', '{}', 0, ?, ?, ?)`
    );
    intent.run("i-1", GRANT, side.ownerPartyId, "executed", created, now);
    intent.run("i-2", GRANT, side.ownerPartyId, "parked", created, null);

    const summary = commonsObservabilityForVault({
      db: vault,
      vaultId: SEAT,
      now,
    });
    expect(summary.grants).toHaveLength(1);
    const grant = summary.grants[0];
    expect(grant?.opLog).toStrictEqual({
      rows: 10,
      lastSequence: 10,
      checkpointSequence: 4,
      beyondCheckpoint: 6,
    });
    expect(grant?.memberLag).toStrictEqual({
      members: 2,
      maxOps: 7,
      p50Ops: 0,
      beyondWindow: 0,
    });
    expect(grant?.intentDwellMs.settled).toBe(1);
    expect(grant?.intentDwellMs.p50).toBe(10_000);
    expect(grant?.intentDwellMs.open).toBe(1);
    expect(grant?.reachableRatio).toBeNull();
    expect(grant?.steward.presence).toBe("unknown");
  });
});

describe("pull path instrumentation", () => {
  const dial = (request: PeerDial["request"]): PeerDial => ({
    request,
    endpointTicketFor: () => "ticket",
  });

  test("a resolved dial records link evidence; a thrown one does not", async () => {
    const vault = seat("pull-link-evidence");
    const answered = await pullPeerCommons({
      dial: dial(async () => ({ status: 404, json: {}, headers: {} })),
      route: { endpointId: "e", relayHints: [] },
      stewardVaultId: "vlt_steward",
      memberVaultId: SEAT,
      grantId: GRANT,
      seat: vault,
    });
    expect(answered.state).toBe("unavailable");
    // The status rides on EVERY outcome — that is the whole point.
    expect(answered.steward.presence).toBe("reachable");
    expect(answered.steward.consecutiveFailures).toBe(1);
    expect(answered.steward.deviceLinkAt).toBeDefined();
    expect(answered.steward.lastError).toBe("steward unreachable");

    const dark = seat("pull-link-dark");
    const thrown = await pullPeerCommons({
      dial: dial(() => Promise.reject(new Error("no route to host"))),
      route: { endpointId: "e", relayHints: [] },
      stewardVaultId: "vlt_steward",
      memberVaultId: SEAT,
      grantId: GRANT,
      seat: dark,
    });
    expect(thrown.state).toBe("unavailable");
    expect(thrown.steward.deviceLinkAt).toBeUndefined();
    expect({
      ...dark.vault
        .prepare("SELECT COUNT(*) AS n FROM share_commons_device_reach")
        .get(),
    }).toStrictEqual({ n: 0 });
  });
});
