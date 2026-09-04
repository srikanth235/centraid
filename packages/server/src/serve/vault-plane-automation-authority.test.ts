/*
 * #928 wave 3a. An automation's standing answer is a `share_authority` row,
 * the owner's refusal survives as a `declined` row, and a widened manifest
 * still parks instead of answering itself.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { automationAnswers, automationSubjectsOf } from "@centraid/vault";

import { openVaultPlane } from "./vault-plane.js";
import type { VaultPlane } from "./vault-plane.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

const BLOCK = {
  purpose: "dpv:ServiceProvision",
  scopes: [
    { schema: "schedule", verbs: "read+act" as const },
    { schema: "core", table: "party", verbs: "read" as const },
    { schema: "locker", table: "item", verbs: "reveal" as const },
  ],
};

function answerFacts(plane: VaultPlane, principalId: string): string[] {
  return automationAnswers(plane.db.vault, principalId).map(
    (row) => `${row.decision} ${row.subjectType} ${row.subjectId} ${row.verb}`
  );
}

describe("an automation is a principal in the one plane", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function plane(dir?: string): Promise<VaultPlane> {
    const at =
      dir ?? (await tempDir(`automation-auth-${crypto.randomUUID()}-`));
    const opened = openVaultPlane({
      bootstrap: true,
      dir: at,
      logger,
      enableWalShipper: false,
    });
    cleanups.push(() => opened.stop());
    if (!dir) cleanups.push(() => fs.rm(at, { recursive: true, force: true }));
    return opened;
  }

  test("a pack scope answers agent.pack, an entity scope core.entity, reveal neither", () => {
    expect(automationSubjectsOf(BLOCK.scopes)).toStrictEqual([
      { subjectType: "agent.pack", subjectId: "schedule", verb: "read" },
      { subjectType: "agent.pack", subjectId: "schedule", verb: "act" },
      { subjectType: "core.entity", subjectId: "core.party", verb: "read" },
    ]);
  });

  test("installing an automation mints one granted row per pack-or-entity x verb", async () => {
    const vault = await plane();
    vault.ensureAgentInstallGrant("digest", BLOCK);
    expect(answerFacts(vault, "digest")).toStrictEqual([
      "granted agent.pack schedule act",
      "granted agent.pack schedule read",
      "granted core.entity core.party read",
    ]);
    // The Approvals read: the surface sees the answers beside the agent.
    const agent = vault.listAgents().find((a) => a.enrollmentKey === "digest");
    expect(agent?.answers).toHaveLength(3);
  });

  test("a widened manifest parks: it answers nothing until the owner decides", async () => {
    const vault = await plane();
    vault.ensureAgentInstallGrant("digest", BLOCK);
    vault.ensureAgentInstallGrant("digest", {
      ...BLOCK,
      scopes: [...BLOCK.scopes, { schema: "media", verbs: "read" as const }],
    });
    expect(answerFacts(vault, "digest")).not.toContain(
      "granted agent.pack media read"
    );
    const parked = vault
      .listScopeRequests()
      .find((request) => request.appId === "digest");
    expect(parked).toBeDefined();

    vault.decideScopeRequest(parked!.requestId, false);
    // A refusal is an ANSWER, not an absent grant.
    expect(answerFacts(vault, "digest")).toContain(
      "declined agent.pack media read"
    );
  });

  test("the owner's yes on a parked widening becomes a granted row", async () => {
    const vault = await plane();
    vault.ensureAgentInstallGrant("digest", BLOCK);
    vault.ensureAgentInstallGrant("digest", {
      ...BLOCK,
      scopes: [...BLOCK.scopes, { schema: "media", verbs: "read" as const }],
    });
    const parked = vault
      .listScopeRequests()
      .find((request) => request.appId === "digest")!;
    vault.decideScopeRequest(parked.requestId, true);
    expect(answerFacts(vault, "digest")).toContain(
      "granted agent.pack media read"
    );
  });

  test("uninstalling the automation ends its answers", async () => {
    const vault = await plane();
    vault.ensureAgentInstallGrant("digest", BLOCK);
    vault.revokeApp("digest");
    expect(answerFacts(vault, "digest")).toStrictEqual([]);
  });

  /*
   * THE MIGRATION. A vault whose automation authority lives only in the app
   * plane is opened again; the answers must appear with the same content, and
   * the owner's refusal must survive as `declined`. Seeded by deleting the
   * rows the first open wrote, which is exactly the pre-#928 state.
   */
  test("re-opening a vault backfills automation grants and refusals losslessly", async () => {
    const dir = await tempDir(`automation-migrate-${crypto.randomUUID()}-`);
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const first = await plane(dir);
    first.ensureAgentInstallGrant("digest", BLOCK);
    first.ensureAgentInstallGrant("digest", {
      ...BLOCK,
      scopes: [...BLOCK.scopes, { schema: "media", verbs: "read" as const }],
    });
    const parked = first
      .listScopeRequests()
      .find((request) => request.appId === "digest")!;
    first.decideScopeRequest(parked.requestId, false);
    const expected = answerFacts(first, "digest").toSorted();
    expect(expected).toStrictEqual([
      "declined agent.pack media read",
      "granted agent.pack schedule act",
      "granted agent.pack schedule read",
      "granted core.entity core.party read",
    ]);
    const openRequests = first.listScopeRequests().length;
    // The pre-#928 state: grants and tombstones, no answers.
    first.db.vault.exec(
      `DELETE FROM share_authority WHERE principal_kind = 'automation'`
    );
    expect(automationAnswers(first.db.vault)).toStrictEqual([]);
    first.stop();

    const second = await plane(dir);
    expect(answerFacts(second, "digest").toSorted()).toStrictEqual(expected);
    // Lossless: the legacy rows are still there for wave 4 to delete, and a
    // parked ask is not an answer, so it survives the migration unanswered.
    expect(
      second.db.vault
        .prepare(`SELECT count(*) AS n FROM access_grant_scope`)
        .get()
    ).toMatchObject({ n: expect.any(Number) });
    expect(second.listScopeRequests()).toHaveLength(openRequests);
    // One-shot: a third open adds nothing.
    const after = answerFacts(second, "digest").toSorted();
    second.stop();
    const third = await plane(dir);
    expect(answerFacts(third, "digest").toSorted()).toStrictEqual(after);
  });

  test("the assistant is never given a standing answer by the migration", async () => {
    const dir = await tempDir(`automation-assistant-${crypto.randomUUID()}-`);
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const first = await plane(dir);
    first.approveAgentGrant("_assistant", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "act" }],
    });
    first.db.vault.exec(
      `DELETE FROM share_authority WHERE principal_kind = 'automation'`
    );
    first.stop();
    const second = await plane(dir);
    expect(answerFacts(second, "_assistant")).toStrictEqual([]);
  });
});
