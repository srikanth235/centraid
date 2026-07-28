/*
 * Revise serialization + prompt/handler atomicity (issue #541 review).
 *
 * Regressions guarded:
 *  - two revises interleaving, so the second publish drops the first;
 *  - a failed compile (or a rewrite that throws after its publish) leaving the
 *    published prompt ahead of the compiled handler with nothing to reconcile.
 */

import {
  validateManifest,
  type Row as AutomationRow,
} from "@centraid/automation";
import { describe, expect, test } from "vitest";

import { reviseAutomationInstructions } from "./automation-revision.js";

function row(prompt = "Summarize account changes."): AutomationRow {
  const manifest = validateManifest({
    name: "Daily brief",
    version: "0.1.0",
    enabled: true,
    prompt,
    triggers: [],
    history: { keep: { count: 10 } },
    generated: { by: "test", at: "2026-07-25T00:00:00.000Z" },
  });
  return {
    id: "main",
    dir: "/tmp/brief",
    name: manifest.name,
    triggers: manifest.triggers,
    enabled: manifest.enabled,
    ownerApp: "brief",
    ref: "brief/main",
    manifest,
  };
}

interface Harness {
  published: string[];
  rolledBack: string[];
  failed: string[];
}

function deps(
  overrides: Partial<Parameters<typeof reviseAutomationInstructions>[0]> = {}
): {
  deps: Parameters<typeof reviseAutomationInstructions>[0];
  out: Harness;
} {
  const out: Harness = { published: [], rolledBack: [], failed: [] };
  return {
    out,
    deps: {
      row: row(),
      conversationLocks: new Map<string, Promise<void>>(),
      publishPrompt: async (prompt) => {
        out.published.push(prompt);
      },
      rewrite: async (persistPrompt) => {
        await persistPrompt("Revised: only customer messages.");
      },
      compile: async () => ({ ok: true }),
      onRolledBack: (detail) => out.rolledBack.push(detail),
      onFailed: (message) => out.failed.push(message),
      ...overrides,
    },
  };
}

describe("automation-revision", () => {
  test("a successful revise publishes once and keeps the new instructions", async () => {
    const { deps: input, out } = deps();
    await reviseAutomationInstructions(input);
    expect(out.published).toStrictEqual(["Revised: only customer messages."]);
    expect(out.rolledBack).toStrictEqual([]);
    expect(out.failed).toStrictEqual([]);
  });

  test("a failed compile restores the previous instructions and says so in the thread", async () => {
    const { deps: input, out } = deps({
      compile: async () => ({
        ok: false,
        error: "handler.js did not validate",
      }),
    });
    await reviseAutomationInstructions(input);
    // Publish new, then publish the ORIGINAL back — the enabled automation is
    // never left firing the old handler under new instructions.
    expect(out.published).toStrictEqual([
      "Revised: only customer messages.",
      "Summarize account changes.",
    ]);
    expect(out.rolledBack).toStrictEqual([
      expect.stringContaining("handler.js did not validate"),
    ]);
    expect(out.rolledBack[0]).toContain("previous instructions were restored");
  });

  test("a rewrite that throws AFTER publishing still rolls back", async () => {
    const { deps: input, out } = deps({
      rewrite: async (persistPrompt) => {
        await persistPrompt("Revised: only customer messages.");
        throw new Error("ledger write failed");
      },
    });
    await reviseAutomationInstructions(input);
    expect(out.published).toStrictEqual([
      "Revised: only customer messages.",
      "Summarize account changes.",
    ]);
    expect(out.failed).toStrictEqual(["ledger write failed"]);
    expect(out.rolledBack[0]).toContain("Instruction revision failed");
  });

  test("a rewrite that fails BEFORE publishing reports the failure and publishes nothing", async () => {
    const { deps: input, out } = deps({
      rewrite: async () => {
        throw new Error("No automation agent is configured.");
      },
    });
    await reviseAutomationInstructions(input);
    expect(out.published).toStrictEqual([]);
    expect(out.rolledBack).toStrictEqual([]);
    expect(out.failed).toStrictEqual(["No automation agent is configured."]);
  });

  test("a roll-back that ALSO fails is reported as a divergence, not silently dropped", async () => {
    const out: Harness = { published: [], rolledBack: [], failed: [] };
    let publishes = 0;
    await reviseAutomationInstructions({
      row: row(),
      conversationLocks: new Map<string, Promise<void>>(),
      publishPrompt: async (prompt) => {
        publishes += 1;
        if (publishes > 1) throw new Error("git publish rejected");
        out.published.push(prompt);
      },
      rewrite: async (persistPrompt) => {
        await persistPrompt("Revised: only customer messages.");
      },
      compile: async () => ({ ok: false, error: "compile agent errored" }),
      onRolledBack: (detail) => out.rolledBack.push(detail),
      onFailed: (message) => out.failed.push(message),
    });
    expect(out.rolledBack[0]).toContain("git publish rejected");
    expect(out.rolledBack[0]).toContain("does not match the published prompt");
  });

  test("two revises on one automation serialize instead of interleaving", async () => {
    const conversationLocks = new Map<string, Promise<void>>();
    const order: string[] = [];
    const revise = (label: string, rewriteDelayMs: number): Promise<void> =>
      reviseAutomationInstructions({
        row: row(),
        conversationLocks,
        publishPrompt: async (prompt) => {
          order.push(`publish:${label}:${prompt}`);
        },
        rewrite: async (persistPrompt) => {
          order.push(`rewrite-start:${label}`);
          await new Promise((resolve) => setTimeout(resolve, rewriteDelayMs));
          await persistPrompt(`prompt-${label}`);
        },
        compile: async () => {
          order.push(`compile:${label}`);
          return { ok: true };
        },
        onRolledBack: () => undefined,
        onFailed: () => undefined,
      });

    // The slow one starts first; without the lock its publish would land AFTER
    // the fast one's and silently drop it.
    await Promise.all([revise("slow", 20), revise("fast", 0)]);
    expect(order).toStrictEqual([
      "rewrite-start:slow",
      "publish:slow:prompt-slow",
      "compile:slow",
      "rewrite-start:fast",
      "publish:fast:prompt-fast",
      "compile:fast",
    ]);
    // The lock entry is released once the queue drains.
    expect(conversationLocks.size).toBe(0);
  });

  test("the revise holds the same lock the interactive turn takes", async () => {
    const conversationLocks = new Map<string, Promise<void>>();
    let observed = 0;
    const { deps: input } = deps({
      conversationLocks,
      rewrite: async (persistPrompt) => {
        observed = conversationLocks.size;
        await persistPrompt("Revised: only customer messages.");
      },
    });
    await reviseAutomationInstructions(input);
    // `withConversationLock` keys on `${appId}::${conversationId}` — the same
    // key `runInteractiveAutomationTurn` uses for this automation.
    expect(observed).toBe(1);
    expect(conversationLocks.size).toBe(0);
  });
});
