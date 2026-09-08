// IDENTITY SCENARIOS — a provider-local id is scoped to its SOURCE
// (#996 wave 0b, ruling R20(c)).
//
// `core_transaction.external_id` carried a GLOBAL `UNIQUE` while the comment
// five lines above it said the right key is `(connection_id, external_id)`,
// and the transaction publisher probed that global column whenever the sync
// map missed. Two banks both call a statement line `ref-1`, so Bank B's
// statement silently merged into Bank A's row: one transaction where the owner
// has two, and the money is simply gone from the ledger.
//
// Driven through the real import path (`stageImportFile` → `publishImport`)
// and read through the real rows the Tally and Finance readers select.

import { beforeEach, afterEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

/** One statement line, referenced `ref-1` by whichever bank produced it. */
const STATEMENT = [
  "Date,Description,Amount,Reference",
  "2026-07-01,Grocers,-1842.50,ref-1",
].join("\n");

describe("core.transaction — a provider id is scoped to its source", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  afterEach(() => {
    db.close();
  });

  function importStatement(filename: string, accountName: string) {
    const staged = gw.stageImportFile(owner, {
      filename,
      data: STATEMENT,
      accountName,
      currency: "INR",
    });
    const published = gw.publishImport(owner, staged.batchId);
    return { staged: staged.staged, published };
  }

  test("Bank A and Bank B may both import ref-1 without merging", () => {
    const first = importStatement("bank-a-june.csv", "Bank A Savings");
    expect(first.staged).toMatchObject({ create: 1 });
    expect(first.published.created).toBe(1);

    // A DIFFERENT source — its own connection, its own external-id namespace.
    const second = importStatement("bank-b-june.csv", "Bank B Current");
    expect(second.staged).toMatchObject({ create: 1, skip: 0 });
    expect(second.published.created).toBe(1);

    const rows = db.vault
      .prepare(
        `SELECT t.external_id, a.name AS account
           FROM core_transaction t
           JOIN core_account a ON a.account_id = t.account_id
          WHERE t.external_id = 'ref-1'
          ORDER BY a.name`
      )
      .all() as { external_id: string; account: string }[];
    expect(rows.map((row) => row.account)).toStrictEqual([
      "Bank A Savings",
      "Bank B Current",
    ]);

    // The sync map is where the identity claim lives, and it is per source:
    // one mapping per connection, both naming the same provider string.
    const mappings = db.vault
      .prepare(
        `SELECT count(DISTINCT connection_id) AS connections,
                count(*) AS rows_mapped
           FROM sync_external_entity
          WHERE external_id = 'ref-1' AND target_type = 'core.transaction'`
      )
      .get() as { connections: number; rows_mapped: number };
    expect(mappings.connections).toBe(2);
    expect(mappings.rows_mapped).toBe(2);
  });

  test("re-importing the same source is still idempotent", () => {
    // Removing the global constraint did not remove dedupe: idempotency is the
    // sync map's `(connection_id, external_id)`, which is where it always was.
    expect(
      importStatement("bank-a-june.csv", "Bank A Savings").staged
    ).toMatchObject({ create: 1 });
    const again = gw.stageImportFile(owner, {
      filename: "bank-a-june.csv",
      data: STATEMENT,
      accountName: "Bank A Savings",
      currency: "INR",
    });
    expect(again.staged).toMatchObject({ create: 0, skip: 1 });

    const count = db.vault
      .prepare(
        "SELECT count(*) AS n FROM core_transaction WHERE external_id = 'ref-1'"
      )
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});
