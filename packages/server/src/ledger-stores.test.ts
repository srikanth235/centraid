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
