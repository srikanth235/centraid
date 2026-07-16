/*
 * LLM auto-titles (issue #420, Wave 3). After the first turn of a new
 * conversation settles, a cheap one-shot inference names the thread — the
 * claude.ai/ChatGPT affordance that replaces first-message truncation
 * (`deriveTitle`) with something a human would actually call the conversation.
 *
 * Design contract (enforced by the caller in the gateway):
 *   - fire-and-forget: this never blocks or fails the turn; every error is
 *     swallowed and the derived truncation simply stays;
 *   - provider-agnostic: the caller passes a capability TIER token (`fast`),
 *     never a concrete model id — the backend resolves the tier at turn time
 *     (governance directive no-hardcoded-model-ids);
 *   - tool-less: no `toolContext`, so the titler can't touch the vault — it
 *     only reads the two strings it's handed;
 *   - user-rename-wins: the caller only applies the result when the stored
 *     title is still the exact `deriveTitle` output.
 *
 * This module owns only the generation + cleanup; it drives the shared
 * `RunTurnFn` (agent-runtime's `runTurn` in production, a stub in tests) so
 * it never imports a backend.
 */

import type { RunTurnFn, RunnerPrefs, TurnInput } from './turn.js';
import type { TurnStreamEvent } from './runner.js';

/** Longest title we keep — matches the ledger's derived-title budget. */
const MAX_TITLE_CHARS = 60;

const TITLE_SYSTEM_PROMPT = [
  'You name a conversation. Read the first user message and the assistant reply,',
  'then output a single short title (3–6 words) that captures the topic.',
  'Rules: no surrounding quotes, no trailing punctuation, no prefix like',
  '"Title:", plain text only, sentence case. Output ONLY the title.',
].join(' ');

export interface GenerateTitleDeps {
  /** The shared turn driver — agent-runtime `runTurn` in production. */
  runTurn: RunTurnFn;
  /** Active runner prefs (kind + optional binPath/extraArgs). */
  runnerPrefs: RunnerPrefs;
  /** Working dir for the one-shot runner (the assistant cwd). */
  cwd: string;
  /** Capability tier or model alias for the titler — a TIER token like `fast`. */
  model: string;
  /** The first user message of the conversation. */
  userMessage: string;
  /** The assistant's answer to that message. */
  assistantText: string;
  /** Optional cap on how long the one-shot may run before it's abandoned. */
  timeoutMs?: number;
}

/**
 * Collapse a raw model title into a clean sidebar label: strip wrapping
 * quotes / a leading `Title:` marker, flatten whitespace, drop trailing
 * punctuation, and cap length. Returns undefined when nothing usable remains.
 */
export function cleanTitle(raw: string): string | undefined {
  let t = raw.trim();
  // Model sometimes echoes a leading marker despite the instruction.
  t = t.replace(/^title\s*[:\-–]\s*/i, '');
  // Strip a single layer of wrapping quotes (straight or curly).
  const first = t[0];
  const last = t[t.length - 1];
  if (
    t.length >= 2 &&
    ((first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === '“' && last === '”') ||
      (first === '‘' && last === '’'))
  ) {
    t = t.slice(1, -1).trim();
  }
  // Keep only the first line — a stray explanation never becomes the title.
  const nl = t.indexOf('\n');
  if (nl >= 0) t = t.slice(0, nl).trim();
  t = t
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?…]+$/u, '')
    .trim();
  if (t.length === 0) return undefined;
  if (t.length <= MAX_TITLE_CHARS) return t;
  return `${t.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}

/**
 * Drive one tool-less inference to name a conversation. Resolves to a cleaned
 * title, or undefined when the model produced nothing usable. Rejections
 * propagate — the caller is responsible for the fire-and-forget swallow.
 */
export async function generateConversationTitle(
  deps: GenerateTitleDeps,
): Promise<string | undefined> {
  const userExcerpt = excerpt(deps.userMessage, 1500);
  const assistantExcerpt = excerpt(deps.assistantText, 1500);
  const prompt = [
    'First user message:',
    userExcerpt,
    '',
    'Assistant reply:',
    assistantExcerpt,
    '',
    'Title:',
  ].join('\n');

  const controller = new AbortController();
  const timer = deps.timeoutMs ? setTimeout(() => controller.abort(), deps.timeoutMs) : undefined;
  timer?.unref?.();

  let text = '';
  const onEvent = (event: TurnStreamEvent): void => {
    if (event.type === 'assistant.delta') text += event.delta;
    else if (event.type === 'final') text = text || event.text;
  };

  const input: TurnInput = {
    cwd: deps.cwd,
    message: prompt,
    extraSystemPrompt: TITLE_SYSTEM_PROMPT,
    model: deps.model,
    abortSignal: controller.signal,
    onEvent,
  };
  try {
    await deps.runTurn(input, { prefs: deps.runnerPrefs });
  } finally {
    if (timer) clearTimeout(timer);
  }
  return cleanTitle(text);
}

function excerpt(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
