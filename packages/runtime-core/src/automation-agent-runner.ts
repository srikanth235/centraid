/**
 * Agent-driven automation runner (issue #90 model-B).
 *
 * Replaces the issue-#80 JS-handler engine. An automation no longer
 * carries a generated `actions/<name>.js` handler run in a worker
 * thread — a fire is an *agent turn*: the manifest's `prompt` is handed
 * to an LLM agent with the tools / mcps / model named in
 * `manifest.requires`, and the agent itself decides what to call.
 *
 * The host supplies an {@link AutomationAgentDispatcher} that runs the
 * turn against its agent backend — codex / claude locally
 * (`@centraid/agent-runtime`), the openclaw in-process StreamFn on the
 * gateway — and yields a stream of {@link AutomationAgentEvent}s. This
 * module owns the ledger side: it opens the `runs` row, records each
 * inference call as a `kind='step'` node (with per-call token usage and
 * a frozen `cost_usd`) and each tool call as a `kind='tool'` node, then
 * finishes the run and applies the retention policy.
 */

import { randomUUID } from 'node:crypto';
import { costForUsage, type TokenUsage } from './model-pricing.js';
import type { AutomationRunsStore } from './automation-runs-store.js';
import type { AutomationTriggerKind } from './automation-runs-schema.js';
import type {
  AutomationHistoryConfig,
  AutomationManifestRequires,
  AutomationOutputSchema,
} from './automation-manifest.js';
import { validateOutputAgainstSchema } from './automation-manifest-output.js';

const AUDIT_FIELD_BYTE_CAP = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Stringify a value for an audit field, capping the byte length at
 * 64 KB. Oversize payloads are replaced with a `{_truncated, bytes,
 * head}` envelope so the UI / debugging path can see the size without
 * blowing up the file.
 */
export function truncateForAudit(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return JSON.stringify({ _truncated: true, reason: 'unserializable' });
  }
  if (json.length <= AUDIT_FIELD_BYTE_CAP) return json;
  return JSON.stringify({ _truncated: true, bytes: json.length, head: json.slice(0, 256) });
}

/** Input the host dispatcher receives to run one automation agent turn. */
export interface AutomationAgentRunInput {
  readonly automationId: string;
  readonly runId: string;
  /** The manifest prompt — the instruction handed to the agent. */
  readonly prompt: string;
  /** Model / tools / mcps the agent turn is allowed to use. */
  readonly requires: AutomationManifestRequires;
  readonly triggerKind: AutomationTriggerKind;
  /** Payload from a manual / on-failure fire; `undefined` for a plain schedule. */
  readonly input?: unknown;
  /** Fires on timeout or manual cancel — the dispatcher should stop the turn. */
  readonly abortSignal: AbortSignal;
}

/**
 * One event in an automation agent turn. `step` is a primary
 * model-inference call (token + cost accounting); `tool` is a tool
 * call; `output` carries the turn's final summary / structured output.
 */
export type AutomationAgentEvent =
  | {
      readonly type: 'step';
      readonly model?: string;
      readonly provider?: string;
      readonly usage?: TokenUsage;
      readonly startedAt: number;
      readonly endedAt: number;
    }
  | {
      readonly type: 'tool';
      readonly name: string;
      readonly args?: unknown;
      readonly result?: unknown;
      readonly ok: boolean;
      readonly error?: string;
      /** App whose data the tool call touched, when applicable. */
      readonly appId?: string;
      readonly startedAt: number;
      readonly endedAt: number;
    }
  | {
      readonly type: 'output';
      readonly summary?: string;
      readonly output?: unknown;
    };

/**
 * Host seam: run one automation agent turn and yield its trace events.
 * A rejected iterator (or a thrown error) marks the run failed.
 */
export type AutomationAgentDispatcher = (
  input: AutomationAgentRunInput,
) => AsyncIterable<AutomationAgentEvent>;

export interface RunAutomationAgentOptions {
  readonly automationId: string;
  readonly runId: string;
  readonly prompt: string;
  readonly requires: AutomationManifestRequires;
  readonly dispatcher: AutomationAgentDispatcher;
  /** Activity-DB-backed ledger store for the run + its nodes. */
  readonly runsStore: AutomationRunsStore;
  readonly triggerKind?: AutomationTriggerKind;
  readonly input?: unknown;
  readonly parentRunId?: string;
  readonly outputSchema?: AutomationOutputSchema;
  readonly history?: AutomationHistoryConfig;
  readonly timeoutMs?: number;
}

export interface AutomationAgentOutcome {
  readonly ok: boolean;
  readonly summary?: string;
  readonly output?: unknown;
  readonly error?: string;
  readonly stepCount: number;
  readonly toolCount: number;
}

/** Translate a `history.keep` policy into a retention prune. */
function applyRetention(
  store: AutomationRunsStore,
  automationId: string,
  history: AutomationHistoryConfig | undefined,
): void {
  if (!history) return;
  const keep = history.keep;
  if (keep === 'all') return;
  if (keep === 'errors') {
    store.prune(automationId, { errorsOnly: true });
    return;
  }
  if ('count' in keep) {
    store.prune(automationId, { count: keep.count });
    return;
  }
  if ('days' in keep) store.prune(automationId, { days: keep.days });
}

/**
 * Run one automation as an agent turn. Opens the `runs` row, records
 * the trace as `step` / `tool` nodes, validates any structured output
 * against the manifest schema, finishes the run, and prunes history.
 * Never throws — a dispatcher failure resolves to `{ ok: false }`.
 */
export async function runAutomationAgent(
  opts: RunAutomationAgentOptions,
): Promise<AutomationAgentOutcome> {
  const { runsStore, runId, automationId } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  runsStore.insertRun({
    runId,
    kind: 'automation',
    automationId,
    triggerKind: opts.triggerKind ?? 'scheduled',
    ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
    ...(opts.input !== undefined ? { inputJson: truncateForAudit(opts.input) ?? '' } : {}),
    startedAt: Date.now(),
  });

  const abort = new AbortController();
  let timeoutHandle: NodeJS.Timeout | undefined;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => abort.abort('timeout'), timeoutMs);
  }

  let ordinal = 0;
  let stepCount = 0;
  let toolCount = 0;
  let summary: string | undefined;
  let output: unknown;
  let ok = true;
  let error: string | undefined;

  const nodeId = (): string => `${runId}:${ordinal}:${randomUUID().slice(0, 6)}`;

  try {
    const events = opts.dispatcher({
      automationId,
      runId,
      prompt: opts.prompt,
      requires: opts.requires,
      triggerKind: opts.triggerKind ?? 'scheduled',
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      abortSignal: abort.signal,
    });
    for await (const ev of events) {
      if (ev.type === 'step') {
        const cost = costForUsage(ev.model, ev.usage ?? {});
        runsStore.insertNode({
          nodeId: nodeId(),
          runId,
          ordinal: ordinal++,
          kind: 'step',
          ...(ev.model ? { model: ev.model } : {}),
          ...(ev.provider ? { provider: ev.provider } : {}),
          ...(ev.usage?.inputTokens !== undefined ? { inputTokens: ev.usage.inputTokens } : {}),
          ...(ev.usage?.outputTokens !== undefined ? { outputTokens: ev.usage.outputTokens } : {}),
          ...(ev.usage?.cacheReadTokens !== undefined
            ? { cacheReadTokens: ev.usage.cacheReadTokens }
            : {}),
          ...(ev.usage?.cacheWriteTokens !== undefined
            ? { cacheWriteTokens: ev.usage.cacheWriteTokens }
            : {}),
          ...(cost !== undefined ? { costUsd: cost } : {}),
          ok: true,
          startedAt: ev.startedAt,
          endedAt: ev.endedAt,
          durationMs: ev.endedAt - ev.startedAt,
        });
        stepCount++;
      } else if (ev.type === 'tool') {
        runsStore.insertNode({
          nodeId: nodeId(),
          runId,
          ordinal: ordinal++,
          kind: 'tool',
          name: ev.name,
          ...(ev.args !== undefined ? { argsJson: truncateForAudit(ev.args) ?? '' } : {}),
          ...(ev.ok && ev.result !== undefined
            ? { outputJson: truncateForAudit(ev.result) ?? '' }
            : {}),
          ...(ev.appId ? { appId: ev.appId } : {}),
          ok: ev.ok,
          ...(ev.error ? { error: ev.error } : {}),
          startedAt: ev.startedAt,
          endedAt: ev.endedAt,
          durationMs: ev.endedAt - ev.startedAt,
        });
        toolCount++;
      } else {
        if (ev.summary !== undefined) summary = ev.summary;
        if (ev.output !== undefined) output = ev.output;
      }
    }
    if (opts.outputSchema && output !== undefined) {
      const schemaErr = validateOutputAgainstSchema(opts.outputSchema, output);
      if (schemaErr) {
        ok = false;
        error = `outputSchema validation failed: ${schemaErr}`;
      }
    }
  } catch (err) {
    ok = false;
    error = err instanceof Error ? err.message : String(err);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  runsStore.finishRun({
    runId,
    endedAt: Date.now(),
    ok,
    ...(error !== undefined ? { error } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(output !== undefined ? { outputJson: truncateForAudit(output) ?? '' } : {}),
  });
  applyRetention(runsStore, automationId, opts.history);

  return {
    ok,
    ...(summary !== undefined ? { summary } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(error !== undefined ? { error } : {}),
    stepCount,
    toolCount,
  };
}
