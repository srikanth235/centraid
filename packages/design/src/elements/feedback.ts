// The one feedback channel that follows the user, plus the states that stand
// in for content: the status line, the outcome sentence, the skeleton, the
// read-failure banner, confirm-to-act, and the bulk runner that narrates.

import { applyInOrder } from "./dom.js";
import { haptic } from "./host.js";

export type VaultOutcomeStatus =
  | "executed"
  | "parked"
  | "queued"
  | "in-flight"
  | "failed"
  | "denied";

/** The typed-command result an app narrates. */
export interface VaultOutcome {
  status: VaultOutcomeStatus;
  output?: Record<string, unknown>;
  reason?: string;
  predicate?: string;
  message?: string;
  invocationId?: string;
  receiptId?: string;
  code?: string;
}

export interface StatusLineOptions {
  undoLabel?: string;
  onUndo?: () => void;
  /** Ms before the line reverts to quiet (default 5000; sticky if 0). Ignored
   *  while `progress` is running — a determinate operation clears itself. */
  duration?: number;
  /** Feedback tone is explicit; neutral updates do not vibrate or imply
   *  success. The status line's dot stays a fixed neutral colour regardless
   *  — tone only ever selects the haptic, never a visual hue. */
  tone?: "affirm" | "change" | "destructive" | "none";
  /** A long local operation: renders a determinate track+fill bar with exact
   *  counts instead of a spinner. */
  progress?: { done: number; total: number };
}

// ---------- Status line ----------
//
// Retired the floating `toast` stack (#707 Phase 3 — the Binding Layer's
// fifth invariant): state is reported on ONE persistent line docked to the
// bottom of the frame, updated IN PLACE. There is no stack, no per-call
// element, and no entry/exit animation — a single `.kit-status-line` element
// is mounted once and its children swap under it. A duration still clears the
// message back to quiet, but the line itself never leaves the DOM.
//
// #799 retired the `<kit-status-line>` custom element that used to wrap this:
// the host is now the live region itself. That is stronger than the element
// was — the element re-created the `role="status"`/`aria-live` div on every
// render, and a live region that is replaced rather than mutated is not
// reliably announced.

let statusLineHost: HTMLElement | null = null;
// Module-level, not per-call: the host is reused across every `statusLine()`
// call, so the pending auto-clear timer has to be shared too — a per-call
// local would let an OLDER call's timer fire later and wipe a NEWER (or
// sticky, duration 0) message it knows nothing about.
let statusLineTimer = 0;
// Read at CLICK time by the inline action, never captured at render time, so
// a stale render's button can never invoke a superseded handler.
let statusLineUndo: (() => void) | undefined;

function ensureStatusLineHost(): HTMLElement {
  if (statusLineHost) return statusLineHost;
  const host = document.createElement("div");
  host.className = "kit-status-line";
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  document.body.appendChild(host);
  statusLineHost = host;
  return host;
}

/** Paint the one line's contents. Called for every update; never re-mounts. */
function renderStatusLine(
  host: HTMLElement,
  {
    text,
    undoLabel,
    done,
    total,
  }: {
    text: string;
    undoLabel: string;
    done: number | null;
    total: number | null;
  }
): void {
  const children: HTMLElement[] = [];

  const dot = document.createElement("span");
  dot.className = "kit-status-line-dot";
  dot.setAttribute("aria-hidden", "true");
  children.push(dot);

  const span = document.createElement("span");
  span.className = "kit-status-line-text";
  span.textContent = text;
  children.push(span);

  if (total != null && total > 0) {
    const track = document.createElement("span");
    track.className = "kit-status-line-track";
    const fill = document.createElement("span");
    fill.className = "kit-status-line-fill";
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, (done ?? 0) / total)) * 100)}%`;
    track.appendChild(fill);
    children.push(track);
  }

  if (undoLabel) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "kit-status-line-action";
    action.textContent = undoLabel;
    action.addEventListener("click", () => statusLineUndo?.());
    children.push(action);
  }

  host.replaceChildren(...children);
}

/**
 * Update the one persistent status line. Options:
 *  - undoLabel/onUndo: the line's single inline text action (e.g. Undo).
 *  - duration: ms before the line reverts to quiet (default 5000; sticky if
 *    0). Ignored while `progress` is set.
 *  - tone: semantic outcome; only explicit non-neutral tones haptically
 *    signal — the dot stays neutral regardless.
 *  - progress: {done,total} renders a determinate bar with exact counts
 *    instead of a spinner, for a long local operation.
 */
export function statusLine(
  text: string,
  {
    undoLabel,
    onUndo,
    duration = 5000,
    tone = "none",
    progress,
  }: StatusLineOptions = {}
): () => void {
  if (tone === "affirm") haptic("success");
  else if (tone === "change" || tone === "destructive") haptic("selection");
  const line = ensureStatusLineHost();
  const clear = (): void => {
    clearTimeout(statusLineTimer);
    statusLineUndo = undefined;
    renderStatusLine(line, {
      text: "",
      undoLabel: "",
      done: null,
      total: null,
    });
  };
  const label = undoLabel && onUndo ? undoLabel : "";
  // Assigned before the render so the freshly built button's click handler —
  // which reads this module slot rather than closing over a handler — always
  // sees the handler belonging to the message it is painted beside.
  statusLineUndo =
    label && onUndo
      ? () => {
          clear();
          onUndo();
        }
      : undefined;
  renderStatusLine(line, {
    text,
    undoLabel: label,
    done: progress ? progress.done : null,
    total: progress ? progress.total : null,
  });
  clearTimeout(statusLineTimer);
  // A determinate operation clears itself when the caller reports it done
  // (done >= total) or is left running; a plain message reverts on its own
  // duration. Sticky (duration 0) leaves the line up for an explicit clear.
  if (!progress && duration > 0) {
    statusLineTimer = setTimeout(clear, duration) as unknown as number;
  }
  return clear;
}

/** The shared translation of a typed-command outcome into a human sentence. */
export function outcomeMessage(
  outcome: VaultOutcome | null | undefined
): string | null {
  if (outcome?.status === "queued" || outcome?.status === "in-flight") {
    return (
      outcome.reason ??
      "Saved on this device — it will sync when the gateway is reachable."
    );
  }
  if (outcome?.status === "parked") {
    return "Waiting for your approval — open Notifications to review it.";
  }
  if (outcome?.status === "failed") {
    const detail =
      outcome.predicate ?? outcome.reason ?? "a precondition failed";
    // A command-authored friendly message (see ConditionSpec.message) is
    // already a full sentence with its own punctuation — don't double it up
    // ("...on your calendar..") the way the raw `name: column op value`
    // fallback needs its trailing period added.
    return `The vault refused: ${detail}${/[.!?]$/u.test(detail) ? "" : "."}`;
  }
  if (outcome?.status === "denied") {
    return `Denied by consent${outcome.reason ? `: ${outcome.reason}` : "."}`;
  }
  return null;
}

// ---------- Loading and read-error states ----------

/**
 * Fill a container with placeholder rows while the first read is in flight.
 * The React surfaces render the same `.kit-skeleton` rows through
 * `_shared/LoadingSkeleton.tsx`; this is the imperative twin for the DOM
 * surfaces that have no React tree (#799 retired the `<kit-skeleton>` element
 * both used to go through).
 */
export function showSkeleton(container: Element, rows = 3): void {
  container.replaceChildren(
    ...Array.from({ length: Math.max(0, rows) }, () => {
      const row = document.createElement("div");
      row.className = "kit-skeleton";
      return row;
    })
  );
}

/**
 * Surface a failed read in the app's notice banner instead of silence —
 * a broken vault must not look like an empty one.
 */
export function readFailed(bannerEl: HTMLElement | null | undefined): void {
  if (!bannerEl) return;
  bannerEl.textContent =
    "Couldn’t reach the vault — retrying when you come back.";
  bannerEl.hidden = false;
}

// ---------- Confirm-to-act (arm on first click, run on second) ----------

/**
 * Returns true when the click should proceed. First click arms the button
 * (label swap + auto-disarm after `timeout` ms); second click confirms.
 */
export function armConfirm(
  btn: HTMLElement,
  {
    armedLabel = "Sure?",
    timeout = 3000,
  }: { armedLabel?: string; timeout?: number } = {}
): boolean {
  if (btn.dataset.kitArmed === "true") {
    clearTimeout(Number(btn.dataset.kitArmTimer));
    delete btn.dataset.kitArmed;
    btn.textContent = btn.dataset.kitLabel ?? btn.textContent;
    return true;
  }
  haptic("selection");
  btn.dataset.kitArmed = "true";
  btn.dataset.kitLabel = btn.textContent ?? "";
  btn.textContent = armedLabel;
  btn.dataset.kitArmTimer = String(
    setTimeout(() => {
      delete btn.dataset.kitArmed;
      btn.textContent = btn.dataset.kitLabel ?? btn.textContent;
    }, timeout)
  );
  return false;
}

// ---------- Bulk runner (selection-bar actions) ----------

/**
 * Run `run(id)` over `ids` sequentially, narrating progress and the final
 * tally. The app supplies its voice + cleanup: `notice(text)`,
 * `friendly(outcome) → string|null` for failure copy, `after()` once done.
 */
export async function runBulk(
  ids: string[],
  run: (id: string) => Promise<VaultOutcome | undefined>,
  {
    progress,
    done,
    suffix = "",
    notice,
    friendly,
    after,
  }: {
    progress: string;
    done: string;
    suffix?: string;
    notice: (text: string) => void;
    friendly?: (outcome: VaultOutcome | undefined) => string | null;
    after?: () => void | Promise<void>;
  }
): Promise<void> {
  const n = ids.length;
  let ok = 0;
  let parked = 0;
  const failures: string[] = [];
  await applyInOrder(Array.from({ length: n }), async (_, i) => {
    notice(`${progress} ${i + 1} of ${n}…`);
    const outcome = await run(ids[i] as string);
    if (outcome?.status === "executed") ok += 1;
    else if (outcome?.status === "parked") parked += 1;
    else failures.push(friendly?.(outcome) ?? "The write failed.");
  });
  notice(
    failures.length > 0
      ? `${failures.length} of ${n} didn’t go through — ${failures[0]}`
      : ""
  );
  const parts = [`${done} ${ok} of ${n}${suffix} · receipted.`];
  if (parked > 0) parts.push(`${parked} waiting for approval.`);
  statusLine(parts.join(" "));
  await after?.();
}
