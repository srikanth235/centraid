// Outcome narration + the write trampoline; keep domain state out.
//
// MULTI-SCOPE (#599): a write ABOUT an asset passes `asset.scope_id` itself —
// favouriting in a shared audience must edit it there. A write that CREATES
// asks `writeTarget()`, and a disabled answer disables the control rather than
// firing a refused write. Before app-root.tsx registers the resolver, the
// answer is the ambient scope.
import { outcomeMessage } from "@centraid/design/elements";

import type { WriteTarget } from "../_shared/write-target.ts";

/** `own` is for collections authored only in the member's own space. */
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

/** The ONE status line belongs to the FRAME (§3, §14): no second line, badge,
 *  spinner or dot. Without a frame these are no-ops. */
export interface StatusNote {
  text: string;
  undo?: () => void;
  /** Determinate counts (§14), never a spinner, on the SAME line. */
  progress?: { done: number; total: number };
}

let statusSink: ((note: StatusNote | null) => void) | null = null;

export function setStatusSink(
  fn: ((note: StatusNote | null) => void) | null
): void {
  statusSink = fn;
}

/** `""` takes the line down. A caller that cannot count says nothing rather
 *  than animate an indeterminate meter. */
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

/** An empty or absent `scope` addresses the ambient one. */
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
    // A read-only audience refuses with a human message: narration, not a
    // crash.
    const e = error as { message?: string };
    notice(String(e?.message ?? error));
    return undefined;
  }
}
