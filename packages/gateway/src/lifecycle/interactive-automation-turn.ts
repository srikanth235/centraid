/*
 * governance: allow-repo-hygiene file-size-limit (#567) the interactive automation path is one lock/hydration/event/artifact/ledger state machine; splitting its settlement phases would scatter transaction ordering
 *
 * Interactive automation turn (issue #541, Wave 6).
 *
 * The ACP session is only a cache. Every steering turn receives a compact
 * preamble reconstructed from the durable automation conversation, so a cold
 * process and a resumed process see the same standing instructions, recent
 * outcomes, connector bindings, and requested vault scope. The turn itself is
 * persisted directly to the native conversation → turn → item ledger while
 * shared `TurnStreamEvent`s fan out to the caller and, nested under the owning
 * item, to the automation turn event bus for second-viewer parity.
 */

import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  compileHydrationPlan,
  hydrationMessagesFromLedger,
  resolveItemCost,
  withConversationLock,
  type AutomationTurnStreamEvent,
  type ConversationRunner,
  type ConversationTurnAttachment,
  type RunnerKind,
  type TurnAttachment,
  type TurnStreamEvent,
} from '@centraid/app-engine';
import type { Row as AutomationRow } from '@centraid/automation';
import { journalConversationStore } from '../journal-stores.js';
import {
  automationContextPreamble,
  boundedRawJson,
  RECENT_TURN_LIMIT,
  safeJson,
} from './automation-turn-context.js';

type UsageEvent = Extract<TurnStreamEvent, { type: 'usage' }>;

function pricedUsage(event: UsageEvent): UsageEvent {
  if (event.costUsd !== undefined) {
    return event.costSource ? event : { ...event, costSource: 'agent' };
  }
  const priced = resolveItemCost({
    model: event.model,
    usage: {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheWriteTokens,
    },
  });
  return priced.costUsd === undefined
    ? event
    : {
        ...event,
        costUsd: priced.costUsd,
        costSource: priced.costSource,
      };
}

function usageFields(usage: UsageEvent | undefined): {
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  costSource?: 'agent' | 'estimated';
  effort?: string;
} {
  if (!usage) return {};
  return {
    ...(usage.model !== undefined ? { model: usage.model } : {}),
    ...(usage.provider !== undefined ? { provider: usage.provider } : {}),
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    ...(usage.costSource !== undefined ? { costSource: usage.costSource } : {}),
    ...(usage.effort !== undefined ? { effort: usage.effort } : {}),
  };
}

function itemId(turnId: string, ordinal: number): string {
  return `${turnId}:${ordinal}:${randomUUID().slice(0, 6)}`;
}

export interface InteractiveAutomationTurnOptions {
  row: AutomationRow;
  turnId: string;
  message: string;
  journalDbFile: string;
  runnerSessionDir: string;
  runner: ConversationRunner;
  runnerKind: RunnerKind;
  model?: string;
  configPins?: Readonly<Record<string, string>>;
  providerConsent?: RunnerKind;
  attachmentRefs?: ConversationTurnAttachment[];
  turnAttachments?: TurnAttachment[];
  /** Resolve historical upload hashes into this automation app's blob CAS. */
  hydrationAttachmentPath?: (hash: string) => string;
  /** Trusted roots for agent-reported file locations. */
  artifactRoots?: string[];
  /** Persist homeless inline terminal/content artifacts in the app CAS. */
  uploadInlineArtifact?: (bytes: Uint8Array) => Promise<{ hash: string; sizeBytes: number }>;
  abortSignal: AbortSignal;
  conversationLocks: Map<string, Promise<void>>;
  /** Direct SSE sink. */
  onEvent: (event: TurnStreamEvent) => void;
  /** Automation bus sink for replay/second-viewer parity. */
  onTurnEvent?: (event: AutomationTurnStreamEvent) => void;
}

export interface InteractiveAutomationTurnResult {
  turnId: string;
  ok: boolean;
  error?: string;
}

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function workspaceArtifact(
  reportedPath: string,
  roots: readonly string[],
): Promise<ConversationTurnAttachment | undefined> {
  try {
    const decoded = reportedPath.startsWith('file:') ? fileURLToPath(reportedPath) : reportedPath;
    const base = roots[0] ?? process.cwd();
    const candidate = await fs.realpath(
      path.isAbsolute(decoded) ? decoded : path.resolve(base, decoded),
    );
    const allowedRoots = await Promise.all(
      roots.map((root) => fs.realpath(root).catch(() => path.resolve(root))),
    );
    if (!allowedRoots.some((root) => pathInside(candidate, root))) return undefined;
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return undefined;
    const bytes = await fs.readFile(candidate);
    return {
      hash: createHash('sha256').update(bytes).digest('hex'),
      mime: 'application/octet-stream',
      sizeBytes: stat.size,
      source: 'agent',
      filename: path.basename(candidate),
      workspacePath: candidate,
    };
  } catch {
    return undefined;
  }
}

/**
 * Run one steering turn. The lock covers ledger context selection, runner
 * dispatch, and resume-handle update so two messages on one automation cannot
 * race the same cached ACP session.
 */
export async function runInteractiveAutomationTurn(
  opts: InteractiveAutomationTurnOptions,
): Promise<InteractiveAutomationTurnResult> {
  const store = journalConversationStore(opts.journalDbFile);
  const ref = opts.row.ref;
  const conversationId = store.ensureAutomationConversation(
    ref,
    opts.row.ownerApp,
    opts.row.name,
    opts.runnerKind,
  );

  return withConversationLock(opts.conversationLocks, opts.row.ownerApp, ref, async () => {
    const lockToken = randomUUID();
    if (!store.acquireTurnLock(conversationId, lockToken)) {
      throw new Error(`automation conversation "${conversationId}" already has a running turn`);
    }
    const lockLeaseHeartbeat = setInterval(
      () => store.refreshTurnLock(conversationId, lockToken),
      60_000,
    );
    lockLeaseHeartbeat.unref?.();
    try {
      const conversation = store.getConversation(conversationId);
      if (!conversation) {
        throw new Error(`automation conversation "${conversationId}" was not created`);
      }
      const binding = store.getHarnessBinding(conversationId, opts.runnerKind);
      const turnsBeforeCurrent = store.listTurns(conversationId);
      const hydrationMessages = hydrationMessagesFromLedger(
        turnsBeforeCurrent,
        (turnId) => store.listItems(turnId),
        (itemId) => store.listAttachmentsForItem(itemId),
        binding?.hydratedThroughSeq ?? -1,
      );
      const recoveryMessages = binding
        ? hydrationMessagesFromLedger(
            turnsBeforeCurrent,
            (turnId) => store.listItems(turnId),
            (itemId) => store.listAttachmentsForItem(itemId),
          )
        : [];
      const hydrationPlan =
        hydrationMessages.length > 0
          ? compileHydrationPlan(hydrationMessages, { includeAttachmentReferences: true })
          : undefined;
      const recoveryHydrationPlan =
        recoveryMessages.length > 0
          ? compileHydrationPlan(recoveryMessages, { includeAttachmentReferences: true })
          : undefined;

      const recentTurns = store.listTurns(conversationId).toReversed().slice(0, RECENT_TURN_LIMIT);
      const preamble = automationContextPreamble(opts.row, recentTurns, opts.message);
      const startedAt = Date.now();
      store.insertTurn({
        turnId: opts.turnId,
        conversationId,
        triggerKind: 'interactive',
        triggerOrigin: 'manual',
        note: 'Interactive steering turn',
        startedAt,
      });
      const messageItemId = store.insertMessageIn({
        turnId: opts.turnId,
        role: 'user',
        text: opts.message,
        startedAt,
      });
      for (const attachment of opts.attachmentRefs ?? []) {
        store.insertAttachment({
          itemId: messageItemId,
          hash: attachment.hash,
          mime: attachment.mime,
          sizeBytes: attachment.sizeBytes,
          source: attachment.source ?? 'upload',
          ...(attachment.filename ? { filename: attachment.filename } : {}),
        });
      }

      const emitTurn = (event: AutomationTurnStreamEvent): void => {
        try {
          opts.onTurnEvent?.(event);
        } catch {
          /* a subscriber must not fail the turn */
        }
      };
      emitTurn({ type: 'turn.start', turnId: opts.turnId });

      let nextOrdinal = 1;
      const agentOrdinal = nextOrdinal++;
      const agentItemId = itemId(opts.turnId, agentOrdinal);
      store.openItem({
        itemId: agentItemId,
        turnId: opts.turnId,
        ordinal: agentOrdinal,
        kind: 'agent',
        name: 'interactive',
        argsJson: safeJson({ message: opts.message }),
        startedAt,
      });
      emitTurn({
        type: 'item.start',
        itemId: agentItemId,
        ordinal: agentOrdinal,
        kind: 'agent',
        name: 'interactive',
        args: { message: opts.message },
      });

      const toolItems = new Map<
        string,
        { itemId: string; ordinal: number; startedAt: number; name: string }
      >();
      let text = '';
      let finalText: string | undefined;
      let finalRawJson: string | undefined;
      let stopReason: string | undefined;
      let failure: string | undefined;
      let usage: UsageEvent | undefined;
      let consentRequired = false;
      const notices: Array<{
        itemId: string;
        ordinal: number;
        level: 'info' | 'warn';
        code?: string;
        message: string;
        at: number;
      }> = [];
      const artifactCandidates: Array<{
        itemId: string;
        locations: Array<{ path: string; line?: number }>;
        inline: Array<{ dataBase64: string; mime: string; filename?: string }>;
      }> = [];

      const closeTool = (
        callId: string,
        open: { itemId: string; ordinal: number; startedAt: number; name: string },
        event: Extract<TurnStreamEvent, { type: 'tool.result' }> | { ok: false; errorText: string },
      ): void => {
        const endedAt = Date.now();
        const result = 'result' in event ? event.result : undefined;
        const rawJson = boundedRawJson('rawJson' in event ? event.rawJson : undefined);
        const error = event.ok ? undefined : event.errorText || 'Tool failed.';
        if (
          'locations' in event &&
          ((event.locations?.length ?? 0) > 0 || (event.artifacts?.length ?? 0) > 0)
        ) {
          artifactCandidates.push({
            itemId: open.itemId,
            locations: event.locations ?? [],
            inline: event.artifacts ?? [],
          });
        }
        store.closeItem({
          itemId: open.itemId,
          ok: event.ok,
          ...(result !== undefined ? { outputJson: safeJson(result) } : {}),
          ...(rawJson !== undefined ? { rawJson } : {}),
          ...(error !== undefined ? { error } : {}),
          endedAt,
          durationMs: endedAt - open.startedAt,
        });
        emitTurn({
          type: 'item.end',
          itemId: open.itemId,
          ordinal: open.ordinal,
          callId,
          ok: event.ok,
          ...(result !== undefined ? { result } : {}),
          ...(error !== undefined ? { error } : {}),
          durationMs: endedAt - open.startedAt,
          ...(rawJson !== undefined ? { rawJson } : {}),
        });
        toolItems.delete(callId);
      };

      const onEvent = (incoming: TurnStreamEvent): void => {
        const event = incoming.type === 'usage' ? pricedUsage(incoming) : incoming;
        if (event.type === 'assistant.delta') text += event.delta;
        if (event.type === 'usage') usage = event;
        if (event.type === 'final') {
          finalText = text || event.text;
          finalRawJson = boundedRawJson(event.rawJson);
          stopReason = event.stopReason;
        }
        if (event.type === 'error') {
          failure = event.message;
          finalRawJson = boundedRawJson(event.rawJson);
          stopReason = event.stopReason;
        }
        if (event.type === 'consent.required') consentRequired = true;
        if (event.type === 'notice') {
          notices.push({
            itemId: itemId(opts.turnId, nextOrdinal),
            ordinal: nextOrdinal++,
            level: event.level,
            ...(event.code ? { code: event.code } : {}),
            message: event.message,
            at: Date.now(),
          });
        }

        if (event.type === 'tool.start') {
          const ordinal = nextOrdinal++;
          const openedAt = Date.now();
          const id = itemId(opts.turnId, ordinal);
          const rawStartJson = boundedRawJson(event.rawJson);
          store.openItem({
            itemId: id,
            turnId: opts.turnId,
            ordinal,
            callId: event.toolCallId,
            kind: 'tool',
            name: event.toolName,
            ...(event.args !== undefined ? { argsJson: safeJson(event.args) } : {}),
            ...(rawStartJson !== undefined ? { rawJson: rawStartJson } : {}),
            startedAt: openedAt,
          });
          toolItems.set(event.toolCallId, {
            itemId: id,
            ordinal,
            startedAt: openedAt,
            name: event.toolName,
          });
          emitTurn({
            type: 'item.start',
            itemId: id,
            ordinal,
            callId: event.toolCallId,
            kind: 'tool',
            name: event.toolName,
            ...(event.args !== undefined ? { args: event.args } : {}),
            ...(rawStartJson !== undefined ? { rawJson: rawStartJson } : {}),
          });
          emitTurn({
            type: 'item.delta',
            itemId: id,
            ordinal,
            callId: event.toolCallId,
            event,
          });
        } else if (event.type === 'tool.result') {
          const open = toolItems.get(event.toolCallId);
          if (open) {
            emitTurn({
              type: 'item.delta',
              itemId: open.itemId,
              ordinal: open.ordinal,
              callId: event.toolCallId,
              event,
            });
            closeTool(event.toolCallId, open, event);
          } else {
            emitTurn({ type: 'item.delta', itemId: agentItemId, ordinal: agentOrdinal, event });
          }
        } else {
          emitTurn({ type: 'item.delta', itemId: agentItemId, ordinal: agentOrdinal, event });
        }
        try {
          opts.onEvent(event);
        } catch {
          /* transport teardown is handled by abortSignal */
        }
      };

      const digest = createHash('sha256').update(conversationId).digest('hex').slice(0, 24);
      const scratchDir = path.join(opts.runnerSessionDir, 'automation-turns', digest);
      await fs.mkdir(scratchDir, { recursive: true });
      const sessionFile = path.join(scratchDir, 'session.jsonl');

      let adapter:
        | {
            adapterSessionId?: string;
            adapterKind?: string;
            adapterUsageSnapshot?: import('@centraid/app-engine').AdapterUsageSnapshot;
            hydrated?: boolean;
            hydrationTokens?: number;
          }
        | undefined;
      try {
        const result = await opts.runner.run({
          appId: opts.row.ownerApp,
          dataDir: scratchDir,
          conversationId,
          sessionFile,
          message: opts.message,
          ...(opts.turnAttachments?.length ? { attachments: opts.turnAttachments } : {}),
          extraSystemPrompt: preamble,
          runnerKind: opts.runnerKind,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.configPins ? { configPins: opts.configPins } : {}),
          ...(opts.providerConsent ? { providerConsent: opts.providerConsent } : {}),
          ...(conversation.adapterKind ? { activeAdapterKind: conversation.adapterKind } : {}),
          permissionPolicy: 'deny',
          abortSignal: opts.abortSignal,
          ...(binding?.acpSessionId
            ? { prevAdapterSessionId: binding.acpSessionId, prevBindingId: binding.id }
            : {}),
          ...(binding ? { prevAdapterKind: binding.kind } : {}),
          ...(binding?.usageSnapshot ? { prevAdapterUsageSnapshot: binding.usageSnapshot } : {}),
          ...(hydrationPlan
            ? {
                hydrationContext: {
                  prompt: hydrationPlan.prompt,
                  includedTurns: hydrationPlan.includedTurns,
                  omittedTurns: hydrationPlan.omittedTurns,
                  estimatedTokens: hydrationPlan.estimatedTokens,
                },
              }
            : {}),
          ...(opts.hydrationAttachmentPath && hydrationPlan?.attachments.length
            ? {
                hydrationAttachments: hydrationPlan.attachments.map((attachment) => ({
                  path: opts.hydrationAttachmentPath!(attachment.hash),
                  mime: attachment.mime,
                  ...(attachment.filename ? { filename: attachment.filename } : {}),
                })),
              }
            : {}),
          ...(recoveryHydrationPlan
            ? {
                recoveryHydrationContext: {
                  prompt: recoveryHydrationPlan.prompt,
                  includedTurns: recoveryHydrationPlan.includedTurns,
                  omittedTurns: recoveryHydrationPlan.omittedTurns,
                  estimatedTokens: recoveryHydrationPlan.estimatedTokens,
                },
              }
            : {}),
          ...(opts.hydrationAttachmentPath && recoveryHydrationPlan?.attachments.length
            ? {
                recoveryHydrationAttachments: recoveryHydrationPlan.attachments.map(
                  (attachment) => ({
                    path: opts.hydrationAttachmentPath!(attachment.hash),
                    mime: attachment.mime,
                    ...(attachment.filename ? { filename: attachment.filename } : {}),
                  }),
                ),
              }
            : {}),
          onEvent,
        });
        adapter = result ?? undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!failure) {
          failure = message;
          onEvent({ type: 'error', message });
        }
      }

      if (consentRequired) {
        store.deleteTurn(opts.turnId);
        emitTurn({ type: 'turn.end', turnId: opts.turnId, ok: false, error: 'consent_required' });
        return { turnId: opts.turnId, ok: false, error: 'consent_required' };
      }

      if (opts.abortSignal.aborted && !failure) failure = 'Turn aborted.';
      for (const [callId, open] of toolItems) {
        closeTool(callId, open, {
          ok: false,
          errorText: failure ?? 'Tool call ended without a terminal result.',
        });
      }

      const endedAt = Date.now();
      const answer = finalText ?? text;
      const ok = failure === undefined && !opts.abortSignal.aborted;
      const artifactsByItem = new Map<string, ConversationTurnAttachment[]>();
      for (const candidate of artifactCandidates) {
        const artifacts: ConversationTurnAttachment[] = (
          await Promise.all(
            candidate.locations.map((location) =>
              workspaceArtifact(location.path, opts.artifactRoots ?? []),
            ),
          )
        ).filter((artifact) => artifact !== undefined);
        if (opts.uploadInlineArtifact) {
          for (const inline of candidate.inline) {
            try {
              const bytes = Buffer.from(inline.dataBase64, 'base64');
              if (bytes.byteLength === 0 || bytes.byteLength > 25 * 1024 * 1024) continue;
              const stored = await opts.uploadInlineArtifact(bytes);
              artifacts.push({
                hash: stored.hash,
                mime: inline.mime,
                sizeBytes: stored.sizeBytes,
                source: 'agent',
                filename: inline.filename ?? 'agent-artifact',
              });
            } catch {
              // A malformed optional ACP artifact never fails the turn.
            }
          }
        }
        if (artifacts.length > 0) artifactsByItem.set(candidate.itemId, artifacts);
      }
      const output = {
        ...(answer ? { text: answer } : {}),
        ...(stopReason ? { stopReason } : {}),
      };
      store.runInTransaction(() => {
        for (const [itemId, artifacts] of artifactsByItem) {
          for (const artifact of artifacts) {
            store.insertAttachment({
              itemId,
              hash: artifact.hash,
              mime: artifact.mime,
              sizeBytes: artifact.sizeBytes,
              source: artifact.source ?? 'agent',
              ...(artifact.filename ? { filename: artifact.filename } : {}),
              ...(artifact.workspacePath ? { workspacePath: artifact.workspacePath } : {}),
            });
          }
        }
        for (const notice of notices) {
          store.insertItem({
            itemId: notice.itemId,
            turnId: opts.turnId,
            ordinal: notice.ordinal,
            kind: 'step',
            name: `notice:${notice.level}:${notice.code ?? 'runner'}`,
            outputJson: safeJson({ text: notice.message }),
            ok: true,
            startedAt: notice.at,
            endedAt: notice.at,
            durationMs: 0,
          });
        }
        store.closeItem({
          itemId: agentItemId,
          ok,
          ...(Object.keys(output).length > 0 ? { outputJson: safeJson(output) } : {}),
          ...(finalRawJson !== undefined ? { rawJson: finalRawJson } : {}),
          ...(failure !== undefined ? { error: failure } : {}),
          endedAt,
          durationMs: endedAt - startedAt,
          ...usageFields(usage),
        });
        store.finishTurn({
          turnId: opts.turnId,
          endedAt,
          ok,
          ...(failure !== undefined ? { error: failure } : {}),
          ...(answer ? { summary: answer.slice(0, 240) } : {}),
          ...(Object.keys(output).length > 0 ? { outputJson: safeJson(output) } : {}),
        });
        if (adapter?.hydrationTokens !== undefined) {
          store.setTurnHydrationTokens(opts.turnId, adapter.hydrationTokens);
        }
        const observedAdapter = adapter?.adapterKind
          ? {
              kind: adapter.adapterKind,
              ...(adapter.adapterSessionId ? { sessionId: adapter.adapterSessionId } : {}),
              ...(adapter.adapterUsageSnapshot
                ? { usageSnapshot: adapter.adapterUsageSnapshot }
                : {}),
              ...(adapter.hydrated ? { hydrated: true } : {}),
            }
          : undefined;
        if (ok) store.noteTurn(conversationId, '', observedAdapter);
        else store.noteFailedTurn(conversationId, '', observedAdapter);
      });
      emitTurn({
        type: 'item.end',
        itemId: agentItemId,
        ordinal: agentOrdinal,
        ok,
        ...(Object.keys(output).length > 0 ? { result: output } : {}),
        ...(failure !== undefined ? { error: failure } : {}),
        durationMs: endedAt - startedAt,
        ...(finalRawJson !== undefined ? { rawJson: finalRawJson } : {}),
      });
      emitTurn({
        type: 'turn.end',
        turnId: opts.turnId,
        ok,
        ...(failure !== undefined ? { error: failure } : {}),
      });
      return {
        turnId: opts.turnId,
        ok,
        ...(failure !== undefined ? { error: failure } : {}),
      };
    } finally {
      clearInterval(lockLeaseHeartbeat);
      store.releaseTurnLock(conversationId, lockToken);
    }
  });
}
