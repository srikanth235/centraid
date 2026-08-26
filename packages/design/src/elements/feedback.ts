// The one feedback channel, and the stand-ins for content.

import { applyInOrder } from "./dom.js";
import { haptic } from "./host.js";

export type VaultOutcomeStatus =
  | "executed"
  | "parked"
  | "queued"
  | "in-flight"
  | "failed"
  | "denied";

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
  /** 0 is sticky; ignored while `progress` runs. */
  duration?: number;
  /** Selects the haptic only: the dot stays neutral. */
  tone?: "affirm" | "change" | "destructive" | "none";
  /** A determinate bar, never a spinner. */
  progress?: { done: number; total: number };
}

// ────────── Status line ──────────
//
// NO TOAST STACK (#707): ONE `.kit-status-line`, mounted once and updated in
// place. It is the live region (#799) — replacing it breaks announcement.

let statusLineHost: HTMLElement | null = null;
// Module-level: a per-call timer lets an old call wipe a new one.
let statusLineTimer = 0;
// Read at CLICK time, never at render.
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

/** See `StatusLineOptions`. */
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
  // Assigned BEFORE the render: the button must read its own handler.
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
  // A determinate operation clears itself; sticky waits.
  if (!progress && duration > 0) {
    statusLineTimer = setTimeout(clear, duration) as unknown as number;
  }
  return clear;
}

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
    // A `ConditionSpec.message` is punctuated; the fallback is not.
    return `The vault refused: ${detail}${/[.!?]$/u.test(detail) ? "" : "."}`;
  }
  if (outcome?.status === "denied") {
    return `Denied by consent${outcome.reason ? `: ${outcome.reason}` : "."}`;
  }
  return null;
}

// ────────── Loading / read errors ──────────

export function showSkeleton(container: Element, rows = 3): void {
  container.replaceChildren(
    ...Array.from({ length: Math.max(0, rows) }, () => {
      const row = document.createElement("div");
      row.className = "kit-skeleton";
      return row;
    })
  );
}

/** A broken vault must not look like an empty one. */
export function readFailed(bannerEl: HTMLElement | null | undefined): void {
  if (!bannerEl) return;
  bannerEl.textContent =
    "Couldn’t reach the vault — retrying when you come back.";
  bannerEl.hidden = false;
}

// ────────── Confirm-to-act ──────────

/** True when the click should proceed: first arms, second confirms. */
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

// ────────── Bulk runner ──────────

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
