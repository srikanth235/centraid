/*
 * Claude model enumeration via the Agent SDK's `supportedModels()` control
 * method. Mirrors codex's `model-list.ts` so both backends expose their model
 * catalog from a parallel file; the per-runner switchboard in
 * `models/enumerators.ts` dispatches to each.
 *
 * The CLI reports its built-in model list (aliases like `default`/`sonnet`/
 * `haiku`, each with a display name) over the control channel — no model turn,
 * no tokens. Everything is best-effort: any failure resolves to `[]`.
 */
import type { RunnerModel } from '@centraid/app-engine';

/** Cap on the SDK control call — generous; Refresh-only so latency is fine. */
const MODEL_LIST_TIMEOUT_MS = 15_000;

/** Shape of a `ModelInfo` from the SDK's `supportedModels()` — read defensively. */
interface ClaudeModelInfo {
  value?: unknown;
  displayName?: unknown;
  description?: unknown;
}

/**
 * Map the SDK's `ModelInfo[]` to `RunnerModel[]`: `value` → `id`; the label
 * prefers `description` (e.g. "Opus 4.7 with 1M context · …") over `displayName`
 * because the bare alias id hides the concrete version, and the `default` alias
 * is flagged as the default selection. Reads defensively, dedupes by id, and
 * drops entries with no usable id. Exported for tests.
 */
export function mapClaudeModels(infos: readonly ClaudeModelInfo[]): RunnerModel[] {
  const seen = new Set<string>();
  const models: RunnerModel[] = [];
  for (const info of infos) {
    const id = typeof info?.value === 'string' ? info.value.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const model: RunnerModel = { id };
    // Prefer `description` (carries the concrete version) for the picker label;
    // fall back to `displayName` when a runtime omits it.
    const description = typeof info.description === 'string' ? info.description.trim() : '';
    const displayName = typeof info.displayName === 'string' ? info.displayName.trim() : '';
    const name = description || displayName;
    if (name && name !== id) model.name = name;
    if (id === 'default') model.default = true;
    models.push(model);
  }
  return models;
}

/**
 * Enumerate claude's models via the Agent SDK's `supportedModels()` control
 * method. Opens a streaming-input session with no user turn (so no tokens are
 * spent), reads the model list, and tears the session down. Returns `[]` on any
 * failure — never throws.
 */
export async function enumerateClaudeModels(binPath?: string): Promise<RunnerModel[]> {
  let mod: typeof import('@anthropic-ai/claude-agent-sdk');
  try {
    mod = await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    return [];
  }

  const abort = new AbortController();
  // An empty streaming prompt opens the session without driving a model turn.
  async function* noPrompt(): AsyncGenerator<never> {
    /* yields nothing */
  }

  const options: Record<string, unknown> = { abortController: abort };
  if (binPath) options.pathToClaudeCodeExecutable = binPath;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const q = mod.query({
      prompt: noPrompt() as unknown as Parameters<typeof mod.query>[0]['prompt'],
      options: options as Parameters<typeof mod.query>[0]['options'],
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('supportedModels timeout')), MODEL_LIST_TIMEOUT_MS);
      timer.unref?.();
    });
    const infos = (await Promise.race([q.supportedModels(), timeout])) as ClaudeModelInfo[];
    return mapClaudeModels(infos);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
    try {
      abort.abort();
    } catch {
      /* ignore */
    }
  }
}
