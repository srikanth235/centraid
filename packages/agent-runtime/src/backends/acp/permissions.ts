/*
 * `session/request_permission` — the one server→client request we answer with
 * a decision rather than a refusal.
 *
 * Wire shape (verified against the public ACP spec):
 *   `session/request_permission` { sessionId, toolCall, options: [{ optionId,
 *   name, kind }] } → { outcome: { outcome: 'selected', optionId } |
 *   { outcome: 'cancelled' } }.
 *
 * `cancelled` means the PROMPT TURN was cancelled before this request could be
 * answered — agents unwind the whole turn on it. A per-tool refusal is a
 * `selected` outcome naming a `reject_once` / `reject_always` option, which
 * leaves the turn running with its pre-granted tools.
 *
 * We auto-allow the least-destructive option, matching the headless policy
 * codex/claude already run under: nothing in this surface can render an
 * approval prompt, so a turn that waited for one would simply stall.
 *
 * Every auto-allow also produces a `permission_auto_allowed` notice so the
 * transcript records what the agent asked for and what we picked — headless
 * is not the same as silent.
 */

import type { TurnStreamEvent } from '@centraid/app-engine';

export interface PermissionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

export function readPermissionOptions(params: unknown): PermissionOption[] {
  const raw = (params as { options?: unknown } | undefined)?.options;
  if (!Array.isArray(raw)) return [];
  const out: PermissionOption[] = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const rec = o as Record<string, unknown>;
    const optionId = typeof rec.optionId === 'string' ? rec.optionId : undefined;
    if (!optionId) continue;
    out.push({
      optionId,
      ...(typeof rec.kind === 'string' ? { kind: rec.kind } : {}),
      ...(typeof rec.name === 'string' ? { name: rec.name } : {}),
    });
  }
  return out;
}

/** Best-effort tool title from the permission request's toolCall payload. */
export function readPermissionToolTitle(params: unknown): string {
  const toolCall = (params as { toolCall?: unknown } | undefined)?.toolCall;
  if (!toolCall || typeof toolCall !== 'object') return 'tool';
  const rec = toolCall as Record<string, unknown>;
  if (typeof rec.title === 'string' && rec.title.trim()) return rec.title.trim();
  if (typeof rec.kind === 'string' && rec.kind.trim()) return rec.kind.trim();
  if (typeof rec.toolCallId === 'string' && rec.toolCallId.trim()) return rec.toolCallId.trim();
  return 'tool';
}

/**
 * The option a confined turn answers with. `reject_once` is preferred over
 * `reject_always` so one denied request never poisons the agent's memory of
 * the tool for a later turn that runs under a different policy.
 *
 * Returns undefined only when the agent offered no reject option at all —
 * the one case where `{ outcome: 'cancelled' }` is the honest answer, even
 * though agents read that as "the prompt turn was cancelled".
 */
export function pickRejectPermissionOption(options: PermissionOption[]): string | undefined {
  const byKind = (k: string): PermissionOption | undefined => options.find((o) => o.kind === k);
  return (byKind('reject_once') ?? byKind('reject_always'))?.optionId;
}

/** Least-destructive allow: prefer allow_always, then allow_once, then any non-reject, then first. */
export function pickPermissionOption(options: PermissionOption[]): string | undefined {
  const first = options[0];
  if (!first) return undefined;
  const byKind = (k: string): PermissionOption | undefined => options.find((o) => o.kind === k);
  const nonReject = options.find((o) => !o.kind || !o.kind.startsWith('reject'));
  return (byKind('allow_always') ?? byKind('allow_once') ?? nonReject ?? first).optionId;
}

/** Transcript notice for an auto-allow decision. */
export function permissionAutoAllowNotice(
  optionId: string,
  options: PermissionOption[],
  toolTitle: string,
): Extract<TurnStreamEvent, { type: 'notice' }> {
  const picked = options.find((o) => o.optionId === optionId);
  const kind = picked?.kind ?? 'unknown';
  const name = picked?.name;
  const choice = name ? `${name} (${kind})` : `${optionId} (${kind})`;
  return {
    type: 'notice',
    level: 'info',
    code: 'permission_auto_allowed',
    message: `Auto-allowed agent permission for “${toolTitle}”: ${choice}.`,
  };
}

/** Transcript notice for a permission request refused by a confined surface. */
export function permissionDeniedNotice(
  toolTitle: string,
): Extract<TurnStreamEvent, { type: 'notice' }> {
  return {
    type: 'notice',
    level: 'warn',
    code: 'permission_denied',
    message: `Denied agent permission request for “${toolTitle}”. This turn may use only its pre-granted tools.`,
  };
}
