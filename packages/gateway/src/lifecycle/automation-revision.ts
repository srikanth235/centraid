/*
 * Revise orchestration (issue #541 review).
 *
 * Two properties this module exists to hold, both of which the inline
 * fire-and-forget version got wrong:
 *
 * 1. SERIALIZED. A revise snapshots the automation's manifest, rewrites the
 *    prompt, and publishes. Two revises seconds apart both snapshotted the
 *    PRE-revision manifest and the second publish silently dropped the first,
 *    while their turns interleaved in one automation conversation. Everything
 *    runs under the same per-`(app, conversation)` lock the interactive turn
 *    already takes, so a steering message queues behind a revise too.
 *
 * 2. TRANSACTIONAL. The published prompt and the compiled `handler.js` are one
 *    unit. Publishing the prompt first and compiling separately left an
 *    enabled automation firing the OLD handler on schedule while the manifest
 *    and UI showed the NEW instructions, with nothing to reconcile it. If the
 *    compile fails — or the rewrite throws after its publish — the previous
 *    instructions are restored and the roll-back is reported into the thread.
 */

import { withConversationLock } from '@centraid/app-engine';
import type { Row as AutomationRow } from '@centraid/automation';

export interface AutomationRevisionDeps {
  row: AutomationRow;
  /** Serialization map shared with the interactive-turn path. */
  conversationLocks: Map<string, Promise<void>>;
  /** Publish the automation's standing instructions onto `main`. */
  publishPrompt: (prompt: string, message: string) => Promise<void>;
  /**
   * Run the rewrite turn. It MUST call the supplied `persistPrompt` with the
   * new instruction text; that call is what marks the prompt as published.
   */
  rewrite: (persistPrompt: (prompt: string) => Promise<void>) => Promise<void>;
  /** Run the headless compile. Reports its outcome, never rejects. */
  compile: () => Promise<{ ok: boolean; error?: string }>;
  /** Report a roll-back — ledger turn, health, log. */
  onRolledBack: (detail: string) => void;
  /** Report a failed revision — ledger turn, run-event bus, health, log. */
  onFailed: (message: string) => void;
}

export async function reviseAutomationInstructions(deps: AutomationRevisionDeps): Promise<void> {
  let promptPublished = false;
  const previousPrompt = deps.row.manifest.prompt;

  const rollBack = async (reason: string): Promise<void> => {
    if (!promptPublished) return;
    promptPublished = false;
    const detail = await deps.publishPrompt(previousPrompt, 'revert instructions').then(
      () => `${reason} — the previous instructions were restored.`,
      (error: unknown) =>
        `${reason} — restoring the previous instructions ALSO failed (${
          error instanceof Error ? error.message : String(error)
        }); the compiled handler does not match the published prompt.`,
    );
    deps.onRolledBack(detail);
  };

  await withConversationLock(deps.conversationLocks, deps.row.ownerApp, deps.row.ref, async () => {
    await deps.rewrite(async (prompt) => {
      await deps.publishPrompt(prompt, 'revise instructions');
      promptPublished = true;
    });
    const compiled = await deps.compile();
    if (compiled.ok) promptPublished = false;
    else await rollBack(`Compile failed after the revision (${compiled.error ?? 'unknown error'})`);
  }).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    await rollBack(`Instruction revision failed (${message})`);
    deps.onFailed(message);
  });
}
