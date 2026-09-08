// The fixture the Tally #872 ledger suites share (`tally-ledger.test.ts` and
// `tally-ledger-groups.test.ts`). `refusal` is why this is a module: a refusal
// arrives as `denied` when a PRECONDITION caught it and as `failed` when the
// handler's own guard threw and rolled back; both files accept either.

import { expect } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../gateway/types.js";
import { registerTallyCommands } from "./tally.js";

export interface TallyLedgerFixture {
  db: VaultDb;
  gw: Gateway;
  owner: Credential;
  me: string;
  invoke: (command: string, input: Record<string, unknown>) => InvokeOutcome;
  out: <T = Record<string, unknown>>(outcome: InvokeOutcome) => T;
  refusal: (outcome: InvokeOutcome) => string;
  addFriend: (name: string) => string;
  group: (members: string[], name?: string) => string;
}

export function tallyLedgerFixture(): TallyLedgerFixture {
  const db = openVaultDb();
  const boot = bootstrapVault(db, { ownerName: "Alex" });
  const gw = createGateway(db);
  registerTallyCommands(gw);
  const owner: Credential = {
    kind: "device",
    deviceId: boot.deviceId,
    deviceKey: boot.deviceKey,
  };
  const me = (
    db.vault
      .prepare("SELECT self_party_id AS id FROM core_vault LIMIT 1")
      .get() as { id: string }
  ).id;
  const invoke = (
    command: string,
    input: Record<string, unknown>
  ): InvokeOutcome => gw.invoke(owner, { command, input });
  const out = <T = Record<string, unknown>>(outcome: InvokeOutcome): T => {
    expect(outcome.status).toBe("executed");
    return (outcome as unknown as { output: T }).output;
  };
  return {
    db,
    gw,
    owner,
    me,
    invoke,
    out,
    refusal: (outcome: InvokeOutcome): string => {
      expect(["denied", "failed"]).toContain(outcome.status);
      return (outcome as { reason?: string }).reason ?? "";
    },
    addFriend: (name: string) =>
      out<{ party_id: string }>(invoke("tally.add_friend", { name })).party_id,
    group: (members: string[], name = "Trip") =>
      out<{ group_id: string }>(
        invoke("tally.create_group", { name, icon: "✈️", member_ids: members })
      ).group_id,
  };
}
