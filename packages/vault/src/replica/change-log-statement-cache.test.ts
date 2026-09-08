import { afterEach, describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import {
  appendReplicaChange,
  beginReplicaCommit,
  currentReplicaLogState,
  endReplicaCommit,
  initializeReplicaProtocol,
  readReplicaChanges,
} from "./change-log.js";

// NO UNCACHED PREPARE ON THE CHANGE PATH (#922 A3).
//
// `readReplicaRow` and the projection loop run once per commit per subscribed
// device, so a statement the change log re-compiles on every pass is paid per
// device per commit. This counts `prepare` calls made by the change log itself
// after a warm-up pass: the SQL it issues is FIXED TEXT, so the second pass
// must compile nothing at all.

let db: VaultDb | undefined;

describe("change-log statement cache", () => {
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  /** Every SQL text the change log compiles while `work` runs. */
  function compiledDuring(vault: VaultDb["vault"], work: () => void): string[] {
    const compiled: string[] = [];
    const original = vault.prepare.bind(vault);
    const spy = (sql: string): ReturnType<typeof original> => {
      compiled.push(sql);
      return original(sql);
    };
    (vault as unknown as { prepare: unknown }).prepare = spy;
    try {
      work();
    } finally {
      (vault as unknown as { prepare: unknown }).prepare = original;
    }
    return compiled;
  }

  test("a warm change-log pass compiles nothing", () => {
    db = openVaultDb();
    const vault = db.vault;
    initializeReplicaProtocol(vault);

    const pass = (title: string): void => {
      const handle = beginReplicaCommit(vault);
      appendReplicaChange(vault, {
        entity: "core.concept_scheme",
        rowId: title,
        op: "insert",
      });
      endReplicaCommit(vault, handle);
      currentReplicaLogState(vault);
      readReplicaChanges(vault, { limit: 10 });
    };

    // Warm-up: the first pass is allowed to compile every statement once.
    const cold = compiledDuring(vault, () => pass("row-1"));
    expect(cold.length).toBeGreaterThan(0);

    const warm = compiledDuring(vault, () => pass("row-2"));
    expect(warm, `recompiled: ${warm.join(" | ")}`).toStrictEqual([]);
  });
});
