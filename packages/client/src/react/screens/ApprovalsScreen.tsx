// governance: allow-repo-hygiene file-size-limit (#765) single cohesive screen component (one consent surface: staged write, waiting queue, standing grants, store ledger, history); splitting would fragment one block list
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import {
  APPROVALS_ALWAYS_TITLE,
  APPROVALS_CANNOT_EDIT_KEY,
  APPROVALS_CANNOT_EDIT_VALUE,
  APPROVALS_DENY_SUB,
  APPROVALS_DENY_TITLE,
  APPROVALS_EDIT_SUB,
  APPROVALS_EDIT_TITLE,
  APPROVALS_EMPTY_ACTION,
  APPROVALS_EMPTY_BODY,
  APPROVALS_EMPTY_TITLE,
  APPROVALS_GRANTS_NOTE,
  APPROVALS_NO_GRANTS_NOTE,
  APPROVALS_SENDING_FACT_KEY,
  APPROVALS_SENDING_FACT_VALUE,
} from "../../approvals-copy.js";
import Button from "../ui/Button.js";
import ChipsBlock from "../ui/ChipsBlock.js";
import EmptyBlock from "../ui/EmptyBlock.js";
import NoteBlock from "../ui/NoteBlock.js";
import PanelBlock from "../ui/PanelBlock.js";
import type { PanelFact } from "../ui/PanelBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import { NETWORK_CALLS } from "./networkCalls.js";
import type { StoreGroup, StoreHolderDTO } from "./privacyStores.js";

import styles from "./ApprovalsScreen.module.css";

// The Notifications screen (issues #306/#308/#552/#647/#708, revamped for the
// v9 binding layer in #765) — the desktop UI for the vault's consent surface.
// Agents stage external writes (outbox), connections lapse, Tier 3/4 acts park,
// republished manifests ask for wider scopes, and automations file notices.
// This screen is the one place an owner sees all of it and decides.
//
// The v9 shape is a single BLOCK LIST, not a set of chip-gated tabs: one staged
// write is promoted to a panel (the words are somebody else's, so they are
// quoted, and every fact about where they are going is stated before the
// commit), everything else that is waiting is a row, and the reference material
// underneath it — standing grants, the store ledger, the history — is sections
// of rows in the same list rather than views hidden behind a filter.
//
// Identity (title, count line, the two app-bar verbs) is the FRAME's, published
// by `ApprovalsRoute` through `routeVitals.ts`; this screen draws no header.
//
// Purely presentational: ApprovalsRoute fetches, maps the wire shapes to the
// DTOs below, and wires the callbacks to `gateway-client-outbox.ts` (confirm /
// prompt overlays live at the route, not here).

export interface ApprovalsOutboxRowDTO {
  itemId: string;
  connectionLabel: string;
  connectionKind: string;
  verb: string;
  target: string;
  /** Joined recipient string — `artifact.to` may be a string or a list. */
  recipient: string;
  subject: string | null;
  bodyPreview: string | null;
  /** Every artifact key/value, readably stringified, for the panel's facts. */
  fields: readonly { key: string; label: string; value: string }[];
  stagedAgo: string;
  note: string | null;
  /**
   * WHO staged this write — the sibling of the parked-row requester identity.
   * Never null: falls back to the raw kind string when no display name is
   * known. The gateway refines the stored `ai_agent` into `'agent' |
   * 'assistant'` on the wire (VaultPlane.refineActorKind), so the eyebrow can
   * name an app, an automation and the assistant apart.
   */
  caller: string;
  callerKind: string;
  /**
   * Whether the gateway has a request rebuilder for this item's verb (issue
   * #308 A5) — gates the "Edit and approve" verb. `false` keeps the honest
   * "cannot be edited" fact instead.
   */
  canEdit: boolean;
  /** Raw artifact, keyed exactly as staged — seeds the edit form and lets
   *  non-editable fields ride through unchanged. */
  artifact: Record<string, unknown>;
}

export interface ApprovalsNeedsAuthRowDTO {
  connectionId: string;
  label: string;
  kind: string;
  note: string | null;
}

export interface ApprovalsParkedRowDTO {
  invocationId: string;
  command: string;
  caller: string;
  /** Refines a raw 'agent' credential into 'assistant' when it is the vault
   *  assistant's own identity, not an automation's. */
  callerKind: "app" | "agent" | "assistant" | "owner-device";
  parkedAgo: string;
  inputPreview: string;
}

export interface ApprovalsScopeRequestRowDTO {
  requestId: string;
  appId: string;
  purpose: string;
  scopeSummary: string;
  requestedAgo: string;
}

export interface ApprovalsGrantRowDTO {
  grantId: string;
  actorLabel: string;
  verb: string;
  target: string;
  createdAgo: string;
}

/**
 * One Recent activity row (issue #552). Pure display DTO — mapping and
 * adjacent-duplicate collapse live in `approvalsData.ts`.
 */
export interface ApprovalsActivityRowDTO {
  receiptId: string;
  /** Human-readable verb (Locker specials preserved; else sentence-case). */
  label: string;
  /** Compact detail line — objectType · truncated objectId, or fill origin. */
  detail: string;
  /** Full object id for the expanded panel (null when absent). */
  objectId: string | null;
  objectType: string;
  occurredAgo: string;
  /** Absolute ISO timestamp for the expanded detail. */
  occurredAt: string;
  /** Wire decision: `allow` | `deny` (schema); rendered as Allowed / Denied. */
  decision: string;
  /** Salience marker; null on pre-#306 receipts — no placeholder. */
  risk: string | null;
  /** Acting identity display name; falls back to kind when null. */
  actor: string | null;
  /** Refined kind (`app` / `agent` / `assistant` / `owner`). */
  actorKind: string | null;
  /** Standing outbox grant when this receipt was auto-allowed. */
  grantId: string | null;
  /** How the allow decision was made — grant auto-allow vs owner approval.
   *  Null on denies and rows with no attribution signal. */
  attribution: "grant" | "owner" | null;
  /** Adjacent-collapse multiplicity (1 when not collapsed). */
  count: number;
  /** Raw action string for collapse keys / expanded detail. */
  action: string;
}

export interface NoticeRowDTO {
  noticeId: string;
  kind: string;
  sourceRef: string;
  headline: string;
  detail: Record<string, unknown>;
  detailText: string | null;
  sourceLabel: string | null;
  severity: "info" | "warning" | "high";
  sourceType: "automation" | "agent" | "app";
  count: number;
  firstAt: string;
  lastAt: string;
  readAt: string | null;
  archivedAt: string | null;
}

export interface ApprovalsScreenProps {
  outbox: readonly ApprovalsOutboxRowDTO[];
  needsAuth: readonly ApprovalsNeedsAuthRowDTO[];
  parked: readonly ApprovalsParkedRowDTO[];
  scopeRequests: readonly ApprovalsScopeRequestRowDTO[];
  grants: readonly ApprovalsGrantRowDTO[];
  /**
   * The store-centric ledger (issue #708 A2) — "who can see my photos?" rather
   * than "what does this app do?". Every declared store is present, even with
   * zero holders (rendered as "reachable by nothing").
   */
  storeGrants: readonly StoreGroup[];
  activity: readonly ApprovalsActivityRowDTO[];
  notices?: readonly NoticeRowDTO[];
  /** Whether the review feed was truncated at the current limit — drives the
   *  in-place "See all" affordance (issue #552). */
  activityTruncated?: boolean;
  /** The itemId/invocationId/requestId/grantId currently mid-flight. */
  busyId: string | null;
  /** `artifact` is present only for an edit-then-approve (issue #308 A5) — the
   *  gateway rebuilds the wire request server-side from it. */
  onApproveOutbox: (
    itemId: string,
    alwaysAllow: boolean,
    artifact?: Record<string, unknown>
  ) => void;
  onDenyOutbox: (itemId: string) => void;
  onOpenSettings: () => void;
  onConfirmParked: (invocationId: string, approve: boolean) => void;
  onDecideScopeRequest: (requestId: string, approve: boolean) => void;
  onRevokeGrant: (grantId: string) => void;
  /** Revoke one store-ledger holder's grant — the row stays, switched off,
   *  rather than vanishing (issue #708 A2). */
  onRevokeStoreGrant: (holder: StoreHolderDTO) => void;
  onReadNotice?: (noticeId: string) => void;
  onArchiveNotice?: (noticeId: string) => void;
  onOpenNotice?: (notice: NoticeRowDTO) => void;
  /** Raise the review-feed limit in place when the list is truncated. */
  onSeeAllActivity?: () => void;
  /**
   * A request to bring one staged write into view — what tapping an `outbox`
   * notice means (#647 D10). `nonce` makes a repeat tap on the SAME item a new
   * request; the screen promotes that item into the panel and scrolls to it. A
   * null itemId — or one that is no longer open — clears any filter and leaves
   * the queue as it is, rather than pointing at a row that isn't there.
   */
  focusOutbox?: { itemId: string | null; nonce: number } | null;
  /**
   * The app bar's "Review all" verb (#765). It is not a navigation: it drops
   * whatever filter is in force and puts the first staged write back in the
   * panel, which is what "review all of it" means on a page whose content is
   * already all here.
   */
  reviewAll?: { nonce: number } | null;
}

// ── Copy that states a rule ────────────────────────────────────────────────
// Verbatim from the v9 brief. These sentences are the product's promises about
// what a decision does, so they are constants rather than inline strings: a
// promise that drifts between two call sites is a promise broken in one of
// them.

// Every sentence above that mobile also renders now lives in
// `../../approvals-copy.js` (issue #805) — see its header for why the two
// surfaces stopped keeping separate copies. Only the store-ledger note below
// is desktop's alone.
const LEDGER_NOTE =
  "Everything an app can reach — revoking takes effect at once.";

/** The waiting-queue filter, shown only when the queue is full enough to need
 *  one. Ids are the v9 chip set; the labels are its copy. */
const WAITING_CHIPS = [
  { id: "all", label: "Everything" },
  { id: "risk", label: "High risk" },
  { id: "auth", label: "Authorization" },
  { id: "staged", label: "Staged writes" },
] as const;

type WaitingFilter = (typeof WAITING_CHIPS)[number]["id"];

/** Which chip a waiting item answers to. One kind, one chip — an item that
 *  matched two would make "showing 3 of 12" a lie in one of them. */
type WaitingKind = "staged" | "auth" | "risk";

function matchesFilter(filter: WaitingFilter, kind: WaitingKind): boolean {
  return filter === "all" || filter === kind;
}

// ── Small honest phrasings ────────────────────────────────────────────────

/** `artifact[key]` is editable (string or a list of strings) — the shape the
 *  gateway's shape-drift guard accepts. */
function isEditableKey(
  artifact: Record<string, unknown>,
  key: string
): boolean {
  const v = artifact[key];
  return (
    typeof v === "string" ||
    (Array.isArray(v) && v.every((x) => typeof x === "string"))
  );
}

/** A textarea reads better than a single-line input for body-like or already
 *  multi-line text. */
function wantsTextarea(key: string, value: string): boolean {
  return (
    key.toLowerCase().includes("body") ||
    value.includes("\n") ||
    value.length > 120
  );
}

/**
 * WHO staged or asked, as words rather than a coloured chip. The kind badge
 * was a classifier pill in a system whose one chromatic ink means "this leaves
 * the device"; the same fact reads better as English in the line that already
 * names the actor.
 */
export function callerPhrase(kind: string, caller: string): string {
  switch (kind) {
    case "app":
      return `the app ${caller}`;
    case "agent":
      return `the automation ${caller}`;
    case "assistant":
      return "the assistant";
    default:
      return caller;
  }
}

/**
 * What KIND of outbound write this is, from the connection and verb the
 * gateway staged it under. Never guesses beyond what those two say: an
 * unrecognised verb is "Outbound write", which is true of every item here.
 */
export function outboundLabel(row: {
  verb: string;
  connectionKind: string;
}): string {
  const signal = `${row.verb} ${row.connectionKind}`.toLowerCase();
  if (signal.includes("mail") || signal.includes("smtp")) {
    return "Outbound email";
  }
  if (
    signal.includes("message") ||
    signal.includes("chat") ||
    signal.includes("slack") ||
    signal.includes("sms")
  ) {
    return "Outbound message";
  }
  return "Outbound write";
}

/**
 * Severity as a WORD, not a coloured rail. `info` gets nothing: a quiet update
 * needs no label.
 */
export function noticeSeverityLabel(
  kind: string,
  severity: NoticeRowDTO["severity"]
): string | null {
  if (severity === "info") return null;
  if (kind === "gateway-health")
    return severity === "high" ? "Down" : "Degraded";
  return severity === "high" ? "Failed" : "Warning";
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function spanWords(ms: number): string {
  if (ms >= DAY_MS) {
    const d = Math.round(ms / DAY_MS);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (ms >= HOUR_MS) {
    const h = Math.round(ms / HOUR_MS);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const m = Math.max(1, Math.round(ms / MINUTE_MS));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/**
 * Collapsed-notice duration phrase (#647). A day-plus run of failures reads as
 * "failing for 6 days" — the thing the owner actually needs to know; anything
 * shorter, or merely informational, keeps the neutral "×6 over 3 hours".
 * Returns null for an uncollapsed notice (count 1), which has no span to tell.
 */
export function noticeSpanPhrase(
  row: Pick<NoticeRowDTO, "count" | "firstAt" | "lastAt" | "severity">
): string | null {
  if (row.count <= 1) return null;
  const first = Date.parse(row.firstAt);
  const last = Date.parse(row.lastAt);
  // Unparseable or non-advancing timestamps: state the multiplicity only,
  // never invent a duration.
  if (Number.isNaN(first) || Number.isNaN(last) || last <= first) {
    return `×${row.count}`;
  }
  const span = last - first;
  if (row.severity !== "info" && span >= DAY_MS) {
    return `failing for ${spanWords(span)}`;
  }
  return `×${row.count} over ${spanWords(span)}`;
}

/** Absolute local timestamp for the expanded activity detail (issue #552). */
function formatAbsoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Decision → the row's one state word (issue #552). */
function decisionWord(decision: string): string {
  switch (decision) {
    case "allow":
      return "Allowed";
    case "deny":
      return "Denied";
    case "parked":
      return "Parked";
    default:
      return decision;
  }
}

/** Join the parts of a row's sub line, dropping the ones with nothing to say —
 *  a sub that renders " ·  · yesterday" is a bug that reads as a typo. */
function subLine(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(" · ");
}

/** `${storeId}:${grantId}` — a grant is only unique to a store when both are
 *  present, since the same underlying grant can span several stores' scopes
 *  and each store's row needs its own independent revoked state. */
export function revokedHolderKey(storeId: string, grantId: string): string {
  return `${storeId}:${grantId}`;
}

/**
 * Re-attach any revoked-this-session snapshot whose grant is no longer in the
 * live group (the revoke call deleted it server-side) — pure so it is
 * unit-testable independent of the screen's rendering.
 */
export function mergeRevokedHolders(
  group: StoreGroup,
  revoked: ReadonlyMap<string, StoreHolderDTO>
): StoreGroup {
  const liveIds = new Set(group.holders.map((h) => h.grantId));
  const reattached: StoreHolderDTO[] = [];
  for (const [key, holder] of revoked) {
    if (key !== revokedHolderKey(group.storeId, holder.grantId)) continue;
    if (liveIds.has(holder.grantId)) continue;
    reattached.push(holder);
  }
  return { ...group, holders: [...group.holders, ...reattached] };
}

// ── The staged write's own controls ───────────────────────────────────────

/**
 * The edit form, rendered in a ROW's detail slot rather than as a peer block:
 * an edit of the quoted draft is that decision's own detail, and `RowsBlock`
 * carries one escape hatch for exactly this (plan-client §1b).
 */
function EditForm({
  row,
  busy,
  onCancel,
  onSubmit,
}: {
  row: ApprovalsOutboxRowDTO;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (artifact: Record<string, unknown>) => void;
}): JSX.Element {
  const editableKeys = useMemo(
    () =>
      row.fields
        .map((f) => f.key)
        .filter((key) => isEditableKey(row.artifact, key)),
    [row.artifact, row.fields]
  );
  const [text, setText] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const key of editableKeys) {
      const v = row.artifact[key];
      seed[key] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    return seed;
  });
  const isListKey = (key: string): boolean => Array.isArray(row.artifact[key]);
  const submit = (): void => {
    const artifact: Record<string, unknown> = { ...row.artifact };
    for (const key of editableKeys) {
      const raw = text[key] ?? "";
      artifact[key] = isListKey(key)
        ? raw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : raw;
    }
    onSubmit(artifact);
  };
  return (
    <div className={styles.editForm}>
      {row.fields
        .filter((field) => editableKeys.includes(field.key))
        .map((field) => {
          const value = text[field.key] ?? "";
          const multiline =
            !isListKey(field.key) && wantsTextarea(field.key, value);
          return (
            <div className={styles.editField} key={field.key}>
              <span className={styles.editLabel}>{field.label}</span>
              {multiline ? (
                <textarea
                  aria-label={field.label}
                  className={styles.editTextarea}
                  onChange={(e) =>
                    setText((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                  value={value}
                />
              ) : (
                <input
                  aria-label={field.label}
                  className={styles.editInput}
                  onChange={(e) =>
                    setText((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                  type="text"
                  value={value}
                />
              )}
            </div>
          );
        })}
      <div className={styles.detailActions}>
        <Button
          disabled={busy}
          label="Approve with edits"
          onClick={submit}
          size="sm"
          variant="primary"
        />
        <Button
          commit={false}
          disabled={busy}
          label="Cancel"
          onClick={onCancel}
          size="sm"
          variant="secondary"
        />
      </div>
    </div>
  );
}

/** The always-allow switch. It mints a standing grant, which is the one
 *  decision on this page that outlives the decision, so it says so. */
function AlwaysAllow({
  row,
  checked,
  disabled,
  onChange,
}: {
  row: ApprovalsOutboxRowDTO;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <label className={styles.alwaysAllow}>
      <input
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        type="checkbox"
      />
      <span>
        Mint a standing grant for {row.verb} → {row.target}
      </span>
    </label>
  );
}

// ── The screen ────────────────────────────────────────────────────────────

export default function ApprovalsScreen(
  props: ApprovalsScreenProps
): JSX.Element {
  const {
    outbox,
    needsAuth,
    parked,
    scopeRequests,
    grants,
    storeGrants,
    activity,
    notices = [],
    activityTruncated = false,
    busyId,
    onApproveOutbox,
    onDenyOutbox,
    onOpenSettings,
    onConfirmParked,
    onDecideScopeRequest,
    onRevokeGrant,
    onRevokeStoreGrant,
    onReadNotice = () => undefined,
    onArchiveNotice = () => undefined,
    onOpenNotice = () => undefined,
    onSeeAllActivity,
    focusOutbox = null,
    reviewAll = null,
  } = props;

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [expandedWaiting, setExpandedWaiting] = useState<string | null>(null);
  const [expandedActivity, setExpandedActivity] = useState<string | null>(null);
  const [waitingFilter, setWaitingFilter] = useState<WaitingFilter>("all");
  const [activityFilter, setActivityFilter] = useState<"all" | "denied">("all");
  const [seenFocusNonce, setSeenFocusNonce] = useState<number | null>(null);
  const [seenReviewNonce, setSeenReviewNonce] = useState<number | null>(null);
  // Snapshots of grants the owner has switched off THIS session. The revoke
  // call deletes the grant row outright, so the next fetch would simply drop it
  // from `storeGrants` — keeping a copy of the row as it looked at the moment
  // of revoke is what lets it stay visible, switched off, instead of vanishing
  // (issue #708 A2: "the history of the grant stays legible").
  const [revokedStoreHolders, setRevokedStoreHolders] = useState<
    ReadonlyMap<string, StoreHolderDTO>
  >(new Map());

  const stagedRef = useRef<HTMLDivElement | null>(null);
  const grantsRef = useRef<HTMLDivElement | null>(null);

  // Honor a deep link from an outbox notice (#647 D10) and the bar's "Review
  // all" verb (#765). Adjusting state while rendering (React's documented
  // "derived from props" escape) rather than in an effect: the move must be
  // part of the same paint as the tap, and a nonce-keyed effect would cascade
  // an extra render.
  if (focusOutbox && focusOutbox.nonce !== seenFocusNonce) {
    const { itemId } = focusOutbox;
    const stillOpen =
      itemId !== null && outbox.some((row) => row.itemId === itemId);
    setSeenFocusNonce(focusOutbox.nonce);
    setWaitingFilter("all");
    setEditing(false);
    if (stillOpen) setSelectedItemId(itemId);
  }
  if (reviewAll && reviewAll.nonce !== seenReviewNonce) {
    setSeenReviewNonce(reviewAll.nonce);
    setWaitingFilter("all");
    setSelectedItemId(null);
    setEditing(false);
  }

  // The panel shows the selected staged write, or the oldest one — a queue's
  // head is the honest default, and a selection that has since been decided
  // falls back to it rather than leaving the panel empty.
  const staged =
    outbox.find((row) => row.itemId === selectedItemId) ?? outbox[0] ?? null;
  const stagedBusy = staged !== null && busyId === staged.itemId;

  useEffect(() => {
    const el = stagedRef.current;
    // `scrollIntoView` is absent under jsdom — the promotion into the panel is
    // the assertable half of the behaviour, the scroll is the browser nicety.
    if (
      focusOutbox?.itemId &&
      focusOutbox.itemId === staged?.itemId &&
      el &&
      typeof el.scrollIntoView === "function"
    ) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [focusOutbox, staged]);

  const activeNotices = notices.filter((notice) => notice.archivedAt === null);
  const archivedNotices = notices.filter(
    (notice) => notice.archivedAt !== null
  );
  // "Waiting" means "requires a decision or an intervention": an info-severity
  // notice (a gateway recovering, an FYI) is news, not a demand, so it sits in
  // Updates rather than the queue (#665).
  const attentionNotices = activeNotices.filter(
    (notice) => notice.severity !== "info"
  );
  const infoNotices = activeNotices.filter(
    (notice) => notice.severity === "info"
  );

  const totalWaiting =
    outbox.length +
    needsAuth.length +
    parked.length +
    scopeRequests.length +
    attentionNotices.length;
  const isEmpty = totalWaiting === 0;

  const noticeSub = (notice: NoticeRowDTO): string =>
    subLine([
      notice.kind.replaceAll("-", " "),
      notice.sourceLabel,
      new Date(notice.lastAt).toLocaleString(),
      noticeSpanPhrase(notice),
      notice.detailText,
    ]);

  /** The two disposal verbs a notice keeps once it is a row: the row's own
   *  action opens it, and these are what is left to DO with it. */
  const noticeDetail = (notice: NoticeRowDTO): ReactNode => {
    const canRead = notice.readAt === null && notice.archivedAt === null;
    const canArchive = notice.archivedAt === null;
    if (!canRead && !canArchive) return undefined;
    return (
      <div className={styles.detailActions}>
        {canRead ? (
          <Button
            commit={false}
            disabled={busyId === notice.noticeId}
            label="Mark read"
            onClick={() => onReadNotice(notice.noticeId)}
            size="sm"
            variant="secondary"
          />
        ) : null}
        {canArchive ? (
          <Button
            commit={false}
            disabled={busyId === notice.noticeId}
            label="Archive"
            onClick={() => onArchiveNotice(notice.noticeId)}
            size="sm"
            variant="secondary"
          />
        ) : null}
      </div>
    );
  };

  const toggleWaiting = (id: string): void =>
    setExpandedWaiting((prev) => (prev === id ? null : id));

  // ── The waiting rows ────────────────────────────────────────────────────
  const waitingRows: RowDef[] = [];

  for (const row of outbox) {
    if (staged && row.itemId === staged.itemId) continue;
    if (!matchesFilter(waitingFilter, "staged")) continue;
    waitingRows.push({
      action: {
        label: "Review",
        onClick: () => {
          setSelectedItemId(row.itemId);
          setEditing(false);
        },
      },
      id: row.itemId,
      meta: "Staged",
      off: busyId === row.itemId,
      sub: subLine([
        row.recipient,
        row.connectionLabel,
        `staged by ${callerPhrase(row.callerKind, row.caller)}`,
        row.stagedAgo,
      ]),
      title: row.subject ?? row.target,
    });
  }

  for (const row of needsAuth) {
    if (!matchesFilter(waitingFilter, "auth")) continue;
    waitingRows.push({
      action: { label: "Reconnect", onClick: () => onOpenSettings() },
      id: row.connectionId,
      meta: "Lapsed",
      net: true,
      sub: row.note ?? `${row.kind} needs reconnecting`,
      title: row.label,
    });
  }

  for (const row of parked) {
    if (!matchesFilter(waitingFilter, "risk")) continue;
    const open = expandedWaiting === row.invocationId;
    const busy = busyId === row.invocationId;
    waitingRows.push({
      action: {
        label: open ? "Hide" : "Review",
        onClick: () => toggleWaiting(row.invocationId),
      },
      children: open ? (
        <div className={styles.detailBody}>
          <pre className={styles.inputPreview}>{row.inputPreview}</pre>
          <div className={styles.detailActions}>
            <Button
              disabled={busy}
              label="Approve"
              onClick={() => onConfirmParked(row.invocationId, true)}
              size="sm"
              variant="primary"
            />
            <Button
              commit={false}
              disabled={busy}
              label="Deny"
              onClick={() => onConfirmParked(row.invocationId, false)}
              size="sm"
              variant="destructive"
            />
          </div>
        </div>
      ) : undefined,
      id: row.invocationId,
      meta: "High risk",
      net: true,
      sub: subLine([
        `asked by ${callerPhrase(row.callerKind, row.caller)}`,
        `parked ${row.parkedAgo}`,
      ]),
      title: row.command,
    });
  }

  for (const row of scopeRequests) {
    if (!matchesFilter(waitingFilter, "auth")) continue;
    const open = expandedWaiting === row.requestId;
    const busy = busyId === row.requestId;
    waitingRows.push({
      action: {
        label: open ? "Hide" : "Review",
        onClick: () => toggleWaiting(row.requestId),
      },
      children: open ? (
        <div className={styles.detailBody}>
          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt className={styles.factKey}>purpose</dt>
              <dd className={styles.factValue}>{row.purpose}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factKey}>scopes</dt>
              <dd className={styles.factValue}>{row.scopeSummary}</dd>
            </div>
          </dl>
          <div className={styles.detailActions}>
            <Button
              disabled={busy}
              label="Approve"
              onClick={() => onDecideScopeRequest(row.requestId, true)}
              size="sm"
              variant="primary"
            />
            <Button
              commit={false}
              disabled={busy}
              label="Deny"
              onClick={() => onDecideScopeRequest(row.requestId, false)}
              size="sm"
              variant="destructive"
            />
          </div>
        </div>
      ) : undefined,
      id: row.requestId,
      meta: "New scope",
      sub: subLine([row.purpose, row.scopeSummary, row.requestedAgo]),
      title: `${row.appId} is asking for wider access`,
    });
  }

  for (const notice of attentionNotices) {
    if (!matchesFilter(waitingFilter, "risk")) continue;
    waitingRows.push({
      action: { label: "Open", onClick: () => onOpenNotice(notice) },
      children: noticeDetail(notice),
      id: notice.noticeId,
      meta: noticeSeverityLabel(notice.kind, notice.severity) ?? "",
      net: notice.severity === "high",
      sub: noticeSub(notice),
      title: notice.headline,
    });
  }

  const showStaged = staged !== null && matchesFilter(waitingFilter, "staged");
  const shownWaiting = waitingRows.length + (showStaged ? 1 : 0);
  const waitingMeta =
    shownWaiting < totalWaiting
      ? `showing ${shownWaiting} of ${totalWaiting}`
      : `${totalWaiting} waiting`;
  // The chip row earns its place only when the queue is long enough that the
  // owner would otherwise scroll to find the one they care about.
  const showChips = totalWaiting > WAITING_CHIPS.length;

  // ── Standing grants ─────────────────────────────────────────────────────
  const grantRows: RowDef[] = grants.map((row) => ({
    action: {
      label: "Revoke",
      onClick: () => onRevokeGrant(row.grantId),
    },
    id: row.grantId,
    meta: row.createdAgo,
    off: busyId === row.grantId,
    sub: `${row.verb} → ${row.target}`,
    title: `${row.actorLabel} may always ${row.verb}`,
  }));

  // ── Recent activity ─────────────────────────────────────────────────────
  const filteredActivity = useMemo(
    () =>
      activityFilter === "denied"
        ? activity.filter((r) => r.decision === "deny")
        : activity,
    [activity, activityFilter]
  );

  const activityRows: RowDef[] = filteredActivity.map((row) => {
    const open = expandedActivity === row.receiptId;
    const absolute = formatAbsoluteTime(row.occurredAt);
    return {
      action: {
        label: open ? "Hide" : "Details",
        onClick: () =>
          setExpandedActivity((prev) =>
            prev === row.receiptId ? null : row.receiptId
          ),
      },
      children: open ? (
        <div className={styles.detailBody} data-testid="activity-detail">
          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt className={styles.factKey}>decision</dt>
              <dd className={styles.factValue}>{decisionWord(row.decision)}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factKey}>when</dt>
              <dd className={styles.factValue}>{absolute}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factKey}>object</dt>
              <dd className={styles.factValue}>
                {row.objectType}
                {row.objectId ? ` · ${row.objectId}` : ""}
              </dd>
            </div>
            {row.risk ? (
              <div className={styles.fact}>
                <dt className={styles.factKey}>risk</dt>
                <dd className={styles.factValue}>{row.risk}</dd>
              </div>
            ) : null}
            {row.actor || row.actorKind ? (
              <div className={styles.fact}>
                <dt className={styles.factKey}>actor</dt>
                <dd className={styles.factValue}>
                  {callerPhrase(row.actorKind ?? "", row.actor ?? "")}
                </dd>
              </div>
            ) : null}
            <div className={styles.fact}>
              <dt className={styles.factKey}>receipt</dt>
              <dd className={styles.factValue} data-mono="true">
                {row.receiptId}
              </dd>
            </div>
          </dl>
          {row.grantId ? (
            <div className={styles.detailActions}>
              <Button
                commit={false}
                disabled={busyId === row.grantId}
                label="Revoke grant"
                onClick={() => onRevokeGrant(row.grantId ?? "")}
                size="sm"
                variant="destructive"
              />
            </div>
          ) : null}
        </div>
      ) : undefined,
      id: row.receiptId,
      meta: subLine([
        decisionWord(row.decision),
        row.risk ? `${row.risk} risk` : null,
      ]),
      net: row.decision === "deny",
      sub: subLine([
        row.detail,
        row.occurredAgo,
        row.actor || row.actorKind
          ? `by ${callerPhrase(row.actorKind ?? "", row.actor ?? "")}`
          : null,
        row.attribution === "grant"
          ? "auto-allowed by a standing grant"
          : row.attribution === "owner"
            ? "approved by the owner"
            : null,
      ]),
      title: row.count > 1 ? `${row.label} ×${row.count}` : row.label,
    };
  });

  // ── The staged write's facts ────────────────────────────────────────────
  const stagedFacts = (row: ApprovalsOutboxRowDTO): PanelFact[] => {
    const facts: PanelFact[] = [];
    // Address facts first, in the order an envelope is read; then anything
    // else the artifact carries, so nothing staged is hidden from the person
    // approving it. `body`/`subject` are already the panel's quote and title.
    const addressed = ["to", "cc", "bcc", "from"];
    for (const key of addressed) {
      const field = row.fields.find((f) => f.key === key);
      if (field) facts.push({ key, mono: true, value: field.value });
    }
    for (const field of row.fields) {
      if (addressed.includes(field.key)) continue;
      if (field.key === "body" || field.key === "subject") continue;
      facts.push({ key: field.key, mono: true, value: field.value });
    }
    facts.push({
      key: "connection",
      value: `${row.connectionLabel} · ${row.connectionKind}`,
    });
    if (row.note) facts.push({ key: "note", value: row.note });
    if (!row.canEdit) {
      facts.push({
        key: APPROVALS_CANNOT_EDIT_KEY,
        value: APPROVALS_CANNOT_EDIT_VALUE,
      });
    }
    facts.push({
      key: APPROVALS_SENDING_FACT_KEY,
      net: true,
      value: APPROVALS_SENDING_FACT_VALUE,
    });
    return facts;
  };

  const stagedBody = (row: ApprovalsOutboxRowDTO): string =>
    row.fields.find((f) => f.key === "body")?.value ??
    row.bodyPreview ??
    row.target;

  // The controls that belong to the staged write, each on its own row: a deny
  // is not a smaller approve, and the v9 brief keeps it out of the panel's
  // action row for exactly that reason.
  const stagedControlRows: RowDef[] = [];
  if (showStaged && staged) {
    if (editing) {
      stagedControlRows.push({
        children: (
          <EditForm
            busy={stagedBusy}
            onCancel={() => setEditing(false)}
            onSubmit={(artifact) => {
              setEditing(false);
              onApproveOutbox(staged.itemId, alwaysAllow, artifact);
            }}
            row={staged}
          />
        ),
        id: "staged-edit",
        sub: APPROVALS_EDIT_SUB,
        title: APPROVALS_EDIT_TITLE,
      });
    }
    stagedControlRows.push(
      {
        children: (
          <AlwaysAllow
            checked={alwaysAllow}
            disabled={stagedBusy}
            onChange={setAlwaysAllow}
            row={staged}
          />
        ),
        id: "staged-always",
        title: APPROVALS_ALWAYS_TITLE,
      },
      {
        action: stagedBusy
          ? undefined
          : { label: "Deny", onClick: () => onDenyOutbox(staged.itemId) },
        dangerous: true,
        id: "staged-deny",
        sub: APPROVALS_DENY_SUB,
        title: APPROVALS_DENY_TITLE,
      }
    );
  }

  // ── The reference tail ──────────────────────────────────────────────────
  // Standing grants, the store ledger, the network-call list and the history
  // are not a queue: they are the page's reference material, and they render
  // in every state, including empty. A consent surface that hides the record
  // of what it already consented to is not a record.
  const tail = (
    <>
      <div ref={grantsRef}>
        <SectionBlock label="Standing grants" meta={String(grants.length)} />
        {grantRows.length > 0 ? (
          <RowsBlock ariaLabel="Standing grants" rows={grantRows} />
        ) : (
          <NoteBlock>{APPROVALS_NO_GRANTS_NOTE}</NoteBlock>
        )}
        <NoteBlock>{APPROVALS_GRANTS_NOTE}</NoteBlock>
      </div>

      {infoNotices.length > 0 ? (
        <div>
          <SectionBlock label="Updates" meta={String(infoNotices.length)} />
          <RowsBlock
            ariaLabel="Updates"
            rows={infoNotices.map((notice) => ({
              action: { label: "Open", onClick: () => onOpenNotice(notice) },
              children: noticeDetail(notice),
              id: notice.noticeId,
              sub: noticeSub(notice),
              title: notice.headline,
            }))}
          />
        </div>
      ) : null}

      {archivedNotices.length > 0 ? (
        <div>
          <SectionBlock
            label="Archived"
            meta={String(archivedNotices.length)}
          />
          <RowsBlock
            ariaLabel="Archived notices"
            rows={archivedNotices.map((notice) => ({
              action: { label: "Open", onClick: () => onOpenNotice(notice) },
              id: notice.noticeId,
              sub: noticeSub(notice),
              title: notice.headline,
            }))}
          />
        </div>
      ) : null}

      {storeGrants.length > 0 ? (
        <div data-testid="privacy-ledger">
          <SectionBlock
            label="Who can reach your stores"
            meta={`${storeGrants.length} stores`}
          />
          <NoteBlock>{LEDGER_NOTE}</NoteBlock>
          {storeGrants.map((group) => {
            const merged = mergeRevokedHolders(group, revokedStoreHolders);
            const count = merged.holders.length;
            return (
              <div data-testid="privacy-store" key={group.storeId}>
                <SectionBlock
                  label={group.label}
                  meta={
                    count > 0
                      ? `${count} app${count === 1 ? "" : "s"}`
                      : "reachable by nothing"
                  }
                />
                {count > 0 ? (
                  <RowsBlock
                    ariaLabel={`${group.label} holders`}
                    rows={merged.holders.map((holder) => {
                      const revoked = revokedStoreHolders.has(
                        revokedHolderKey(group.storeId, holder.grantId)
                      );
                      return {
                        action: {
                          label: "Revoke",
                          onClick: () => {
                            setRevokedStoreHolders(
                              (previous) =>
                                new Map([
                                  ...previous,
                                  [
                                    revokedHolderKey(
                                      group.storeId,
                                      holder.grantId
                                    ),
                                    holder,
                                  ],
                                ])
                            );
                            onRevokeStoreGrant(holder);
                          },
                          title: `Revoke ${holder.mode} access to ${group.label} from ${holder.holderLabel}`,
                        },
                        dangerous: true,
                        id: `${holder.holderKind}-${holder.holderId}-${holder.grantId}`,
                        meta: revoked ? "revoked" : holder.mode,
                        off: revoked || busyId === holder.grantId,
                        sub: `${holder.holderKind === "agent" ? "automation" : "app"} · ${holder.mode} access`,
                        title: holder.holderLabel,
                      };
                    })}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <div>
        <SectionBlock label="Every network call this product makes" />
        <RowsBlock
          ariaLabel="Network calls"
          rows={NETWORK_CALLS.map((call) => ({
            id: call.label,
            sub: call.detail,
            title: call.label,
          }))}
        />
      </div>

      {activity.length > 0 ? (
        <div data-testid="recent-activity">
          <SectionBlock
            label="Recent activity"
            meta={
              filteredActivity.length === activity.length
                ? String(activity.length)
                : `showing ${filteredActivity.length} of ${activity.length}`
            }
          />
          <ChipsBlock
            ariaLabel="Activity filter"
            chips={[
              { id: "all", label: "All", on: activityFilter === "all" },
              {
                id: "denied",
                label: "Denied",
                on: activityFilter === "denied",
              },
            ]}
            onPick={(id) =>
              setActivityFilter(id === "denied" ? "denied" : "all")
            }
          />
          {activityRows.length > 0 ? (
            <RowsBlock ariaLabel="Recent activity" rows={activityRows} />
          ) : (
            <NoteBlock>No denied activity in this window.</NoteBlock>
          )}
          {activityTruncated && onSeeAllActivity ? (
            <div className={styles.seeAllRow} data-testid="activity-see-all">
              <Button
                commit={false}
                label="See all"
                onClick={() => onSeeAllActivity()}
                size="sm"
                variant="secondary"
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );

  if (isEmpty) {
    return (
      <div className={styles.page}>
        <EmptyBlock
          action={{
            label: APPROVALS_EMPTY_ACTION,
            onClick: () => {
              const el = grantsRef.current;
              if (el && typeof el.scrollIntoView === "function") {
                el.scrollIntoView({ block: "start" });
              }
            },
          }}
          body={APPROVALS_EMPTY_BODY}
          routine
          title={APPROVALS_EMPTY_TITLE}
        />
        {tail}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {showChips ? (
        <ChipsBlock
          ariaLabel="Waiting filter"
          chips={WAITING_CHIPS.map((chip) => ({
            id: chip.id,
            label: chip.label,
            on: waitingFilter === chip.id,
          }))}
          onPick={(id) => setWaitingFilter(id as WaitingFilter)}
        />
      ) : null}

      <SectionBlock label="Waiting on you" meta={waitingMeta} />

      {showStaged && staged ? (
        <div
          data-item-id={staged.itemId}
          data-testid="staged-write"
          ref={stagedRef}
        >
          <PanelBlock
            {...(stagedBusy
              ? {}
              : {
                  action: {
                    filled: true,
                    label: "Approve and send",
                    onClick: () => onApproveOutbox(staged.itemId, alwaysAllow),
                  },
                  ...(staged.canEdit
                    ? {
                        action2: {
                          label: "Edit and approve",
                          onClick: () => setEditing(true),
                        },
                      }
                    : {}),
                })}
            body={stagedBody(staged)}
            eyebrow={subLine([
              outboundLabel(staged),
              `staged by ${callerPhrase(staged.callerKind, staged.caller)}`,
              staged.stagedAgo,
            ])}
            facts={stagedFacts(staged)}
            quote
            title={staged.subject ?? staged.target}
            wide
          />
        </div>
      ) : null}

      {stagedControlRows.length > 0 ? (
        <RowsBlock ariaLabel="This staged write" rows={stagedControlRows} />
      ) : null}

      {waitingRows.length > 0 ? (
        <>
          {showStaged && staged ? (
            <SectionBlock
              label="Also waiting"
              meta={String(waitingRows.length)}
            />
          ) : null}
          <RowsBlock ariaLabel="Waiting on you" rows={waitingRows} />
        </>
      ) : null}

      {tail}
    </div>
  );
}
