/*
 * The per-journal-file store memo (#541 review). The regression this
 * guards: a fresh `makeLedgerDbProvider` per fire leaks one `DatabaseSync`
 * (plus a 64 MiB mapping and an fd) every time, because
 * `ConversationStore.close()` is a no-op on a host-owned connection.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { ledgerDbFileIn } from "./engine/stores/ledger-db.test-fixtures.js";
import {
  closeLedgerConversationStores,
  ledgerConversationStore,
} from "./ledger-stores.js";

const dirs: string[] = [];
describe("ledger-stores", () => {
  afterEach(async () => {
    closeLedgerConversationStores();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  async function ledgerFile(): Promise<string> {
    const dir = await tempDir("gw-ledger-memo-");
    dirs.push(dir);
    return ledgerDbFileIn(dir);
  }

  test("one vault file yields one shared store, however many callers ask", async () => {
    const file = await ledgerFile();
    const first = ledgerConversationStore(file);
    const second = ledgerConversationStore(file);
    // Path form must not mint a second handle either — the fire path passes a
    // workspace-derived path, the compile path a differently-joined one.
    const third = ledgerConversationStore(
      path.join(path.dirname(file), ".", "vault.db")
    );
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  test("distinct vaults keep distinct stores", async () => {
    const one = await ledgerFile();
    const two = await ledgerFile();
    expect(ledgerConversationStore(two)).not.toBe(ledgerConversationStore(one));
  });

  test("shutdown closes the handle and a later caller gets a working store", async () => {
    const file = await ledgerFile();
    const before = ledgerConversationStore(file);
    const conversationId = before.ensureAutomationConversation(
      "app/auto",
      "app",
      "Auto",
      "claude-code"
    );
    closeLedgerConversationStores();
    const after = ledgerConversationStore(file);
    expect(after).not.toBe(before);
    // The reopened store still reads what the closed one durably wrote — the
    // close released a handle, it did not lose the ledger.
    expect(
      after.ensureAutomationConversation(
        "app/auto",
        "app",
        "Auto",
        "claude-code"
      )
    ).toBe(conversationId);
  });
});
