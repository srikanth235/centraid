/**
 * TALLY IN AIRPLANE MODE (#922 E7).
 *
 * The promise this lane makes: a member on a plane opens Tally and sees the
 * whole ledger — every friend's net, both totals, the groups and the recurring
 * templates — not a spinner and not an empty state that looks settled. Until
 * this lane the seat asked the gateway for those figures, so the honest answer
 * offline was nothing.
 *
 * Airplane mode is produced, not posed. `lib/gateway` — the module every RPC
 * on this seat goes through — is replaced by one that THROWS from every door,
 * so a read that reached for the network would fail loudly rather than quietly
 * succeeding against a test double. The read plane is a real replica database
 * seeded with the ledger fixture, opened through the same mounted reader the
 * provider builds on a device.
 */
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { MultiVaultReplicaReader } from "../../lib/replica/multi-vault-reader";
import { NodeSqliteDriver } from "../../lib/replica/node-sqlite-driver";
import {
  FRIENDS,
  OWNER,
  VAULT_ID,
  seedScope,
} from "../../lib/replica/tally-ledger.test-fixtures";
import { attachTallyReadPlane } from "./tally-reads";
import {
  loadTallyActivity,
  loadTallyGroup,
  openTally,
  readTallyVault,
  resetTallyVault,
  searchTally,
} from "./tally-store";
import { tallyScreenState } from "./tally-view-model";

// No network exists. Any door this seat could reach for throws.
vi.mock(import("../../lib/gateway"), () => {
  const refuse = (): never => {
    throw new Error("airplane mode: no gateway is reachable");
  };
  return new Proxy({} as never, { get: () => refuse });
});

let reader: MultiVaultReplicaReader | undefined;

describe("Tally on a plane", () => {
  beforeEach(() => {
    const root = tempDirSync("centraid-tally-airplane-");
    const databaseName = path.join(root, "personal.db");
    seedScope(databaseName);
    reader = new MultiVaultReplicaReader(
      new NodeSqliteDriver(path.join(root, "mounted.db")),
      [{ vaultId: VAULT_ID, label: "Personal", canWrite: true, databaseName }]
    );
    attachTallyReadPlane({
      read: reader.read.bind(reader),
      search: reader.search.bind(reader),
    });
  });

  afterEach(() => {
    attachTallyReadPlane(undefined);
    reader?.close();
    reader = undefined;
    resetTallyVault();
  });

  test("the home lands a complete dashboard with no gateway at all", async () => {
    await openTally();
    const state = readTallyVault();

    expect(state.readError).toBe("");
    expect(state.loaded).toBe(true);
    expect(state.denied).toBeNull();
    expect(state.dashboard.me).toBe(OWNER);
    expect(state.dashboard.currency).toBe("GBP");
    // COMPLETE, not partial: every friend in the ledger, with real arithmetic
    // behind them, and both directions of the totals.
    expect(
      state.dashboard.friends.map((friend) => friend.party_id).sort()
    ).toStrictEqual([...FRIENDS].sort());
    expect(
      state.dashboard.friends.every((friend) => friend.net_minor !== 0)
    ).toBe(true);
    expect(
      state.dashboard.owe_total_minor + state.dashboard.owed_total_minor
    ).toBeGreaterThan(0);
    expect(state.dashboard.groups).toHaveLength(1);
    expect(state.dashboard.recurring).toHaveLength(1);
    expect(state.dashboard.trash).toHaveLength(1);
  });

  test("the screen is a ledger, not a delay or an emptiness", async () => {
    await openTally();
    const state = readTallyVault();
    expect(
      tallyScreenState({
        conflicted: false,
        denied: state.denied !== null,
        loaded: state.loaded,
        // The device IS offline. That is the notice; it is not the ledger.
        online: true,
        parked: false,
        pending: 0,
        rows: state.dashboard.friends.length,
        nets: state.dashboard.friends.map((friend) => friend.net_minor),
      })
    ).toBe("ready");
  });

  test("the routes beside the spine read too", async () => {
    await openTally();
    await loadTallyActivity();
    await loadTallyGroup("group-flat");
    await searchTally("Expense 1");
    const state = readTallyVault();

    expect(state.readError).toBe("");
    expect(state.activity?.activity.length).toBeGreaterThan(0);
    expect(state.group?.group?.group_id).toBe("group-flat");
    expect(state.search.data?.results.length).toBeGreaterThan(0);
  });

  test("a seat with no replica mounted says so instead of showing an empty ledger", async () => {
    attachTallyReadPlane(undefined);
    resetTallyVault();
    await openTally();
    const state = readTallyVault();
    expect(state.loaded).toBe(false);
    expect(state.readError).toContain("mounting");
  });
});
