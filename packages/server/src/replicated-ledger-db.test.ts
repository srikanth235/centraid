// A WORKER-WRITTEN CONVERSATION REACHES A SEAT (#1014, G4/G22).
//
// The ledger band is opened by PATH, on a connection the gateway does not hold.
// Sessions are per connection, so before the bracket every conversation, turn
// and item a worker wrote was invisible to `replica_log` — expected on the
// phone, and only ever arriving there by a full re-bootstrap.

import { describe, expect, test } from "vitest";

import { ConversationStore } from "@centraid/server/engine";
import { tempDirSync } from "@centraid/test-kit/temp-dir";
import { readReplicaLog, subscribeReplicaCommits } from "@centraid/vault";

import { ledgerDbFileIn } from "./engine/stores/ledger-db.test-fixtures.js";
import { makeReplicatedLedgerDbProvider } from "./replicated-ledger-db.js";

function ledgerFile(): string {
  return ledgerDbFileIn(tempDirSync("centraid-replicated-ledger-"));
}

describe("the ledger band brackets its own writes", () => {
  test("a conversation and its turn are in replica_log, produced by the ledger", () => {
    const provider = makeReplicatedLedgerDbProvider(ledgerFile());
    const store = new ConversationStore(provider);
    const conversationId = store.ensureAutomationConversation(
      "mail/digest",
      "mail"
    );
    store.insertTurn({
      turnId: "t-1",
      conversationId,
      triggerKind: "scheduled",
      startedAt: 1,
    });
    store.finishTurn({ turnId: "t-1", endedAt: 2, ok: true });

    const rows = readReplicaLog(provider()).rows;
    const tables = new Set(rows.map((row) => row.table));
    expect(tables.has("conversations")).toBe(true);
    expect(tables.has("turns")).toBe(true);
    expect(
      rows.every((row) => row.producer === "ledger"),
      "every row this connection logged names the ledger as its producer"
    ).toBe(true);
    provider().close();
  });

  test("the doorbell rings on the connection the worker writes through", () => {
    const provider = makeReplicatedLedgerDbProvider(ledgerFile());
    const store = new ConversationStore(provider);
    let rings = 0;
    const stop = subscribeReplicaCommits(provider(), () => {
      rings += 1;
    });
    store.ensureAutomationConversation("mail/digest", "mail");
    stop();
    expect(rings).toBeGreaterThan(0);
    provider().close();
  });
});
