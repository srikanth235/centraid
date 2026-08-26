// Revise orchestration (#541): serialized under the per-conversation turn
// lock; transactional — publish+compile are one unit, failure rolls back
// and reports into the thread.

import type { Row as AutomationRow } from "@centraid/server/automation";
import { withConversationLock } from "@centraid/server/engine";

export interface AutomationRevisionDeps {
  row: AutomationRow;
  conversationLocks: Map<string, Promise<void>>;
  publishPrompt: (prompt: string, message: string) => Promise<void>;
  /** MUST call `persistPrompt`; that call marks the prompt published. */
  rewrite: (persistPrompt: (prompt: string) => Promise<void>) => Promise<void>;
  /** Headless compile; reports its outcome, never rejects. */
  compile: () => Promise<{ ok: boolean; error?: string }>;
  onRolledBack: (detail: string) => void;
  onFailed: (message: string) => void;
}

export async function reviseAutomationInstructions(
  deps: AutomationRevisionDeps
): Promise<void> {
  let promptPublished = false;
  const previousPrompt = deps.row.manifest.prompt;

  const rollBack = async (reason: string): Promise<void> => {
    if (!promptPublished) return;
    promptPublished = false;
    const detail = await deps
      .publishPrompt(previousPrompt, "revert instructions")
      .then(
        () => `${reason} — the previous instructions were restored.`,
        (error: unknown) =>
          `${reason} — restoring the previous instructions ALSO failed (${
            error instanceof Error ? error.message : String(error)
          }); the compiled handler does not match the published prompt.`
      );
    deps.onRolledBack(detail);
  };

  await withConversationLock(
    deps.conversationLocks,
    deps.row.ownerApp,
    deps.row.ref,
    async () => {
      await deps.rewrite(async (prompt) => {
        await deps.publishPrompt(prompt, "revise instructions");
        promptPublished = true;
      });
      const compiled = await deps.compile();
      if (compiled.ok) promptPublished = false;
      else
        await rollBack(
          `Compile failed after the revision (${compiled.error ?? "unknown error"})`
        );
    }
  ).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    await rollBack(`Instruction revision failed (${message})`);
    deps.onFailed(message);
  });
}
