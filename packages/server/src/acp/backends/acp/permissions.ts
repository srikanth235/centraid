/*
 * Headless auto-answer: no surface can render an approval prompt, so waiting
 * would stall. `cancelled` unwinds the PROMPT TURN whole; a per-tool refusal
 * is `selected` naming reject_once/reject_always and keeps pre-granted tools.
 */

import type {
  PermissionOption,
  RequestPermissionRequest,
} from "@agentclientprotocol/sdk";

import type { TurnStreamEvent } from "@centraid/server/engine";

export function readPermissionOptions(
  params: RequestPermissionRequest
): PermissionOption[] {
  return params.options;
}

export function readPermissionToolTitle(
  params: RequestPermissionRequest
): string {
  const toolCall = params.toolCall;
  if (toolCall.title?.trim()) return toolCall.title.trim();
  if (toolCall.kind?.trim()) return toolCall.kind.trim();
  if (toolCall.toolCallId.trim()) return toolCall.toolCallId.trim();
  return "tool";
}

/** Undefined only when no reject option exists — caller then sends `cancelled`. */
export function pickRejectPermissionOption(
  options: PermissionOption[]
): string | undefined {
  const byKind = (k: string): PermissionOption | undefined =>
    options.find((o) => o.kind === k);
  return (byKind("reject_once") ?? byKind("reject_always"))?.optionId;
}

export function pickPermissionOption(
  options: PermissionOption[]
): string | undefined {
  const first = options[0];
  if (!first) return undefined;
  const byKind = (k: string): PermissionOption | undefined =>
    options.find((o) => o.kind === k);
  const nonReject = options.find(
    (o) => !o.kind || !o.kind.startsWith("reject")
  );
  return (byKind("allow_always") ?? byKind("allow_once") ?? nonReject ?? first)
    .optionId;
}

export function permissionAutoAllowNotice(
  optionId: string,
  options: PermissionOption[],
  toolTitle: string
): Extract<TurnStreamEvent, { type: "notice" }> {
  const picked = options.find((o) => o.optionId === optionId);
  const kind = picked?.kind ?? "unknown";
  const name = picked?.name;
  const choice = name ? `${name} (${kind})` : `${optionId} (${kind})`;
  return {
    type: "notice",
    level: "info",
    code: "permission_auto_allowed",
    message: `Auto-allowed harness permission for “${toolTitle}”: ${choice}.`,
  };
}

export function permissionDeniedNotice(
  toolTitle: string
): Extract<TurnStreamEvent, { type: "notice" }> {
  return {
    type: "notice",
    level: "warn",
    code: "permission_denied",
    message: `Denied harness permission request for “${toolTitle}”. This turn may use only its pre-granted tools.`,
  };
}
