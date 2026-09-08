/*
 * The on-behalf-of cap (#599 decision 7; ownership since #726).
 *
 * An agent turn acts FOR an owner and is hard-capped at that owner's
 * authority in the vault — ownership: Sid's assistant must fail exactly
 * where Sid would. The owner and whether they own the vault travel on the
 * request scope (`vault-context.ts`), reach the agent credential in
 * `VaultPlane.agentBridgeFor`, and the vault's consent stage enforces the
 * cap and journals both principals.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";

import { describe, afterEach, expect, test } from "vitest";

import type { VaultBridge } from "@centraid/server/engine";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { runWithVaultContext } from "./vault-context.js";
import { openVaultPlane } from "./vault-plane.js";
import type { VaultPlane } from "./vault-plane.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];
const SID = "owner-sid-01";
describe("agent-owner-cap suite", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function plane(): Promise<VaultPlane> {
    const dir = await tempDir(`agent-cap-${crypto.randomUUID()}-`);
    const opened = openVaultPlane({
      bootstrap: true,
      dir,
      logger,
      enableWalShipper: false,
    });
    cleanups.push(
      () => fs.rm(dir, { recursive: true, force: true }),
      () => opened.stop()
    );
    opened.approveAgentGrant("digest", {
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });
    return opened;
  }

  /** The automation's `ctx.vault`, built inside the acting owner's scope. */
  function bridgeAs(vault: VaultPlane, ownsVault: boolean): VaultBridge {
    return runWithVaultContext(
      {
        vaultId: vault.boot.vaultId,
        deviceKey: "sid-phone",
        ownerId: SID,
        ownsVault,
      },
      () => vault.agentBridgeFor("digest")
    );
  }

  function taskCount(vault: VaultPlane): number {
    return (
      vault.db.vault
        .prepare("SELECT count(*) AS n FROM schedule_task")
        .get() as {
        n: number;
      }
    ).n;
  }

  function lastReceipt(vault: VaultPlane): {
    decision: string;
    detail: Record<string, unknown>;
  } {
    const row = vault.db.audit
      .prepare(
        `SELECT decision, detail_json FROM access_receipt
        WHERE action = 'act schedule.add_task' ORDER BY receipt_id DESC LIMIT 1`
      )
      .get() as { decision: string; detail_json: string | null };
    return {
      decision: row.decision,
      detail: JSON.parse(row.detail_json ?? "{}"),
    };
  }

  const addTask = {
    op: "invoke" as const,
    payload: { command: "schedule.add_task", input: {} },
  };

  test("an agent for a non-owning caller is refused the write, and the row names both", async () => {
    const vault = await plane();

    const result = await bridgeAs(
      vault,
      false
    )({
      ...addTask,
      payload: { command: "schedule.add_task", input: { title: "refused" } },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected agent bridge execution result");
    expect(result.result).toMatchObject({ status: "denied" });
    expect(taskCount(vault)).toBe(0);
    const receipt = lastReceipt(vault);
    expect(receipt.decision).toBe("deny");
    // "agent, for <owner>": the owner on the receipt, the agent on provenance
    // and the invocation's caller id.
    expect(receipt.detail).toMatchObject({ actingOwner: SID });
    expect(String(receipt.detail.failing)).toContain(SID);
  });

  test("the same agent for the vault's owner executes exactly the same call", async () => {
    const vault = await plane();

    const result = await bridgeAs(
      vault,
      true
    )({
      ...addTask,
      payload: { command: "schedule.add_task", input: { title: "allowed" } },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected agent bridge execution result");
    expect(result.result).toMatchObject({ status: "executed" });
    expect(taskCount(vault)).toBe(1);
    const receipt = lastReceipt(vault);
    expect(receipt.decision).toBe("allow");
    expect(receipt.detail).toMatchObject({ actingOwner: SID });
  });

  test("a revoked binding caps the agent to nothing, not to the vault owner", async () => {
    const vault = await plane();

    const result = await bridgeAs(
      vault,
      false
    )({
      ...addTask,
      payload: {
        command: "schedule.add_task",
        input: { title: "stolen phone" },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected agent bridge execution result");
    expect(result.result).toMatchObject({ status: "denied" });
    expect(taskCount(vault)).toBe(0);
  });

  test("the cap never touches reads — a non-owner still sees through their agent", async () => {
    const vault = await plane();

    const result = await bridgeAs(
      vault,
      false
    )({
      op: "read",
      payload: { entity: "schedule.task" },
    });

    expect(result.ok).toBe(true);
  });

  test("an automation with no owner behind it is uncapped, exactly as before", async () => {
    const vault = await plane();

    // A scheduler fire enters a vault scope with no request and no owner.
    const result = await runWithVaultContext(
      { vaultId: vault.boot.vaultId },
      () => vault.agentBridgeFor("digest")
    )({
      ...addTask,
      payload: {
        command: "schedule.add_task",
        input: { title: "nightly digest" },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected agent bridge execution result");
    expect(result.result).toMatchObject({ status: "executed" });
    expect(lastReceipt(vault).detail).not.toHaveProperty("actingOwner");
  });
});
