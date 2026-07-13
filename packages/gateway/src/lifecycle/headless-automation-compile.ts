import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ConversationStore,
  makeJournalDbProvider,
  type ConversationRunner,
  type TurnStreamEvent,
} from '@centraid/app-engine';
import { validateManifest, type Manifest } from '@centraid/automation';

export interface HeadlessCompileOptions {
  runner: ConversationRunner;
  journalDbFile: string;
  runnerSessionDir: string;
  dataDir: string;
  appId: string;
  /** A fresh, one-shot worktree session for this compile. */
  draftSessionId: string;
  automationRef: string;
  automationName: string;
  instructions: string;
  onSuccess: () => Promise<void>;
  onFailure?: (error: string) => Promise<void> | void;
  runId?: string;
}

export const HEADLESS_COMPILE_WORK_ORDER = (instructions: string): string => {
  const entities = Array.from(instructions.matchAll(/@\[([^/\]]+)\/([^\]]+)\]/g));
  return [
    'Compile this automation headlessly. This is a work order, not a conversation.',
    'Update automation.json only when derived requirements or vault scopes need to change.',
    'Write a complete deterministic handler.js that implements the instructions.',
    'Do not change the enabled field; the gateway owns enable/disable lifecycle after validation.',
    "Use generated.by = 'centraid-compiler'. Do not ask questions. Stop after the files are ready.",
    '',
    'Instructions:',
    instructions,
    ...(entities.length > 0
      ? [
          '',
          'Stable entity tokens (compile each into a consent-checked runtime resolution before use):',
          ...entities.map(
            (match) =>
              `- ${match[0]} => await ctx.vault.resolve({ refs: [{ type: '${match[1]}', id: '${match[2]}' }], purpose: 'dpv:ServiceProvision' })`,
          ),
        ]
      : []),
  ].join('\n');
};

/** Apply gateway-owned lifecycle/provenance after the agent has written its draft. */
export function finalizeCompiledManifest(
  manifest: Manifest,
  options: { enabledBeforeCompile: boolean; enableOnSuccess: boolean; compiledAt?: Date },
): Manifest {
  const taggedScopes = Array.from(
    manifest.prompt.matchAll(/@\[([^/.\]]+)\.([^/\]]+)\/[^\]]+\]/g),
    (match) => ({ schema: match[1]!, table: match[2]!, verbs: 'read' as const }),
  );
  const scopes = [...(manifest.vault?.scopes ?? [])];
  for (const scope of taggedScopes) {
    if (
      !scopes.some(
        (existing) =>
          existing.schema === scope.schema &&
          existing.table === scope.table &&
          existing.verbs === scope.verbs,
      )
    ) {
      scopes.push(scope);
    }
  }
  return validateManifest({
    ...manifest,
    enabled: options.enableOnSuccess ? true : options.enabledBeforeCompile,
    ...(scopes.length > 0
      ? {
          vault: {
            purpose: manifest.vault?.purpose ?? 'dpv:ServiceProvision',
            ...(manifest.vault?.why ? { why: manifest.vault.why } : {}),
            scopes,
          },
        }
      : {}),
    generated: {
      by: 'centraid-compiler',
      at: (options.compiledAt ?? new Date()).toISOString(),
    },
  });
}

/** Drive the existing unified builder runner without exposing a builder conversation UI. */
export async function runHeadlessAutomationCompile(opts: HeadlessCompileOptions): Promise<void> {
  const store = new ConversationStore(makeJournalDbProvider(opts.journalDbFile));
  const runId = opts.runId ?? `${opts.automationRef}:compile:${randomUUID().slice(0, 8)}`;
  const conversationId = store.ensureAutomationConversation(
    opts.automationRef,
    opts.appId,
    opts.automationName,
  );
  const startedAt = Date.now();
  const message = HEADLESS_COMPILE_WORK_ORDER(opts.instructions);
  store.insertTurn({
    turnId: runId,
    conversationId,
    triggerKind: 'compile',
    note: 'Compiling plan',
    startedAt,
  });
  store.insertMessageIn({ turnId: runId, role: 'user', text: message, startedAt });

  let finalText = '';
  let errorMessage: string | undefined;
  let usage: Extract<TurnStreamEvent, { type: 'usage' }> | undefined;
  const onEvent = (event: TurnStreamEvent): void => {
    if (event.type === 'final') finalText = event.text;
    if (event.type === 'error') errorMessage = event.message;
    if (event.type === 'aborted') errorMessage = 'Compile aborted';
    if (event.type === 'usage') usage = event;
  };

  try {
    // The injected unified gateway runner is intrinsically headless: its
    // Claude adapter pins bypassPermissions and its Codex adapter pins
    // approvalPolicy=never + workspace-write. There is deliberately no
    // per-turn escape hatch on ConversationRunner that can weaken this.
    await opts.runner.run({
      appId: opts.appId,
      draftSessionId: opts.draftSessionId,
      dataDir: opts.dataDir,
      conversationId,
      sessionFile: path.join(opts.runnerSessionDir, `${encodeURIComponent(conversationId)}.jsonl`),
      message,
      register: 'build',
      extraSystemPrompt: '',
      abortSignal: new AbortController().signal,
      onEvent,
    });
    if (errorMessage) throw new Error(errorMessage);
    await opts.onSuccess();
    const endedAt = Date.now();
    if (finalText || usage) {
      store.insertItem({
        itemId: randomUUID(),
        turnId: runId,
        ordinal: 1,
        kind: 'step',
        outputJson: JSON.stringify({ text: finalText || 'Plan ready' }),
        ok: true,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        ...(usage?.model ? { model: usage.model } : {}),
        ...(usage?.provider ? { provider: usage.provider } : {}),
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage?.cacheWriteTokens !== undefined
          ? { cacheWriteTokens: usage.cacheWriteTokens }
          : {}),
      });
    }
    store.finishTurn({ turnId: runId, endedAt, ok: true, summary: 'Plan ready' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.finishTurn({
      turnId: runId,
      endedAt: Date.now(),
      ok: false,
      error: message,
      summary: 'Compile failed',
    });
    await opts.onFailure?.(message);
  } finally {
    store.close();
  }
}
