/*
 * `session/request_permission` — the one server→client request we answer with
 * a decision rather than a refusal.
 *
 * Wire shape (verified against the public ACP spec):
 *   `session/request_permission` { sessionId, toolCall, options: [{ optionId,
 *   name, kind }] } → { outcome: { outcome: 'selected', optionId } |
 *   { outcome: 'cancelled' } }.
 *
 * We auto-allow the least-destructive option, matching the headless policy
 * codex/claude already run under: nothing in this surface can render an
 * approval prompt, so a turn that waited for one would simply stall.
 */

export interface PermissionOption {
  optionId: string;
  kind?: string;
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
    out.push({ optionId, ...(typeof rec.kind === 'string' ? { kind: rec.kind } : {}) });
  }
  return out;
}

/** Least-destructive allow: prefer allow_always, then allow_once, then any non-reject, then first. */
export function pickPermissionOption(options: PermissionOption[]): string | undefined {
  const first = options[0];
  if (!first) return undefined;
  const byKind = (k: string): PermissionOption | undefined => options.find((o) => o.kind === k);
  const nonReject = options.find((o) => !o.kind || !o.kind.startsWith('reject'));
  return (byKind('allow_always') ?? byKind('allow_once') ?? nonReject ?? first).optionId;
}
