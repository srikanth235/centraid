// governance: allow-repo-hygiene file-size-limit the kit is the single canonical bundle every app loads verbatim (UX primitives, attachments, charts, and the @-mention controllers); splitting it would fracture that one-module contract without reducing surface
/* oxlint-disable typescript-eslint/ban-ts-comment -- this source-consolidation
   makes the implementation the public type source; the imperative DOM
   controllers still need a follow-up strictness pass (#799). */
// @ts-nocheck
import {
  sha256FileStream,
  stageDirectFile,
  stageFallbackFile,
} from "./edge-upload.js";
// Centraid blueprint kit — the shared UX substrate for template apps.
//
// Canonical (and ONLY) copy: packages/design/kit/kit.ts. Apps don't carry
// their own copies — they import `./kit.ts` as a sibling and each shell's
// bundler resolves it to this dir (`KIT_DIR`, via `inline-vite-aliases.ts`).
// Edit here and every app picks it up on the next build.
//
// Everything here is presentation plumbing the 14 apps used to hand-roll
// with drift: outcome status lines, loading/error states, confirm-to-act,
// money and local-date formatting, letter avatars, and small SVG charts. App
// logic stays in each app.js.
//
// The presentation PRIMITIVES (avatar, meter, charts, skeleton, status line,
// mention chip, reference strip) are now native Web Components defined in
// `elements.js` (issue #327). Importing it here runs the `customElements.define()`
// calls; the factory functions below (`letterAvatar`, `lineChart`, `statusLine`,
// …) construct + configure those elements, so app code that calls them is
// unchanged (the Binding Layer flip only renamed `toast` to `statusLine` —
// #707 Phase 3). The
// live-network controllers (@-mention popover/field) stay as the imperative
// controllers they always were — see the excluded set in issue #327.
import { entityKindLabel } from "./elements.js";
import {
  formatBytes as sharedFormatBytes,
  formatRelativeTime,
} from "./format.js";

export { entityKindLabel } from "./elements.js";

/** Apply side effects in source order when later work must not start early. */
function applyInOrder<T>(
  values: Iterable<T>,
  apply: (value: T, index: number) => void | PromiseLike<void>
): Promise<void> {
  let index = 0;
  return Array.from(values).reduce<Promise<void>>(
    (sequence, value) => sequence.then(() => apply(value, index++)),
    Promise.resolve()
  );
}

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

export interface CentraidChangeDetail {
  tables?: string[];
  source?: string;
  intentId?: string;
  intentState?: string;
  ts?: number;
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

export interface ReadSubscription {
  managed: boolean;
  unsubscribe: () => void;
}

export interface AvatarOptions {
  size?: string;
  color?: string;
  initials?: string;
  src?: string;
  shape?: string;
}

export interface ChartPoint {
  x: number;
  y: number;
}

export interface BarItem {
  label: string;
  value: number;
}

export interface StagedBlob {
  sha256: string;
  mediaType?: string | null;
  byteSize?: number;
  existingContentId?: string | null;
  casAck?: string | null;
  custody?: string | null;
  alreadyPresent?: boolean;
  [key: string]: unknown;
}

export interface Attachment {
  attachment_id: string;
  content_id?: string;
  media_type?: string;
  title?: string | null;
  content_uri?: string;
  byte_size?: number;
  [key: string]: unknown;
}

export interface Reference {
  linkId?: string;
  type?: string;
  id?: string;
  relation?: string;
  [key: string]: unknown;
}

// Re-export the shared kind-label helper (its definition moved to elements.js,
// where the mention-chip and reference-strip components also need it).

// ---------- Tiny DOM builders (the h()/el() every app copied from Docs) -----

/** Parse an HTML string and return its first element. */
export function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/**
 * Hyperscript element builder: `h('div', { class, html, style, on* }, ...kids)`.
 * Null/false props and kids are skipped; string kids become text nodes.
 */
export function h(
  tag: string,
  props: Record<string, unknown> = {},
  ...kids: unknown[]
): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "style") e.setAttribute("style", v);
    else if (k.startsWith("on") && typeof v === "function")
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

// ---------- Native haptics (feature-detected, best-effort) ----------

// The mobile shell exposes `window.centraid.haptic.*` on its native bridge;
// the desktop iframe has no such surface. Feature-detect and swallow every
// failure so the kit behaves identically wherever the app renders.
function haptic(kind) {
  try {
    window.centraid?.haptic?.[kind]?.();
  } catch {
    /* bridge absent or refused — visual feedback already covers it */
  }
}

// ---------- Status line (the one feedback channel that follows the user) ---
//
// Retired the floating `toast` stack (#707 Phase 3 — the Binding Layer's
// fifth invariant): state is reported on ONE persistent line docked to the
// bottom of the frame, updated IN PLACE. There is no stack, no per-call
// element, and no entry/exit animation — a single `<kit-status-line>` is
// mounted once and its properties change under it. A duration still clears
// the message back to quiet, but the line itself never leaves the DOM.

let statusLineHost = null;
// Module-level, not per-call: the host is reused across every `statusLine()`
// call, so the pending auto-clear timer has to be shared too — a per-call
// local would let an OLDER call's timer fire later and wipe a NEWER (or
// sticky, duration 0) message it knows nothing about.
let statusLineTimer = 0;

function ensureStatusLineHost() {
  if (statusLineHost) return statusLineHost;
  statusLineHost = document.createElement("kit-status-line");
  document.body.appendChild(statusLineHost);
  return statusLineHost;
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
  const clear = () => {
    clearTimeout(statusLineTimer);
    line.text = "";
    line.undoLabel = "";
    line.onUndo = undefined;
    line.done = null;
    line.total = null;
  };
  line.text = text;
  line.undoLabel = undoLabel && onUndo ? undoLabel : "";
  // The button reads `this.onUndo` at CLICK time, not at render time, so
  // setting it in any order relative to the other properties above is safe —
  // there is only ever one live handler, never a stack of accumulated
  // listeners the way a `addEventListener` on a reused host would leak.
  line.onUndo =
    undoLabel && onUndo
      ? () => {
          clear();
          onUndo();
        }
      : undefined;
  line.done = progress ? progress.done : null;
  line.total = progress ? progress.total : null;
  clearTimeout(statusLineTimer);
  // A determinate operation clears itself when the caller reports it done
  // (done >= total) or is left running; a plain message reverts on its own
  // duration. Sticky (duration 0) leaves the line up for an explicit clear.
  if (!progress && duration > 0) {
    statusLineTimer = setTimeout(clear, duration);
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

/** Fill a container with shimmer rows while the first read is in flight. */
export function showSkeleton(container: Element, rows = 3): void {
  container.innerHTML = "";
  const elLocal = document.createElement("kit-skeleton");
  elLocal.rows = rows;
  container.appendChild(elLocal);
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

/**
 * Subscribe to a live read's future values without applying its current value
 * twice. The replica bridge deliberately emits the current value to a new
 * subscriber; callers also await the same read for their initial paint, so
 * this helper consumes that first subscription emission and forwards reruns.
 * Plain-Promise compatibility reads remain unmanaged.
 */
export function subscribeReadUpdates<T = unknown>(
  read: unknown,
  onUpdate: (value: T) => void
): ReadSubscription {
  if (typeof read?.subscribe !== "function") {
    return { managed: false, unsubscribe: () => {} };
  }
  let settled = false;
  let buffered = false;
  let latest;
  const unsubscribe = read.subscribe((value) => {
    if (!settled) {
      latest = value;
      buffered = true;
      return;
    }
    onUpdate(value);
  });
  Promise.resolve(read)
    .then((initial) => {
      settled = true;
      if (buffered && latest !== initial)
        queueMicrotask(() => onUpdate(latest));
    })
    .catch(() => {
      settled = true;
    });
  return { managed: true, unsubscribe };
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
  btn.dataset.kitLabel = btn.textContent;
  btn.textContent = armedLabel;
  btn.dataset.kitArmTimer = String(
    setTimeout(() => {
      delete btn.dataset.kitArmed;
      btn.textContent = btn.dataset.kitLabel ?? btn.textContent;
    }, timeout)
  );
  return false;
}

// ---------- Formatting ----------

/** Minor units → localized currency string ("€12.34"), tolerant of gaps. */
export function fmtMoney(
  minor: number | null | undefined,
  currency?: string
): string {
  // Keep the same contract as @centraid/client formatCurrencyMinor so web
  // Home, Tally, and Capture never diverge on invalid ISO codes.
  const value = Number(minor ?? 0) / 100;
  const code =
    typeof currency === "string" && /^[A-Za-z]{3}$/u.test(currency)
      ? currency.toUpperCase()
      : "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`.trim();
  }
}

/** The viewer's local YYYY-MM-DD for an instant — never the UTC slice. */
export function localDayKey(dateish: string | number | Date): string {
  const d = dateish instanceof Date ? dateish : new Date(dateish);
  if (Number.isNaN(d.getTime())) return String(dateish).slice(0, 10);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The viewer's local YYYY-MM for an instant. */
export function localMonthKey(dateish: string | number | Date): string {
  return localDayKey(dateish).slice(0, 7);
}

/** "5m" / "3h" / "2d" / "Mar 4" — the notifications-style relative timestamp. */
export function relTime(iso: string): string {
  const label = formatRelativeTime(iso);
  return label === "Recently" ? "" : label;
}

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms = 200
): (...args: Args) => void {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------- Refresh discipline (data-change + focus) ----------
//
// Every app re-derives what it renders from the vault, so the two cheap
// mistakes are (a) re-reading on every doorbell even when nothing this app
// cares about moved, and (b) re-reading on every window 'focus' even when the
// last read was a moment ago (alt-tab thrash). These two tiny wrappers give
// both a common, honest discipline; nothing here holds state beyond one timer
// and one timestamp.

/**
 * Subscribe to `window.centraid.onChange` with a trailing debounce and a
 * tables filter. `tables` is the set of vault entities this app reads
 * (e.g. `['knowledge.note', 'core.tag']`). A change names the tables it
 * touched; we skip the callback only when that list is NON-EMPTY and misses
 * every declared table — an empty list means "this app acted, re-derive"
 * (post-#286 handler writes carry no tables), so it always fires. Returns an
 * unsubscribe fn.
 */
export function onDataChange(
  tables: string[] | null | undefined,
  cb: (detail: CentraidChangeDetail) => void,
  { debounceMs = 200 }: { debounceMs?: number } = {}
): () => void {
  const want = new Set(tables);
  let timer = 0;
  const pending = new Map();
  const unsub = window.centraid?.onChange?.((detail) => {
    const named = detail && Array.isArray(detail.tables) ? detail.tables : null;
    if (named && named.length && want.size && !named.some((t) => want.has(t)))
      return;
    const key =
      detail?.source === "overlay" && typeof detail?.intentId === "string"
        ? `${detail.intentId}:${detail.intentState ?? ""}`
        : "latest";
    pending.set(key, detail);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const details = [...pending.values()];
      pending.clear();
      details.forEach(cb);
    }, debounceMs);
  });
  return () => {
    clearTimeout(timer);
    pending.clear();
    unsub?.();
  };
}

/**
 * Refresh on window 'focus', but skip when the last focus-refresh fired less
 * than `minIntervalMs` ago — a blur/focus flurry (alt-tab, devtools) must not
 * re-hit the vault each time. Independent of onDataChange's timer: a real
 * change still refreshes immediately. The gate never applies while a consent
 * banner (`#consentBanner`) is up: focus is the recovery path when access was
 * just re-granted, so a denied app must always re-read on focus. Returns an
 * unsubscribe fn.
 */
export function onFocusRefresh(
  cb: () => void,
  { minIntervalMs = 30000 }: { minIntervalMs?: number } = {}
): () => void {
  let last = 0;
  const onFocus = () => {
    const banner = document.querySelector("#consentBanner");
    const recovering = banner && !banner.hidden;
    const now = Date.now();
    if (!recovering && now - last < minIntervalMs) return;
    last = now;
    cb();
  };
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}

/**
 * Track an element's width and call `onNarrow(isNarrow)` whenever it crosses
 * `breakpoint` (or `data-app-width="narrow"` is forced). Prefers a
 * `ResizeObserver` (fires only on real size changes, and pauses when the tab
 * is hidden because layout doesn't change off-screen); falls back to a
 * visibility-gated poll only where RO is unavailable. Fires once immediately.
 * Returns a stop fn.
 */
export function observeWidth(
  elLocal: Element | null,
  breakpoint: number,
  onNarrow: (isNarrow: boolean) => void,
  { pollMs = 250 }: { pollMs?: number } = {}
): () => void {
  const measure = () => {
    if (!elLocal) return;
    const forced = document.documentElement.dataset.appWidth === "narrow";
    onNarrow(forced || elLocal.clientWidth < breakpoint);
  };
  measure();
  if (typeof ResizeObserver === "function" && elLocal) {
    const ro = new ResizeObserver(measure);
    ro.observe(elLocal);
    // The forced-narrow knob flips an attribute, not a size — catch it too.
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }
  const id = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    measure();
  }, pollMs);
  return () => clearInterval(id);
}

// ---------- Letter avatars ----------

/**
 * A letter avatar element (see `<kit-avatar>`). Hue hashes from the name
 * unless `color` pins one; `initials` pins the letters; `src` swaps in a
 * photo; `shape: 'rounded'` squares the corners for file/doc tiles.
 */
export function letterAvatar(
  name: string,
  { size = "2.25rem", color, initials, src, shape }: AvatarOptions = {}
): HTMLElement {
  const elLocal = document.createElement("kit-avatar");
  elLocal.name = String(name ?? "?");
  elLocal.size = size;
  if (color) elLocal.color = color;
  if (initials) elLocal.initials = initials;
  if (src) elLocal.src = src;
  if (shape) elLocal.shape = shape;
  return elLocal;
}

// ---------- SVG chart primitives (native elements — see elements.js) ----------
// The chart geometry now lives in the `<kit-line-chart>` / `<kit-bar-chart>`
// custom elements; these factories build + configure them so callers that
// append the returned element keep working.

/**
 * A time-aware line chart element: points are {x: epochMs, y: number}. Renders a
 * line, soft area fill, and an emphasized last point (see `<kit-line-chart>`).
 */
export function lineChart(
  points: ChartPoint[],
  {
    width = 640,
    height = 160,
    label = "Trend",
  }: {
    width?: number;
    height?: number;
    label?: string;
  } = {}
): HTMLElement {
  const elLocal = document.createElement("kit-line-chart");
  elLocal.points = points ?? [];
  elLocal.width = width;
  elLocal.height = height;
  elLocal.label = label;
  return elLocal;
}

/** Horizontal proportion bar element (e.g. cost share behind a row's amount). */
export function barSpan(
  ratio: number,
  { tone }: { tone?: string } = {}
): HTMLElement {
  const elLocal = document.createElement("kit-meter");
  elLocal.ratio = ratio;
  if (tone) elLocal.tone = tone;
  return elLocal;
}

/** Vertical bar chart element for period totals: items are {label, value} (see `<kit-bar-chart>`). */
export function barChart(
  items: BarItem[],
  {
    width = 640,
    height = 160,
    label = "Totals",
  }: {
    width?: number;
    height?: number;
    label?: string;
  } = {}
): HTMLElement {
  const elLocal = document.createElement("kit-bar-chart");
  elLocal.items = items ?? [];
  elLocal.width = width;
  elLocal.height = height;
  elLocal.label = label;
  return elLocal;
}

// ---------- Attachments (the "shared pattern across apps", now actually shared) ----------
// Small files travel inline as data: URIs through the command JSON; larger
// ones stream to the vault's blob staging route and attach by sha (issue #296).

export const BLOB_ROUTE = "/centraid/_vault/blobs";
export const INLINE_ATTACH_BYTES = 256 * 1024;

/** Read a File into a data: URI (the inline path for small attachments). */
export function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.addEventListener("load", () => resolve(String(r.result)), {
      once: true,
    });
    r.addEventListener(
      "error",
      () => reject(r.error ?? new Error("Unable to read file")),
      { once: true }
    );
    r.readAsDataURL(file);
  });
}

/**
 * Incremental SHA-256 over the File stream. Callers opt in because hashing
 * is a full read pass; memory stays bounded and the upload body itself still
 * streams from the File on the following fetch.
 */
export async function sha256File(file: File): Promise<string | null> {
  if (typeof file?.arrayBuffer !== "function") return null;
  return sha256FileStream(file);
}

/** Submit a typed contribution through the existing authenticated blob door. */
export async function stageDerivative(
  parentSha: string,
  variant: string,
  body: BodyInit,
  mediaType = "application/octet-stream"
): Promise<StagedBlob> {
  const q = new URLSearchParams({
    variant,
    variant_of: parentSha,
    media_type: mediaType,
  });
  const res = await fetch(`${BLOB_ROUTE}?${q}`, {
    method: "POST",
    headers: { "content-type": mediaType },
    body,
  });
  if (!res.ok)
    throw new Error(`${variant} contribution refused (${res.status})`);
  return res.json();
}

/** Strict policy acknowledges success only after provider custody. */
export function isPendingOffsite(
  staged: StagedBlob | null | undefined
): boolean {
  return (
    staged?.casAck === "replicated" &&
    staged?.custody !== "replicated" &&
    staged?.custody !== "remote-only"
  );
}

/**
 * Stream a File to the blob staging route; resolves the staging receipt
 * ({sha256, …}). `extra` appends pre-encoded query params (e.g. `&kind=…`).
 * With `{hash: true}`, preflight a client-declared sha and ship zero bytes
 * when another device already established custody; the gateway still hashes
 * and verifies every POST authoritatively.
 *
 * `scope` (issue #599) names WHICH mounted scope the bytes land in — a
 * multi-scope app adding to a shared audience must not stage into the member's
 * own CAS. It rides as the vault header on every request this function issues.
 * Two deliberate consequences on this served path: the resumable session and
 * direct-upload routes are skipped when a scope is named (their handshakes
 * address the request's ambient vault, so a scoped upload would silently land
 * in the wrong one), leaving the authoritative POST, which does carry the
 * header. Inline hosts substitute their own implementation (packages/client
 * kit-inline.ts) where every route is scope-addressed.
 */
export async function stageFileBytes(
  file: File,
  extra = "",
  { hash = true, scope }: { hash?: boolean; scope?: string } = {}
): Promise<StagedBlob> {
  const q = new URLSearchParams();
  if (file.name) q.set("filename", file.name);
  if (file.type) q.set("media_type", file.type);
  const scopeHeader = scope ? { "x-centraid-vault": scope } : {};
  let declaredSha = null;
  if (hash) {
    try {
      declaredSha = await sha256File(file);
    } catch {
      declaredSha = null; // hashing support is an optimization, never an upload gate
    }
  }
  if (declaredSha) {
    q.set("sha256", declaredSha);
    try {
      const preflight = new URLSearchParams({ byte_size: String(file.size) });
      if (file.type) preflight.set("media_type", file.type);
      if (file.name) preflight.set("filename", file.name);
      const have = await fetch(
        `${BLOB_ROUTE}/_sha/${declaredSha}?${preflight}`,
        {
          method: "HEAD",
          headers: scopeHeader,
        }
      );
      if (have.ok) {
        return {
          sha256: declaredSha,
          mediaType:
            have.headers.get("x-centraid-media-type") ?? file.type ?? null,
          byteSize:
            Number(have.headers.get("content-length")) || file.size || 0,
          existingContentId: have.headers.get("x-centraid-content-id"),
          casAck: have.headers.get("x-centraid-cas-ack"),
          custody: have.headers.get("x-centraid-custody"),
          alreadyPresent: true,
        };
      }
    } catch {
      // Older/offline gateways simply take the normal authoritative POST.
    }
    if (!scope) {
      const direct = await stageDirectFile(file, declaredSha);
      if (direct) return direct;
      const fallback = await stageFallbackFile(file, declaredSha);
      if (fallback) return fallback;
    }
    // Session/direct routes are optional protocol extensions. The permanent
    // authoritative POST remains the compatibility and backpressure fallback.
    const legacy = await fetch(`${BLOB_ROUTE}?${q}${extra}`, {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "x-content-sha256": declaredSha,
        ...scopeHeader,
      },
      body: file,
    });
    if (!legacy.ok) throw new Error(`upload refused (${legacy.status})`);
    return legacy.json();
  }
  const res = await fetch(`${BLOB_ROUTE}?${q}${extra}`, {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream",
      ...(declaredSha ? { "x-content-sha256": declaredSha } : {}),
      ...scopeHeader,
    },
    body: file,
  });
  if (!res.ok) throw new Error(`upload refused (${res.status})`);
  return res.json();
}

/** "812 B" / "24 KB" / "1.3 MB" — `empty` is returned for 0/absent sizes. */
export function fmtBytes(n: number | null | undefined, empty = ""): string {
  if (!n || !Number.isFinite(Number(n)) || n < 0) return empty;
  return sharedFormatBytes(n);
}

/**
 * Fill `stripEl` with attachment tiles (image thumb or file link + size
 * badge). The remove control arms on first click (kit armConfirm) and calls
 * `onRemove(attachment_id)`; when that resolves to an executed outcome the
 * tile drops immediately. Pass `onRemove: null` for a read-only strip (no
 * remove control at all). `onZoom(attachment)`, when given, makes image
 * thumbs zoomable.
 */
export function renderAttachments(
  stripEl: HTMLElement,
  list: Attachment[] | null | undefined,
  onRemove:
    | ((attachmentId: string) => Promise<VaultOutcome | undefined>)
    | null,
  { onZoom }: { onZoom?: (attachment: Attachment) => void } = {}
): void {
  // An imperative rebuild (any refresh — e.g. the window-focus one) would
  // otherwise wipe an armed remove button mid-confirm: the owner's second
  // click lands on a fresh, disarmed button and merely re-arms it. Carry
  // the armed state across the rebuild (the old node's disarm timer fires
  // on the detached button — a no-op).
  const armed = new Set(
    [
      ...stripEl.querySelectorAll('.kit-attach-remove[data-kit-armed="true"]'),
    ].map((b) => b.dataset.kitAttachmentId)
  );
  stripEl.innerHTML = "";
  for (const a of list ?? []) {
    const tile = document.createElement("div");
    tile.className = "kit-attach-tile";
    if (String(a.media_type).startsWith("image/")) {
      const img = document.createElement("img");
      img.src = a.content_uri;
      img.alt = a.title ?? "attachment";
      if (onZoom) {
        img.className = "kit-attach-zoom";
        img.addEventListener("click", () => onZoom(a));
      }
      tile.appendChild(img);
    } else {
      const link = document.createElement("a");
      link.className = "kit-attach-file";
      link.href = a.content_uri;
      link.download = a.title ?? "file";
      link.textContent = (a.title ?? a.media_type ?? "file").slice(0, 24);
      tile.appendChild(link);
    }
    const meta = document.createElement("span");
    meta.className = "kit-attach-meta";
    meta.textContent = fmtBytes(a.byte_size);
    tile.appendChild(meta);
    if (onRemove) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "kit-attach-remove";
      rm.textContent = "×";
      rm.title = "Remove";
      rm.setAttribute("aria-label", "Remove attachment");
      rm.dataset.kitAttachmentId = String(a.attachment_id);
      rm.addEventListener("click", async () => {
        if (!armConfirm(rm, { armedLabel: "Sure?" })) return;
        const outcome = await onRemove(a.attachment_id);
        if (outcome?.status === "executed") tile.remove();
      });
      if (armed.has(String(a.attachment_id)))
        armConfirm(rm, { armedLabel: "Sure?" });
      tile.appendChild(rm);
    }
    stripEl.appendChild(tile);
  }
}

/**
 * Wire a hidden `<input type=file>` to the attach flow: stage-or-inline each
 * picked file, run the app's `attach` action, narrate each outcome. The app
 * supplies its own consent voice: `act(action, input) → outcome`,
 * `narrate(outcome) → bool` (false stops the batch), `notice(text)` for read
 * errors, `refresh()` after the batch.
 */
export function wireAttachInput(
  inputEl: HTMLInputElement,
  getSubjectId: () => string | null | undefined,
  {
    act,
    narrate,
    notice,
    refresh,
  }: {
    act: (
      action: string,
      input: Record<string, unknown>
    ) => Promise<VaultOutcome | undefined>;
    narrate: (outcome: VaultOutcome | undefined) => boolean;
    notice?: (text: string) => void;
    refresh?: () => void | Promise<void>;
  }
): void {
  inputEl.addEventListener("change", async () => {
    const subjectId = getSubjectId();
    if (!subjectId) return;
    let narrating = true;
    await applyInOrder([...inputEl.files], async (file) => {
      if (!narrating) return;
      let input;
      let custodyReceipt;
      try {
        if (file.size > INLINE_ATTACH_BYTES) {
          const staged = await stageFileBytes(file);
          custodyReceipt = staged;
          input = {
            subject_id: subjectId,
            staged_sha: staged.sha256,
            title: file.name,
          };
        } else {
          const dataUri = await fileToDataUri(file);
          input = {
            subject_id: subjectId,
            data_uri: dataUri,
            title: file.name,
          };
        }
      } catch {
        notice?.("Could not read that file.");
        return;
      }
      const outcome = await act("attach", input);
      if (outcome?.status === "executed" && isPendingOffsite(custodyReceipt)) {
        notice?.("Attached locally · waiting for offsite custody.");
      }
      narrating = narrate(outcome);
    });
    inputEl.value = "";
    await refresh?.();
  });
}

// ---------- Anchored popover menu (Docs' openPopover, shared) ----------

let popoverEl = null;
let popoverCleanup = null;

/** Whether a kit popover is open — layered Escape handlers ask before closing. */
export function isPopoverOpen(): boolean {
  return popoverEl != null;
}

/** Close the open kit popover (no-op when none is open). */
export function closePopover(): void {
  if (!popoverEl) return;
  popoverCleanup?.();
  popoverEl.remove();
  popoverEl = null;
  popoverCleanup = null;
}

/**
 * Open a popover anchored to `anchor`: right-aligned, flips above when the
 * viewport runs out, closes on outside click / scroll / resize / Escape.
 * `build` receives the popover box and appends its content (see `popItem`).
 * Options: `focus` moves focus to the first field/button inside (form
 * popovers); `className` adds an app class for width/spacing overrides;
 * `role` overrides the default `menu` (use `dialog` for form popovers);
 * `onClose` runs once when the popover closes by any path (Escape, outside
 * click, scroll, resize, programmatic) — the teardown point for popovers
 * that attach document-level helpers.
 */
export function openPopover(
  anchor: HTMLElement,
  build: (box: HTMLElement) => void,
  {
    focus = false,
    className,
    role = "menu",
    onClose,
  }: {
    focus?: boolean;
    className?: string;
    role?: string;
    onClose?: () => void;
  } = {}
): void {
  closePopover();
  const box = h("div", {
    class: className ? `kit-popover ${className}` : "kit-popover",
    role,
  });
  build(box);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePopover();
    }
  });
  document.body.appendChild(box);
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(
      rect.right - box.offsetWidth,
      window.innerWidth - box.offsetWidth - 8
    )
  );
  let top = rect.bottom + 4;
  if (top + box.offsetHeight > window.innerHeight - 8)
    top = Math.max(8, rect.top - box.offsetHeight - 4);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  const onDoc = (e) => {
    if (!box.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  const onScroll = (e) => {
    // Scrolling inside the popover — or inside the kit's own body-level
    // @-mention list — must not close the popover hosting it.
    if (box.contains(e.target)) return;
    if (e.target instanceof Element && e.target.closest?.(".kit-mention-pop"))
      return;
    closePopover();
  };
  const timer = setTimeout(() => document.addEventListener("click", onDoc), 0);
  window.addEventListener("resize", closePopover);
  window.addEventListener("scroll", onScroll, true);
  popoverEl = box;
  popoverCleanup = () => {
    clearTimeout(timer);
    document.removeEventListener("click", onDoc);
    window.removeEventListener("resize", closePopover);
    window.removeEventListener("scroll", onScroll, true);
    onClose?.();
  };
  if (focus) box.querySelector("input, select, textarea, button")?.focus();
}

/** One menu row for `openPopover`: label + optional icon, dot, danger tone. */
export function popItem(
  label: string,
  onClick: (event: MouseEvent) => void,
  {
    danger = false,
    disabled = false,
    iconHtml = null,
    dotColor = null,
  }: {
    danger?: boolean;
    disabled?: boolean;
    iconHtml?: string | null;
    dotColor?: string | null;
  } = {}
): HTMLButtonElement {
  const btn = h("button", {
    type: "button",
    class: `kit-popover-item${danger ? " danger" : ""}`,
    role: "menuitem",
    disabled: disabled || undefined,
    onclick: onClick,
  });
  if (iconHtml) btn.appendChild(el(iconHtml));
  if (dotColor)
    btn.appendChild(
      h("span", { class: "kit-dotmini", style: `background:${dotColor};` })
    );
  btn.appendChild(document.createTextNode(label));
  return btn;
}

// ---------- Empty state ----------

/**
 * Fill `container` with the canonical empty state (icon tile, title, sub,
 * optional action element) and unhide it.
 */
export function emptyState(
  container: HTMLElement,
  {
    icon,
    title,
    sub,
    action,
  }: { icon?: string | Node; title?: string; sub?: string; action?: Node } = {}
): void {
  const subEl = h("div", { class: "kit-empty-sub" }, sub ?? "");
  if (action) subEl.appendChild(action);
  const kids = [];
  if (icon) {
    kids.push(
      h(
        "div",
        { class: "kit-empty-icon" },
        typeof icon === "string" ? el(icon) : icon
      )
    );
  }
  kids.push(h("div", { class: "kit-empty-title" }, title ?? ""), subEl);
  container.replaceChildren(...kids);
  container.hidden = false;
}

// ---------- Search-hit snippets ----------

/** Render a `⟦hit⟧` search snippet into `target`, marking the hits. */
export function snippetInto(
  target: HTMLElement,
  snippet: string | null | undefined
): void {
  const parts = String(snippet ?? "").split(/[⟦⟧]/u);
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    if (i % 2 === 1) {
      const mark = document.createElement("mark");
      mark.textContent = parts[i];
      target.appendChild(mark);
    } else {
      target.appendChild(document.createTextNode(parts[i]));
    }
  }
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
  const failures = [];
  await applyInOrder(Array.from({ length: n }), async (_, i) => {
    notice(`${progress} ${i + 1} of ${n}…`);
    const outcome = await run(ids[i]);
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

// ---------- Theme toggle ----------

/**
 * Theme is a host-owned setting. Blueprint apps receive the resolved profile
 * through the served document and must not create a second per-app theme
 * preference. The v0 hook is intentionally inert; the host owns appearance
 * and any retired local control is marked with `data-kit-appearance-control`.
 */
export function wireThemeToggle(
  _btn: HTMLElement,
  _options: { onChange?: (dark: boolean) => void } = {}
): () => void {
  return () => {};
}

// ============================================================================
// Cross-referencing (issues #272 + #282) — owner link writes + the reference
// strip. Referencing is a SHELL capability, not an app capability: the sole
// creation gesture is the inline `@`-mention (attachMentionPopover, below),
// which browses/searches the vault at owner trust (via the gateway's
// /_vault/picker surface, every read receipted); the user picks ONE row and
// the app receives only that row's card. The link is asserted with the
// owner-device credential (POST /_vault/links → core.link_entities,
// asserted_by='owner') — the pick is the consent, scoped to one row, so the
// app never needs read scopes on the foreign domain. Rendering the linked
// entity later rides ctx.vault.resolve's resolvable-if-linked rule.
// ============================================================================

// `entityKindLabel` (and its `PICK_KIND_LABELS` table) moved to elements.js,
// where the mention-chip and reference-strip components need it; it is imported
// and re-exported at the top of this file.

/**
 * Assert a link as the owner (the pick already carried the intent):
 * `from`/`to` are `{type, id}`; relation defaults to `references`. An
 * optional `selector` ({exact, prefix, suffix, start}, issue #282) writes an
 * inline standoff anchor atomically with the link.
 * Returns the vault's InvokeOutcome — `{status: 'executed', …}` on success.
 */
export async function createReference(
  from: { type: string; id: string },
  to: { type: string; id: string },
  relation: string,
  selector?: unknown
): Promise<VaultOutcome> {
  const r = await fetch("/centraid/_vault/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from_type: from.type,
      from_id: from.id,
      to_type: to.type,
      to_id: to.id,
      relation: relation || "references",
      ...(selector ? { selector } : {}),
    }),
  });
  return r.json();
}

/** End a link (temporal — the row survives with valid_to set). */
export async function removeReference(linkId: string): Promise<VaultOutcome> {
  const r = await fetch(
    "/centraid/_vault/links/" + encodeURIComponent(linkId),
    {
      method: "DELETE",
    }
  );
  return r.json();
}

/**
 * Render the reference strip — the durable home of a note/doc's cross-refs
 * and the landing zone an inline anchor degrades to (issues #272 + #282).
 * This is the ONE canonical strip renderer: every consumer of references
 * (Notes now, Docs when it adopts) calls it so the strip, its card states,
 * and the anchored/orphaned distinction render identically everywhere.
 *
 * Presentation-only — it never writes. The app owns persistence: pass
 * `onRemove(ref)` to show a remove control (the app runs removeReference +
 * whatever refresh it needs); omit it for a read-only strip.
 *
 * Each `ref` is `{link_id, card, selector?}` where `card` is a resolver card
 * ({type, title, subtitle, status: live|trashed|missing|denied}). `selector`
 * present ⇒ the reference is anchored; pass `inlineIds` (a Set of link_ids
 * currently resolved inline in the body) and the tile flags itself "in text"
 * vs "in strip". Plain picker links (no selector) wear no flag.
 *
 * Options: {inlineIds?: Set<string>, onRemove?: (ref) => void, emptyText?: string}.
 *
 * The tile rendering lives in the `<kit-reference-strip>` custom element
 * (elements.js); this adapter mounts a single instance inside `stripEl` and
 * feeds it the props, so existing callers that pass their own container keep
 * working while the DOM/behaviour is owned by one component.
 */
export function renderReferenceStrip(
  stripEl: HTMLElement,
  refs: Reference[] | null | undefined,
  options: Record<string, unknown> = {}
): void {
  const { inlineIds, onRemove, emptyText } = options;
  let strip = stripEl.firstElementChild;
  if (!strip || strip.tagName !== "KIT-REFERENCE-STRIP") {
    stripEl.innerHTML = "";
    strip = document.createElement("kit-reference-strip");
    stripEl.appendChild(strip);
  }
  strip.refs = refs ?? [];
  strip.inlineIds = inlineIds ?? null;
  strip.onRemove = onRemove ?? null;
  strip.emptyText = emptyText ?? "";
}

/**
 * Move (selector object) or clear (selector null) the standoff anchor of a
 * live link — the re-anchor / re-baseline half of inline references (issue
 * #282). A locator write: the link judgment itself is untouched, so clearing
 * demotes the reference to strip-only.
 */
export async function reanchorReference(
  linkId: string,
  selector: unknown
): Promise<VaultOutcome> {
  const r = await fetch(
    "/centraid/_vault/links/" + encodeURIComponent(linkId),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selector: selector ?? null }),
    }
  );
  return r.json();
}

// ============================================================================
// Inline anchored references (issue #282) — the standoff-anchor half of
// cross-referencing. A reference stays a core.link edge; these helpers give
// it an inline presentation over a PLAIN text body: a W3C-style selector
// points into the words from outside, the read view resolves selectors to
// spans, and a broken selector degrades to the strip — never a wrong chip.
// Anchor resolution runs here in the kit (one implementation for every
// consumer) and is presentation-only: it never writes.
// ============================================================================

/** Context window captured either side of a mention (chars). */
const MENTION_CONTEXT = 24;

/**
 * Build the standoff selector for the words at [start, end) of `text`:
 * TextQuoteSelector (exact + surrounding context) belt, TextPositionSelector
 * (start, in UTF-16 code units) suspenders.
 */
export function computeMentionSelector(
  text: string,
  start: number,
  end: number
): unknown {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - MENTION_CONTEXT), start),
    suffix: text.slice(end, end + MENTION_CONTEXT),
    start,
  };
}

// Deterministic normalization for the last resolution rung: collapse
// whitespace runs, fold smart quotes. Zero fuzzy risk — every normalized hit
// is still an exact hit modulo these two classes. The map carries normalized
// indices back to raw ones.
function normalizeWithMap(text) {
  let out = "";
  const map = [];
  let lastWasSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    let ch = text[i];
    if (/\s/u.test(ch)) {
      if (lastWasSpace) continue;
      out += " ";
      map.push(i);
      lastWasSpace = true;
      continue;
    }
    lastWasSpace = false;
    if (ch === "‘" || ch === "’") ch = "'";
    else if (ch === "“" || ch === "”") ch = '"';
    out += ch;
    map.push(i);
  }
  return { text: out, map };
}

// How much of the stored context survives around an occurrence — matching
// outward from the boundary, so nearby identical quotes separate cleanly.
function contextScore(body, occStart, occEnd, sel) {
  const prefix = sel.prefix ?? "";
  const suffix = sel.suffix ?? "";
  let score = 0;
  for (let k = 1; k <= prefix.length; k += 1) {
    if (body[occStart - k] === prefix[prefix.length - k]) score += 1;
    else break;
  }
  for (let k = 0; k < suffix.length; k += 1) {
    if (body[occEnd + k] === suffix[k]) score += 1;
    else break;
  }
  return score;
}

function occurrencesOf(haystack, needle) {
  const out = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    out.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return out;
}

/**
 * Resolve standoff anchors to text spans — the global one-span-per-anchor
 * assignment (issue #282, Q2's layered ladder). `anchors` is a list of
 * `{link_id, selector: {exact, prefix, suffix, start}}`; the result maps
 * link_id → {start, end} in raw body offsets. An anchor that wins no span is
 * simply absent — an ORPHAN, rendered in the strip only.
 *
 * Ladder per anchor: exact occurrences (context-scored, nearest-to-stored-
 * position tiebreak; a position-verified match is just the perfect score) →
 * whitespace/smart-quote-normalized occurrences → orphan. NO fuzzy matching:
 * a wrong chip is a lie, a strip chip is honest. Arbitration is global —
 * each occurrence goes to at most one anchor and spans never overlap, so an
 * irreducibly ambiguous pair (same quote, same context) yields one inline
 * chip and one strip entry instead of a double render.
 */
export function assignAnchors(body: string, anchors: unknown): unknown {
  const candidates = [];
  let norm = null;
  for (const anchor of anchors) {
    const sel = anchor.selector;
    if (!sel || typeof sel.exact !== "string" || sel.exact.length === 0)
      continue;
    let spans = occurrencesOf(body, sel.exact).map((at) => ({
      start: at,
      end: at + sel.exact.length,
      normalized: 0,
    }));
    if (spans.length === 0) {
      norm ??= normalizeWithMap(body);
      const needle = normalizeWithMap(sel.exact).text;
      if (needle.length > 0) {
        spans = occurrencesOf(norm.text, needle).map((at) => ({
          start: norm.map[at],
          end: norm.map[at + needle.length - 1] + 1,
          normalized: 1,
        }));
      }
    }
    for (const span of spans) {
      candidates.push({
        linkId: anchor.link_id,
        start: span.start,
        end: span.end,
        normalized: span.normalized,
        score: contextScore(body, span.start, span.end, sel),
        posDist: Math.abs(
          span.start - (Number.isFinite(sel.start) ? sel.start : 0)
        ),
      });
    }
  }
  // Best claims first: exact before normalized, most context, nearest to the
  // stored position, then document order for full determinism.
  candidates.sort(
    (a, b) =>
      a.normalized - b.normalized ||
      b.score - a.score ||
      a.posDist - b.posDist ||
      a.start - b.start
  );
  const assigned = new Map();
  const claimed = [];
  for (const c of candidates) {
    if (assigned.has(c.linkId)) continue;
    if (claimed.some(([s, e]) => c.start < e && s < c.end)) continue;
    assigned.set(c.linkId, { start: c.start, end: c.end });
    claimed.push([c.start, c.end]);
  }
  return assigned;
}

// Caret pixel position inside a textarea, via the classic mirror-div
// technique: clone the metrics that shape line wrapping, lay out the text up
// to `index`, and read where a marker span lands.
const MIRROR_STYLES = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "textIndent",
];

function caretRect(textarea, index) {
  const mirror = document.createElement("div");
  const style = getComputedStyle(textarea);
  for (const prop of MIRROR_STYLES) mirror.style[prop] = style[prop];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = textarea.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  const left = marker.offsetLeft;
  const lineHeight = marker.offsetHeight || Number(style.lineHeight) || 20;
  mirror.remove();
  const box = textarea.getBoundingClientRect();
  return {
    top: box.top + top - textarea.scrollTop,
    left: box.left + left - textarea.scrollLeft,
    height: lineHeight,
  };
}

/**
 * The inline `@`-mention gesture over a plain textarea (issue #282). Typing
 * `@` at a word boundary opens a caret-anchored popover of pickable entity
 * cards; typing filters it CLIENT-SIDE over one batch fetched when the
 * popover opened — one receipted owner read per gesture, never per
 * keystroke (the receipt stays legible as "the owner opened the picker").
 *
 * The kit only runs the gesture: on pick it calls `onPick(card, range)` with
 * `range = {start, end}` covering `@token` in the textarea's value, and the
 * APP inserts the plain words and asserts the (anchored) link — text stays
 * plain, the reference stays structural.
 *
 * Options: {kinds?: string[], exclude?: {type, id}, onPick(card, range)}.
 * Returns a detach() that removes every listener.
 */
export function attachMentionPopover(
  textarea: HTMLTextAreaElement,
  options: Record<string, unknown> = {}
): () => void {
  let pop = null;
  let cards = null; // the one batch fetched for this popover
  let fetchSeq = 0;
  let atIndex = -1;
  let selected = 0;

  function close() {
    if (pop) pop.remove();
    pop = null;
    cards = null;
    atIndex = -1;
    selected = 0;
    fetchSeq += 1; // orphan any in-flight fetch
  }

  function tokenAtCaret() {
    const caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd) return null;
    const upto = textarea.value.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at === -1) return null;
    const before = at === 0 ? "" : upto[at - 1];
    if (before && !/[\s(]/u.test(before)) return null;
    const token = upto.slice(at + 1);
    if (token.length > 40 || token.includes("\n")) return null;
    return { at, caret, token };
  }

  function filtered() {
    const gesture = tokenAtCaret();
    const term = (gesture?.token ?? "").trim().toLowerCase();
    const excluded = options.exclude
      ? (c) => c.type === options.exclude.type && c.id === options.exclude.id
      : () => false;
    return (cards ?? [])
      .filter((c) => !excluded(c))
      .filter((c) => {
        if (!term) return true;
        const hay =
          `${c.title ?? ""} ${c.subtitle ?? ""} ${entityKindLabel(c.type)}`.toLowerCase();
        return hay.includes(term);
      })
      .slice(0, 8);
  }

  function pick(card) {
    const gesture = tokenAtCaret();
    close();
    if (!gesture || !options.onPick) return;
    options.onPick(card, { start: gesture.at, end: gesture.caret });
  }

  function renderList() {
    if (!pop) return;
    const list = pop.firstChild;
    list.innerHTML = "";
    const visible = filtered();
    if (selected >= visible.length) selected = Math.max(0, visible.length - 1);
    if (cards && visible.length === 0) {
      const empty = document.createElement("p");
      empty.className = "kit-mention-empty";
      empty.textContent = "Nothing in your vault matches that.";
      list.appendChild(empty);
      return;
    }
    visible.forEach((card, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "kit-mention-row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", i === selected ? "true" : "false");
      const kind = document.createElement("span");
      kind.className = "kit-mention-kind";
      kind.textContent = entityKindLabel(card.type);
      const title = document.createElement("span");
      title.className = "kit-mention-title";
      title.textContent =
        card.title ?? `${entityKindLabel(card.type)} ${card.id.slice(-6)}`;
      row.append(kind, title);
      // pointerdown, not click: keep the textarea focused through the pick.
      row.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        pick(card);
      });
      list.appendChild(row);
    });
  }

  function place() {
    if (!pop || atIndex < 0) return;
    const rect = caretRect(textarea, atIndex);
    const width = Math.min(320, window.innerWidth - 16);
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    pop.style.top = `${Math.min(rect.top + rect.height + 4, window.innerHeight - 60)}px`;
    pop.style.width = `${width}px`;
  }

  async function open(gesture) {
    atIndex = gesture.at;
    selected = 0;
    if (!pop) {
      pop = document.createElement("div");
      pop.className = "kit-mention-pop";
      pop.setAttribute("role", "listbox");
      pop.setAttribute("aria-label", "Mention an entity from your vault");
      const list = document.createElement("div");
      list.className = "kit-mention-list";
      list.dataset.state = "loading";
      pop.appendChild(list);
      const note = document.createElement("p");
      note.className = "kit-mention-note";
      note.textContent = "Picking links only the picked item — receipted.";
      pop.appendChild(note);
      document.body.appendChild(pop);
    }
    place();
    if (cards === null) {
      const mine = ++fetchSeq;
      const params = new URLSearchParams();
      params.set("limit", "25");
      if (options.kinds && options.kinds.length)
        params.set("kinds", options.kinds.join(","));
      let batch = [];
      try {
        const r = await fetch("/centraid/_vault/picker?" + params.toString());
        const body = r.ok ? await r.json() : null;
        batch = (body && body.cards) || [];
      } catch {
        batch = [];
      }
      if (mine !== fetchSeq || !pop) return; // closed while loading
      cards = batch;
      delete pop.firstChild.dataset.state;
    }
    renderList();
  }

  function onInput() {
    const gesture = tokenAtCaret();
    if (!gesture) {
      close();
      return;
    }
    if (pop && gesture.at === atIndex) renderList();
    else void open(gesture);
  }

  function onKeydown(e) {
    if (!pop) return;
    const visible = filtered();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      selected =
        (selected + delta + Math.max(1, visible.length)) %
        Math.max(1, visible.length);
      renderList();
    } else if ((e.key === "Enter" || e.key === "Tab") && visible.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      pick(visible[selected]);
    }
  }

  function onBlur() {
    // pointerdown picks already ran preventDefault, so a real blur means the
    // gesture is over — but a programmatic open (a button that inserts `@`
    // and re-focuses the textarea) blurs then immediately refocuses, so only
    // close if focus actually left the field.
    setTimeout(() => {
      if (document.activeElement !== textarea) close();
    }, 80);
  }

  textarea.addEventListener("input", onInput);
  // Capture phase: while the popover is open its Enter/Arrows must win over
  // the app's own editor keydown handlers (e.g. checklist continuation).
  textarea.addEventListener("keydown", onKeydown, true);
  textarea.addEventListener("blur", onBlur);
  textarea.addEventListener("click", onInput);
  return function detach() {
    close();
    textarea.removeEventListener("input", onInput);
    textarea.removeEventListener("keydown", onKeydown, true);
    textarea.removeEventListener("blur", onBlur);
    textarea.removeEventListener("click", onInput);
  };
}

// ---------- Inline-chip rendering (shared read-view helpers, issue #282) ----------
// A resolved standoff anchor renders the mentioned words as a chip showing the
// resolver's LIVE card title — rename the target and the chip follows, while
// the body bytes stay the plain words that were typed. These are the pieces a
// read view reuses; the app supplies its own block/markdown layout and calls
// appendWithChips for each rendered text chunk.

/** The live-card chip element for one resolved anchor span (see `<kit-mention-chip>`). */
export function mentionChip(ref: Reference): HTMLElement {
  const chip = document.createElement("kit-mention-chip");
  chip.card = ref.card ?? {};
  return chip;
}

/**
 * Resolve a body's anchored references to inline spans (issue #282). `refs` is
 * the app's live reference list (`{link_id, selector, card}`); returns
 * `[{start, end, link_id, card}]` for the anchors that currently resolve, via
 * the global one-span-per-anchor assignment. Pure presentation — no writes.
 */
export function resolveInlineSpans(body: string, refs: Reference[]): unknown {
  const anchored = (refs ?? []).filter((r) => r.selector);
  if (anchored.length === 0) return [];
  const assigned = assignAnchors(String(body ?? ""), anchored);
  return anchored
    .filter((r) => assigned.has(r.link_id))
    .map((r) => ({
      ...assigned.get(r.link_id),
      link_id: r.link_id,
      card: r.card,
    }));
}

/** The set of link_ids currently resolved inline in `body` (strip flagging). */
export function inlineLinkIds(body: string, refs: Reference[]): string[] {
  return new Set(resolveInlineSpans(body, refs).map((r) => r.link_id));
}

/**
 * Append one rendered chunk of body text to `el`, swapping any anchor span
 * that falls fully inside it for its chip. `absStart` is the chunk's offset
 * in the whole decoded body — the space assignAnchors speaks. `renderPlain(el,
 * seg)` renders the non-chip text (default: a text node; a markdown app passes
 * its inline renderer). A span straddling a chunk boundary renders as plain
 * text — the chip is presentation, degrading is free.
 */
export function appendWithChips(
  elLocal: HTMLElement,
  text: string,
  absStart: number,
  spans: unknown,
  renderPlain: unknown
): void {
  const plain =
    renderPlain ||
    ((node, seg) => node.appendChild(document.createTextNode(seg)));
  const absEnd = absStart + text.length;
  const inside = (spans ?? [])
    .filter((r) => r.start >= absStart && r.end <= absEnd)
    .toSorted((a, b) => a.start - b.start);
  const literal = (seg) => {
    if (seg) plain(elLocal, seg);
  };
  if (inside.length === 0) {
    literal(text);
    return;
  }
  let cursor = absStart;
  for (const r of inside) {
    literal(text.slice(cursor - absStart, r.start - absStart));
    elLocal.appendChild(mentionChip(r));
    cursor = r.end;
  }
  literal(text.slice(cursor - absStart));
}

// ---------- The @-mention field (turnkey cross-references, issues #272/#282) ----------
// Bundles the whole "@ works" behaviour so ANY app's <textarea> gains inline
// cross-references in a few lines: the caret popover, the pick→insert→assert
// (re-anchor-don't-duplicate), and the 4b reconcile-on-save (re-baseline live
// selectors, temporal-retract orphans, reversible Undo). Presentation +
// gesture only — the app still owns the body bytes, persistence, and the
// reference list (which it reads from its own core.link + core.link_anchor
// query). Everything below is a projection of that list.
//
// options:
//   from        () => {type,id} | {type,id} | null   — the entity mentions attach to
//   references  () => Array<{link_id, selector, card}> (live, mutated in place)
//   onChange    () => void                            — re-render strip/read-view after a mutation
//   relation    string = 'references'
//   kinds       string[]?                             — restrict the picker
//   onError     (outcome) => void?                    — vault refusal (default: the status line)
// returns { detach(), reconcile(body): Promise, startMention() }.
export function attachMentionField(
  textarea: HTMLTextAreaElement,
  options: Record<string, unknown> = {}
): () => void {
  const relation = options.relation || "references";
  const getFrom = () =>
    (typeof options.from === "function" ? options.from() : options.from) ||
    null;
  const getRefs = () => {
    const r =
      typeof options.references === "function"
        ? options.references()
        : options.references;
    return r || [];
  };
  const changed = () => options.onChange && options.onChange();
  const fail = (outcome, label) => {
    if (options.onError) options.onError(outcome);
    else statusLine(`Couldn’t link ${label}.`);
  };

  async function onPick(card, range) {
    const from = getFrom();
    if (!from) return;
    if (card.type === from.type && card.id === from.id) {
      statusLine("You can’t reference this record from itself.");
      return;
    }
    const refs = getRefs();
    const anchored = refs.filter((r) => r.selector);
    // Re-anchor, don't duplicate: an edge to this entity whose words were
    // edited away (orphaned BEFORE this insertion) takes the new selector
    // instead of minting a second judgment.
    const preAssigned = assignAnchors(textarea.value, anchored);
    const orphan = refs.find(
      (r) =>
        r.selector &&
        !preAssigned.has(r.link_id) &&
        r.card?.type === card.type &&
        r.card?.id === card.id
    );
    const label = card.title ?? entityKindLabel(card.type);
    textarea.setRangeText(label, range.start, range.end, "end");
    textarea.focus();
    // One synthetic input event lets the app's own handler sync its draft and
    // schedule its save — no duplicated bookkeeping here.
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const selector = computeMentionSelector(
      textarea.value,
      range.start,
      range.start + label.length
    );
    const outcome = orphan
      ? await reanchorReference(orphan.link_id, selector)
      : await createReference(from, card, relation, selector);
    if (outcome?.status !== "executed") {
      fail(outcome, label);
      return;
    }
    if (orphan) orphan.selector = selector;
    else refs.push({ link_id: outcome.output?.link_id, selector, card });
    statusLine(`${orphan ? "Re-linked" : "Linked"} ${label}.`);
    changed();
  }

  const detachPopover = attachMentionPopover(textarea, {
    ...(options.kinds ? { kinds: options.kinds } : {}),
    onPick,
  });

  // Reconcile runs when a save lands (the app's debounce is the "settled"
  // signal). Serialized so two quick saves can't race the same edge. The
  // subject is captured at call time (opts.from / opts.references) so a
  // navigation during the async window can't retarget it at the wrong record.
  let chain = Promise.resolve();
  function reconcile(body, opts = {}) {
    const from = opts.from ?? getFrom();
    const refs = opts.references ?? getRefs();
    chain = chain.then(() => doReconcile(body, from, refs)).catch(() => {});
    return chain;
  }
  async function doReconcile(body, from, refs) {
    const anchored = refs.filter((r) => r.selector);
    if (anchored.length === 0) return;
    const assigned = assignAnchors(body, anchored);
    const orphans = [];
    await applyInOrder(anchored, async (ref) => {
      const span = assigned.get(ref.link_id);
      if (!span) {
        orphans.push(ref);
        return;
      }
      // Re-baseline: keep the stored selector current with the saved body so
      // drift never accumulates and resolution needs no fuzzy rung.
      const fresh = computeMentionSelector(body, span.start, span.end);
      const cur = ref.selector;
      if (
        cur.exact !== fresh.exact ||
        cur.prefix !== fresh.prefix ||
        cur.suffix !== fresh.suffix ||
        cur.start !== fresh.start
      ) {
        const outcome = await reanchorReference(ref.link_id, fresh);
        if (outcome?.status === "executed") ref.selector = fresh;
      }
    });
    if (orphans.length === 0) return;
    const retracted = [];
    await applyInOrder(orphans, async (ref) => {
      const outcome = await removeReference(ref.link_id);
      if (outcome?.status === "executed") retracted.push(ref);
    });
    if (retracted.length === 0) return;
    for (const ref of retracted) {
      const i = refs.indexOf(ref);
      if (i >= 0) refs.splice(i, 1);
    }
    changed();
    const names = retracted
      .map((r) => r.card?.title ?? entityKindLabel(r.card?.type))
      .join(", ");
    statusLine(
      retracted.length === 1
        ? `Unlinked ${names} — its mention left the text.`
        : `Unlinked ${retracted.length} references whose mentions left the text.`,
      {
        undoLabel: "Undo",
        // Undo re-asserts a FRESH, anchorless edge (history is never rewritten;
        // an anchorless link lives in the strip, exempt from re-retraction —
        // so it can't oscillate against the still-missing words).
        onUndo: async () => {
          if (!from) return;
          await applyInOrder(retracted, async (ref) => {
            const outcome = await createReference(from, ref.card, relation);
            if (outcome?.status === "executed") {
              refs.push({
                link_id: outcome.output?.link_id,
                selector: null,
                card: ref.card,
              });
            }
          });
          changed();
        },
      }
    );
  }

  // Drop an `@` at the caret and open the popover (a discoverability shim for
  // a button). The app makes the textarea visible/editable first.
  function startMention() {
    textarea.focus();
    const pos = textarea.selectionStart ?? textarea.value.length;
    const prev = pos > 0 ? textarea.value[pos - 1] : "";
    textarea.setRangeText(
      prev && !/[\s(]/u.test(prev) ? " @" : "@",
      pos,
      pos,
      "end"
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  return { detach: detachPopover, reconcile, startMention };
}
