import { outcomeMessage } from "@centraid/design/elements";

import type { WriteTarget } from "../_shared/write-target.ts";

export type WriteTargetKind = "new" | "own";

const AMBIENT_TARGET: WriteTarget = {
  disabled: false,
  scopeId: "",
  label: "Library",
};

let resolveTarget: (kind: WriteTargetKind) => WriteTarget = () =>
  AMBIENT_TARGET;

export function setWriteTargetResolver(
  fn: (kind: WriteTargetKind) => WriteTarget
): void {
  resolveTarget = fn;
}

export function writeTarget(kind: WriteTargetKind = "new"): WriteTarget {
  return resolveTarget(kind);
}

export interface StatusNote {
  text: string;
  undo?: () => void;
  progress?: { done: number; total: number };
}

let statusSink: ((note: StatusNote | null) => void) | null = null;

export function setStatusSink(
  fn: ((note: StatusNote | null) => void) | null
): void {
  statusSink = fn;
}

export function notice(
  text: string,
  undo?: () => void,
  progress?: { done: number; total: number }
): void {
  statusSink?.(
    text
      ? { text, ...(undo ? { undo } : {}), ...(progress ? { progress } : {}) }
      : null
  );
}

export function narrate(
  outcome: VaultOutcome | null | undefined,
  noteEl?: HTMLElement | null
): boolean {
  if (outcome?.status === "executed") {
    notice("");
    if (noteEl) noteEl.textContent = "";
    return true;
  }
  const msg = outcomeMessage(outcome);
  if (msg != null) {
    notice(msg);
    if (noteEl) noteEl.textContent = msg;
  }
  return false;
}

export async function act(
  action: string,
  input?: Record<string, unknown>,
  scope?: string | null
): Promise<VaultOutcome | undefined> {
  try {
    return await window.centraid.write({
      action,
      input,
      ...(scope ? { scope } : {}),
    });
  } catch (error) {
    const e = error as { message?: string };
    notice(String(e?.message ?? error));
    return undefined;
  }
}
