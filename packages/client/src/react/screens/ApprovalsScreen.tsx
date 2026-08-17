// governance: allow-repo-hygiene file-size-limit (#765) single cohesive screen component (one consent surface: staged write, waiting queue, standing grants, store ledger, history); splitting would fragment one block list
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import {
  APPROVALS_ALWAYS_TITLE,
  APPROVALS_CANNOT_EDIT_KEY,
  APPROVALS_CANNOT_EDIT_VALUE,
  APPROVALS_DISCARD_CONSEQUENCE,
  APPROVALS_EDIT_SUB,
  APPROVALS_EMPTY_ACTION,
  APPROVALS_EMPTY_BODY,
  APPROVALS_EMPTY_TITLE,
  APPROVALS_GRANTS_NOTE,
  APPROVALS_HELD_BODY,
  APPROVALS_NO_GRANTS_NOTE,
  APPROVALS_OLD_GATEWAY_BODY,
  APPROVALS_OLD_GATEWAY_TITLE,
  APPROVALS_REFUSED_TITLE,
  APPROVALS_REVOKE_GRANT_CONSEQUENCE,
  APPROVALS_SENDING_FACT_KEY,
  APPROVALS_SENDING_FACT_VALUE,
} from "../../approvals-copy.js";
import {
  arrivalCount,
  callerPhrase,
  matchesFilter,
  pointerDefaultOpen,
  WAITING_CHIPS,
  decisionWord,
  formatAbsoluteTime,
  isAuthorableKey,
  noticeSeverityLabel,
  noticeSpanPhrase,
  outboundLabel,
  subLine,
  wantsTextarea,
} from "../shell/routes/approvalsPhrasing.js";
import type {
  Blocking,
  Confirming,
  RecordSection,
  WaitingFilter,
} from "../shell/routes/approvalsPhrasing.js";
import Button from "../ui/Button.js";
import ChipsBlock from "../ui/ChipsBlock.js";
import DecideBlock from "../ui/DecideBlock.js";
import type { DecideAction, DecideFact } from "../ui/DecideBlock.js";
import EmptyBlock from "../ui/EmptyBlock.js";
import NoteBlock from "../ui/NoteBlock.js";
import PanelBlock from "../ui/PanelBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import { NETWORK_CALLS } from "./networkCalls.js";
import { mergeRevokedHolders, revokedHolderKey } from "./privacyStores.js";
import type { StoreGroup, StoreHolderDTO } from "./privacyStores.js";

import styles from "./ApprovalsScreen.module.css";

// The Notifications screen (issues #306/#308/#552/#647/#708/#765, evolved to the
// v11 binding layer in #815) — the desktop UI for the vault's consent surface.
// Agents stage external writes (outbox), connections lapse, Tier 3/4 acts park,
// republished manifests ask for wider scopes, and automations file notices.
// This screen is the one place an owner sees all of it and decides.
//
// The v11 shape is TWO REGISTERS. Everything blocking is a decision CARD
// (`ui/DecideBlock`) — a row cannot hold an actor, an artifact, a
// standing-grant offer and an irreversible verb without lying about its
// geometry — and everything already decided is reference material in four
// collapsible sections underneath: standing grants, who holds which store,
// what may leave, recent activity.
//
// Two rules the shape exists to keep. An irreversible verb confirms IN PLACE,
// swapping the card's action row for the consequence plus [Do it] / [Keep it],
// so a member never leaves the sentence they are deciding about. And a
// background refresh never takes work out of a member's hands: while anything
// is expanded with an edit, ticked "always allow" or mid-confirm, arrivals wait
// in a held tray until they say [Add them].
//
// Identity (title, count line, the two app-bar verbs) is the FRAME's, published
// by `ApprovalsRoute` through `routeVitals.ts`; this screen draws no header.
//
// Purely presentational: ApprovalsRoute fetches, maps the wire shapes to the
// DTOs below, and wires the callbacks to `gateway-client-outbox.ts`.

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
  /** Every artifact key/value, readably stringified, for the card's facts. */
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
   * #308 A5) — gates the "Edit and approve" verb. `false` renders it disabled
   * with the honest fact instead.
   */
  canEdit: boolean;
  /** Raw artifact, keyed exactly as staged — seeds the edit draft and lets
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

/**
 * One row of the EGRESS-CONSENT ledger (issue #807, Wave 3) — an answer the
 * member gave once about how far work for one capability may travel. Display
 * only: this screen is where an answer is READ BACK, never re-given, so the
 * row carries no action. A declined answer renders exactly as legibly as a
 * granted one; the record of a refusal is the point.
 */
export interface ApprovalsEnrichConsentRowDTO {
  /** Stable row id — capability × egress × scope. */
  id: string;
  /** The capability the answer is about, as the member's words. */
  title: string;
  /** "Granted · on this device · 3 days ago" — the whole answer, in a line. */
  sub: string;
  /** The egress class, as the row's compact meta. */
  meta: string;
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
  /**
   * The enrichment egress answers on record (issue #807, Wave 3). Reference
   * material, like the grants ledger above it: the page shows what was
   * answered, and answering again happens where the question is asked.
   */
  enrichConsent?: readonly ApprovalsEnrichConsentRowDTO[];
  /**
   * Could the gateway be ASKED for those answers at all? A gateway older than
   * the consent ledger says so in words (#815) — rendering an empty section
   * would claim nothing was ever answered, which is a different fact.
   */
  enrichConsentReadable?: boolean;
  activity: readonly ApprovalsActivityRowDTO[];
  notices?: readonly NoticeRowDTO[];
  /** Whether the review feed was truncated at the current limit — drives the
   *  in-place "See all" affordance (issue #552). */
  activityTruncated?: boolean;
  /** The itemId/invocationId/requestId/grantId currently mid-flight. */
  busyId: string | null;
  /**
   * What discarding a staged write costs, in the words of the route that
   * performs it. The card states it in place, where the decision is made.
   */
  discardConsequence?: string;
  /**
   * A decision the gateway refused after the page had already let it go
   * (#815). The item comes back exactly as it was, including the member's
   * edit, carrying the gateway's own words; `nonce` makes a second refusal of
   * the same item a fresh event.
   */
  refusal?: { itemId: string | null; message: string; nonce: number } | null;
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
  /** Revoke one store-ledger holder's grant — the row stays, struck through,
   *  rather than vanishing (issue #708 A2). */
  onRevokeStoreGrant: (holder: StoreHolderDTO) => void;
  onReadNotice?: (noticeId: string) => void;
  onArchiveNotice?: (noticeId: string) => void;
  onOpenNotice?: (notice: NoticeRowDTO) => void;
  /** Raise the review-feed limit in place when the list is truncated. */
  onSeeAllActivity?: () => void;
  /** The durable machine-health record, which lives on System — Notifications
   *  links to it and never restates it. */
  onOpenAlertHistory?: () => void;
  /**
   * A request to bring one staged write into view — what tapping an `outbox`
   * notice means (#647 D10). `nonce` makes a repeat tap on the SAME item a new
   * request; the screen opens that item's card and scrolls to it. A null
   * itemId — or one that is no longer open — clears any filter and leaves the
   * queue as it is, rather than pointing at a card that isn't there.
   */
  focusOutbox?: { itemId: string | null; nonce: number } | null;
  /**
   * The app bar's "Review all" verb (#765). It is not a navigation: it drops
   * whatever filter is in force and opens the first staged write, which is what
   * "review all of it" means on a page whose content is already all here.
   */
  reviewAll?: { nonce: number } | null;
}

// ── Copy that states a rule ────────────────────────────────────────────────
// Every sentence both surfaces render lives in `../../approvals-copy.js`
// (issue #805) — see its header for why the two stopped keeping separate
// copies. What is left here is desktop's alone.

const LEDGER_NOTE =
  "Everything an app can reach — revoking takes effect at once.";

/** The enrichment ledger's note (issue #807). It states the rule the rows
 *  obey: each is an answer, asked once and recorded, not a switch on a page. */
const ENRICH_CONSENT_NOTE =
  "Asked once, answered once, recorded — including the answers that were no.";

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
    enrichConsent = [],
    enrichConsentReadable = true,
    activity,
    notices = [],
    activityTruncated = false,
    busyId,
    discardConsequence = APPROVALS_DISCARD_CONSEQUENCE,
    refusal = null,
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
    onOpenAlertHistory,
    focusOutbox = null,
    reviewAll = null,
  } = props;

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>(
    {}
  );
  const [alwaysAllow, setAlwaysAllow] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [expandedActivity, setExpandedActivity] = useState<string | null>(null);
  const [waitingFilter, setWaitingFilter] = useState<WaitingFilter>("all");
  const [activityFilter, setActivityFilter] = useState<"all" | "denied">("all");
  const [seenFocusNonce, setSeenFocusNonce] = useState<number | null>(null);
  const [seenReviewNonce, setSeenReviewNonce] = useState<number | null>(null);
  const [seenRefusalNonce, setSeenRefusalNonce] = useState<number | null>(null);
  const [openSections, setOpenSections] = useState<
    Record<RecordSection, boolean>
  >(() => {
    const open = pointerDefaultOpen();
    return { activity: open, egress: open, grants: open, ledger: open };
  });
  // Snapshots of grants the owner has switched off THIS session. The revoke
  // call deletes the grant row outright, so the next fetch would simply drop it
  // from `storeGrants` — keeping a copy of the row as it looked at the moment
  // of revoke is what lets it stay visible, struck through, instead of
  // vanishing (issue #708 A2: "the history of the grant stays legible").
  const [revokedStoreHolders, setRevokedStoreHolders] = useState<
    ReadonlyMap<string, StoreHolderDTO>
  >(new Map());
  /** The blocking lists as they were when the member started working in them.
   *  Non-null means a refresh is being held back. */
  const [held, setHeld] = useState<Blocking | null>(null);

  const focusRef = useRef<HTMLDivElement | null>(null);
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
    setEditingId(null);
    setConfirming(null);
    if (stillOpen) setExpandedId(itemId);
  }
  if (reviewAll && reviewAll.nonce !== seenReviewNonce) {
    setSeenReviewNonce(reviewAll.nonce);
    setWaitingFilter("all");
    setEditingId(null);
    setConfirming(null);
    setExpandedId(outbox[0]?.itemId ?? null);
  }
  // A refused write comes BACK — with the member's edit, which never left
  // component state — so the card reopens on the item the gateway named.
  if (refusal && refusal.nonce !== seenRefusalNonce) {
    setSeenRefusalNonce(refusal.nonce);
    if (refusal.itemId !== null) {
      setExpandedId(refusal.itemId);
      if (drafts[refusal.itemId]) setEditingId(refusal.itemId);
    }
  }

  // ── The held tray ───────────────────────────────────────────────────────
  // "Part-way through" is exactly three things: an edit in progress, a ticked
  // "always allow", or an open confirm. Anything less — a card merely
  // expanded — is reading, and reading survives a list changing under it.
  const partWay =
    confirming !== null ||
    editingId !== null ||
    (expandedId !== null && alwaysAllow[expandedId] === true) ||
    (expandedId !== null && drafts[expandedId] !== undefined);

  const incoming: Blocking = { needsAuth, outbox, parked, scopeRequests };
  // `held` is the queue AS IT WAS when the member started working in it,
  // snapshotted the moment they became part-way through and released the
  // moment they finish — so nothing they are holding can be swapped out from
  // under them, and nothing waits longer than the item they are on.
  if (held === null && partWay) setHeld(incoming);
  if (held !== null && !partWay) setHeld(null);
  const shown = held ?? incoming;
  const arrived = held === null ? 0 : arrivalCount(held, incoming);

  useEffect(() => {
    const el = focusRef.current;
    // `scrollIntoView` is absent under jsdom — opening the card is the
    // assertable half of the behaviour, the scroll is the browser nicety.
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [focusOutbox]);

  const activeNotices = notices.filter((notice) => notice.archivedAt === null);
  const archivedNotices = notices.filter(
    (notice) => notice.archivedAt !== null
  );
  // "Waiting" means "requires a decision or an intervention": an info-severity
  // notice (a gateway recovering, an FYI) is news, not a demand, so it sits in
  // Notices rather than the queue (#665).
  const attentionNotices = activeNotices.filter(
    (notice) => notice.severity !== "info"
  );
  const infoNotices = activeNotices.filter(
    (notice) => notice.severity === "info"
  );

  const totalWaiting =
    shown.outbox.length +
    shown.needsAuth.length +
    shown.parked.length +
    shown.scopeRequests.length +
    attentionNotices.length;
  const isEmpty = totalWaiting === 0;

  const toggle = (id: string): void => {
    setExpandedId((prev) => (prev === id ? null : id));
    setEditingId(null);
    setConfirming(null);
  };

  const draftValue = (row: ApprovalsOutboxRowDTO, key: string): string =>
    drafts[row.itemId]?.[key] ??
    row.fields.find((f) => f.key === key)?.value ??
    "";

  const seedDraft = (row: ApprovalsOutboxRowDTO): void => {
    setDrafts((prev) => {
      if (prev[row.itemId]) return prev;
      const seed: Record<string, string> = {};
      for (const field of row.fields) {
        if (!isAuthorableKey(row.artifact, field.key)) continue;
        const raw = row.artifact[field.key];
        seed[field.key] = Array.isArray(raw) ? raw.join(", ") : String(raw);
      }
      return { ...prev, [row.itemId]: seed };
    });
  };

  const submitEdit = (row: ApprovalsOutboxRowDTO): void => {
    const draft = drafts[row.itemId] ?? {};
    const artifact: Record<string, unknown> = { ...row.artifact };
    for (const [key, text] of Object.entries(draft)) {
      if (!isAuthorableKey(row.artifact, key)) continue;
      artifact[key] = Array.isArray(row.artifact[key])
        ? text
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : text;
    }
    setEditingId(null);
    onApproveOutbox(row.itemId, alwaysAllow[row.itemId] === true, artifact);
  };

  // ── One staged write's facts ────────────────────────────────────────────
  const statedFacts = (row: ApprovalsOutboxRowDTO): DecideFact[] => {
    const facts: DecideFact[] = [];
    // Address facts first, in the order an envelope is read; then anything
    // else the artifact carries, so nothing staged is hidden from the person
    // approving it. `body`/`subject` are already the card's quote and title.
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

  /** The same artifact, with the fields a member may AUTHOR as inputs. */
  const editableFacts = (row: ApprovalsOutboxRowDTO): DecideFact[] =>
    row.fields.map((field) => {
      const value = draftValue(row, field.key);
      if (!isAuthorableKey(row.artifact, field.key)) {
        return { key: field.key, mono: true, value: field.value };
      }
      return {
        field: {
          label: field.label,
          multiline:
            !Array.isArray(row.artifact[field.key]) &&
            wantsTextarea(field.key, value),
          onChange: (next: string) =>
            setDrafts((prev) => ({
              ...prev,
              [row.itemId]: { ...prev[row.itemId], [field.key]: next },
            })),
        },
        key: field.key,
        value,
      };
    });

  const stagedBody = (row: ApprovalsOutboxRowDTO): string =>
    row.fields.find((f) => f.key === "body")?.value ??
    row.bodyPreview ??
    row.target;

  // ── The verbs, in the three shapes every kind shares ────────────────────
  // One outlined Review while a card is closed; a confirm's [Do it] / [Keep
  // it]; and the kind's own when it is open. An empty row while a decision is
  // in flight, because a second press is a second send.

  const reviewVerb = (id: string): DecideAction => ({
    commits: false,
    kind: "outline",
    label: "Review",
    onClick: () => toggle(id),
  });

  const confirmVerbs = (run: () => void): DecideAction[] => [
    {
      kind: "net",
      label: "Do it",
      onClick: () => {
        setConfirming(null);
        run();
      },
    },
    { kind: "quiet", label: "Keep it", onClick: () => setConfirming(null) },
  ];

  const denyVerb = (id: string, verb: Confirming["verb"]): DecideAction => ({
    kind: "net",
    label: "Deny",
    onClick: () => setConfirming({ id, verb }),
  });

  // ── The decision cards ──────────────────────────────────────────────────
  const cards: JSX.Element[] = [];

  for (const row of shown.outbox) {
    if (!matchesFilter(waitingFilter, "staged")) continue;
    const open = expandedId === row.itemId;
    const editing = editingId === row.itemId;
    const confirmingThis =
      confirming?.id === row.itemId && confirming.verb === "discard";
    const busy = busyId === row.itemId;
    const always = alwaysAllow[row.itemId] === true;
    const actions: DecideAction[] = busy
      ? []
      : confirmingThis
        ? confirmVerbs(() => onDenyOutbox(row.itemId))
        : editing
          ? [
              {
                kind: "commit",
                label: "Approve with edits",
                onClick: () => submitEdit(row),
              },
              {
                kind: "quiet",
                label: "Cancel",
                onClick: () => setEditingId(null),
              },
            ]
          : open
            ? [
                {
                  kind: "commit",
                  label: "Approve",
                  onClick: () => onApproveOutbox(row.itemId, always),
                },
                {
                  disabled: !row.canEdit,
                  hint: row.canEdit
                    ? "Edits seed from the staged artifact"
                    : APPROVALS_CANNOT_EDIT_VALUE,
                  kind: "outline",
                  label: "Edit and approve",
                  onClick: () => {
                    seedDraft(row);
                    setEditingId(row.itemId);
                  },
                },
                {
                  kind: "net",
                  label: "Discard",
                  onClick: () =>
                    setConfirming({ id: row.itemId, verb: "discard" }),
                },
              ]
            : [reviewVerb(row.itemId)];
    const refusedHere = refusal?.itemId === row.itemId ? refusal.message : null;
    cards.push(
      <div
        data-item-id={row.itemId}
        data-open={open ? "true" : undefined}
        data-testid="staged-write"
        key={row.itemId}
        ref={focusOutbox?.itemId === row.itemId && open ? focusRef : undefined}
      >
        <DecideBlock
          actions={actions}
          age={row.stagedAgo}
          {...(open && !confirmingThis && !editing
            ? {
                check: {
                  disabled: busy,
                  label: APPROVALS_ALWAYS_TITLE,
                  on: always,
                  onChange: (next) =>
                    setAlwaysAllow((prev) => ({
                      ...prev,
                      [row.itemId]: next,
                    })),
                  sub: `${callerPhrase(row.callerKind, row.caller)} may ${row.verb} → ${row.target} without asking again.`,
                },
              }
            : {})}
          confirming={confirmingThis}
          eyebrow={`Staged write · ${row.connectionLabel}`}
          facts={open ? (editing ? editableFacts(row) : statedFacts(row)) : []}
          note={
            confirmingThis
              ? discardConsequence
              : editing
                ? APPROVALS_EDIT_SUB
                : (refusedHere ?? undefined)
          }
          noteNet={confirmingThis || refusedHere !== null}
          onToggle={() => toggle(row.itemId)}
          open={open}
          {...(open
            ? {
                preview: {
                  body: stagedBody(row),
                  label: "what it would do",
                },
              }
            : {})}
          sub={subLine([
            outboundLabel(row),
            `staged by ${callerPhrase(row.callerKind, row.caller)}`,
          ])}
          title={row.subject ?? row.target}
        />
      </div>
    );
  }

  for (const row of shown.needsAuth) {
    if (!matchesFilter(waitingFilter, "auth")) continue;
    const open = expandedId === row.connectionId;
    cards.push(
      <DecideBlock
        actions={[
          {
            commits: false,
            hint: "Re-authorizing happens on the connection",
            kind: "outline",
            label: "Open Connectors",
            onClick: () => onOpenSettings(),
          },
        ]}
        eyebrow={`Authorization · ${row.label}`}
        facts={
          open
            ? [
                { key: "connection", value: row.label },
                { key: "kind", mono: true, value: row.kind },
              ]
            : []
        }
        key={row.connectionId}
        net
        onToggle={() => toggle(row.connectionId)}
        open={open}
        sub={row.note ?? `${row.kind} needs reconnecting`}
        title={`${row.label} needs re-authorizing`}
      />
    );
  }

  for (const row of shown.parked) {
    if (!matchesFilter(waitingFilter, "risk")) continue;
    const open = expandedId === row.invocationId;
    const confirmingThis =
      confirming?.id === row.invocationId && confirming.verb === "deny-parked";
    const busy = busyId === row.invocationId;
    const actions: DecideAction[] = busy
      ? []
      : confirmingThis
        ? confirmVerbs(() => onConfirmParked(row.invocationId, false))
        : open
          ? [
              {
                kind: "commit",
                label: "Approve",
                onClick: () => onConfirmParked(row.invocationId, true),
              },
              denyVerb(row.invocationId, "deny-parked"),
            ]
          : [reviewVerb(row.invocationId)];
    cards.push(
      <DecideBlock
        actions={actions}
        age={`parked ${row.parkedAgo}`}
        confirming={confirmingThis}
        eyebrow={`Parked command · ${callerPhrase(row.callerKind, row.caller)}`}
        facts={
          open ? [{ key: "input", mono: true, value: row.inputPreview }] : []
        }
        key={row.invocationId}
        net
        note={
          confirmingThis
            ? `A denied command cannot be replayed — ${row.caller} must ask again.`
            : undefined
        }
        noteNet={confirmingThis}
        onToggle={() => toggle(row.invocationId)}
        open={open}
        sub={subLine([
          `asked by ${callerPhrase(row.callerKind, row.caller)}`,
          "held until you rule",
        ])}
        title={row.command}
      />
    );
  }

  for (const row of shown.scopeRequests) {
    if (!matchesFilter(waitingFilter, "auth")) continue;
    const open = expandedId === row.requestId;
    const confirmingThis =
      confirming?.id === row.requestId && confirming.verb === "deny-scope";
    const busy = busyId === row.requestId;
    const actions: DecideAction[] = busy
      ? []
      : confirmingThis
        ? confirmVerbs(() => onDecideScopeRequest(row.requestId, false))
        : open
          ? [
              {
                kind: "commit",
                label: "Approve the wider access",
                onClick: () => onDecideScopeRequest(row.requestId, true),
              },
              denyVerb(row.requestId, "deny-scope"),
            ]
          : [reviewVerb(row.requestId)];
    cards.push(
      <DecideBlock
        actions={actions}
        age={row.requestedAgo}
        confirming={confirmingThis}
        eyebrow={`Access request · ${row.appId}`}
        facts={
          open
            ? [
                { key: "purpose", value: row.purpose },
                { key: "scopes", mono: true, value: row.scopeSummary },
              ]
            : []
        }
        key={row.requestId}
        note={
          confirmingThis
            ? `${row.appId} keeps what it has, and is not asked again.`
            : undefined
        }
        noteNet={confirmingThis}
        onToggle={() => toggle(row.requestId)}
        open={open}
        sub={row.purpose}
        title={`${row.appId} asks for wider access`}
      />
    );
  }

  /** A notice, as a card: the same three verbs wherever it is filed. */
  const noticeCard = (notice: NoticeRowDTO): JSX.Element => {
    const actions: DecideAction[] = [
      {
        commits: false,
        kind: "outline",
        label: "Open",
        onClick: () => onOpenNotice(notice),
      },
    ];
    if (notice.readAt === null) {
      actions.push({
        kind: "quiet",
        label: "Mark read",
        onClick: () => onReadNotice(notice.noticeId),
      });
    }
    actions.push({
      kind: "quiet",
      label: "Archive",
      onClick: () => onArchiveNotice(notice.noticeId),
    });
    return (
      <DecideBlock
        actions={actions}
        age={new Date(notice.lastAt).toLocaleString()}
        eyebrow={subLine([
          noticeSeverityLabel(notice.kind, notice.severity) ?? "Notice",
          notice.sourceLabel,
          notice.kind.replaceAll("-", " "),
        ])}
        key={notice.noticeId}
        net={notice.severity === "high"}
        sub={subLine([noticeSpanPhrase(notice), notice.detailText])}
        title={notice.headline}
      />
    );
  };

  for (const notice of attentionNotices) {
    if (!matchesFilter(waitingFilter, "risk")) continue;
    cards.push(noticeCard(notice));
  }

  const shownWaiting = cards.length;
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
      onClick: () => setConfirming({ id: row.grantId, verb: "revoke-grant" }),
    },
    dangerous: true,
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
            // The rule that decided this, opened where rules are revoked —
            // one revoke, in one place, rather than a second one down here.
            <div className={styles.detailActions}>
              <Button
                commit={false}
                label="Open the grant"
                onClick={() => {
                  setOpenSections((prev) => ({ ...prev, grants: true }));
                  const el = grantsRef.current;
                  if (el && typeof el.scrollIntoView === "function") {
                    el.scrollIntoView({ block: "start" });
                  }
                }}
                size="sm"
                variant="secondary"
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

  const sectionToggle =
    (key: RecordSection): (() => void) =>
    () =>
      setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));

  /** The confirm a ROW's verb opens: the consequence, and the two verbs, in a
   *  panel above the group it belongs to — a row has nowhere to put them. */
  const rowConfirm = (
    title: string,
    body: string,
    onDo: () => void
  ): JSX.Element => (
    <PanelBlock
      action={{ dangerous: true, label: "Do it", onClick: onDo }}
      action2={{ label: "Keep it", onClick: () => setConfirming(null) }}
      body={body}
      eyebrow="Revoke"
      title={title}
      tone="net"
      wide
    />
  );

  // ── The reference tail ──────────────────────────────────────────────────
  // Standing grants, the store ledger, the network-call list and the history
  // are not a queue: they are the page's reference material, and they render
  // in every state, including empty. A consent surface that hides the record
  // of what it already consented to is not a record.
  const grantConfirmId =
    confirming?.verb === "revoke-grant" ? confirming.id : null;
  const holderConfirmKey =
    confirming?.verb === "revoke-holder" ? confirming.id : null;

  const tail = (
    <>
      <div ref={grantsRef}>
        <SectionBlock
          collapsed={!openSections.grants}
          label="Standing grants"
          meta={String(grants.length)}
          onToggle={sectionToggle("grants")}
        />
        {openSections.grants ? (
          <>
            {grantConfirmId
              ? rowConfirm(
                  "Matching items park for review again",
                  APPROVALS_REVOKE_GRANT_CONSEQUENCE,
                  () => {
                    setConfirming(null);
                    onRevokeGrant(grantConfirmId);
                  }
                )
              : null}
            {grantRows.length > 0 ? (
              <RowsBlock ariaLabel="Standing grants" rows={grantRows} />
            ) : (
              <NoteBlock>{APPROVALS_NO_GRANTS_NOTE}</NoteBlock>
            )}
            <NoteBlock>{APPROVALS_GRANTS_NOTE}</NoteBlock>
          </>
        ) : null}
      </div>

      {infoNotices.length > 0 ? (
        <div data-testid="notices">
          <SectionBlock label="Notices" meta={String(infoNotices.length)} />
          {infoNotices.map(noticeCard)}
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
              sub: subLine([
                notice.kind.replaceAll("-", " "),
                notice.sourceLabel,
                notice.detailText,
              ]),
              title: notice.headline,
            }))}
          />
        </div>
      ) : null}

      {storeGrants.length > 0 ? (
        <div data-testid="privacy-ledger">
          <SectionBlock
            collapsed={!openSections.ledger}
            label="Who holds which store"
            meta={`${storeGrants.length} stores`}
            onToggle={sectionToggle("ledger")}
          />
          {openSections.ledger ? (
            <>
              <NoteBlock>{LEDGER_NOTE}</NoteBlock>
              {storeGrants.map((group) => {
                const merged = mergeRevokedHolders(group, revokedStoreHolders);
                const count = merged.holders.length;
                // The holder this store's confirm is about, if it is this
                // store's at all — one lookup, so the sentence and the act
                // can never name two different rows.
                const confirmed = merged.holders.find(
                  (holder) =>
                    revokedHolderKey(group.storeId, holder.grantId) ===
                    holderConfirmKey
                );
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
                          const key = revokedHolderKey(
                            group.storeId,
                            holder.grantId
                          );
                          const revoked = revokedStoreHolders.has(key);
                          return {
                            action: {
                              label: revoked ? "Revoked" : "Revoke",
                              onClick: () =>
                                setConfirming({
                                  id: key,
                                  verb: "revoke-holder",
                                }),
                              title: `Revoke ${holder.mode} access to ${group.label} from ${holder.holderLabel}`,
                            },
                            dangerous: !revoked,
                            id: `${holder.holderKind}-${holder.holderId}-${holder.grantId}`,
                            meta: holder.mode,
                            off: revoked || busyId === holder.grantId,
                            struck: revoked,
                            sub: `${holder.holderKind === "agent" ? "automation" : "app"} · ${holder.mode} access`,
                            title: holder.holderLabel,
                          };
                        })}
                        stacked
                      />
                    ) : null}
                    {confirmed && holderConfirmKey !== null
                      ? rowConfirm(
                          `${confirmed.holderLabel} loses that store`,
                          "It cannot read again, and the row stays, struck through.",
                          () => {
                            setConfirming(null);
                            setRevokedStoreHolders(
                              (previous) =>
                                new Map([
                                  ...previous,
                                  [holderConfirmKey, confirmed],
                                ])
                            );
                            onRevokeStoreGrant(confirmed);
                          }
                        )
                      : null}
                  </div>
                );
              })}
            </>
          ) : null}
        </div>
      ) : null}

      {enrichConsent.length > 0 || !enrichConsentReadable ? (
        <div data-testid="enrichment-consent">
          <SectionBlock
            collapsed={!openSections.egress}
            label="Answers about what may leave"
            meta={
              enrichConsentReadable
                ? `${enrichConsent.length} answered`
                : "not readable here"
            }
            onToggle={sectionToggle("egress")}
          />
          {openSections.egress ? (
            enrichConsentReadable ? (
              <>
                <NoteBlock>{ENRICH_CONSENT_NOTE}</NoteBlock>
                <RowsBlock
                  ariaLabel="Enrichment egress answers"
                  rows={enrichConsent.map((row) => ({
                    id: row.id,
                    meta: row.meta,
                    sub: row.sub,
                    title: row.title,
                  }))}
                />
              </>
            ) : (
              <PanelBlock
                body={APPROVALS_OLD_GATEWAY_BODY}
                eyebrow="Not available"
                title={APPROVALS_OLD_GATEWAY_TITLE}
                wide
              />
            )
          ) : null}
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
            collapsed={!openSections.activity}
            label="Recent activity"
            meta={
              filteredActivity.length === activity.length
                ? String(activity.length)
                : `showing ${filteredActivity.length} of ${activity.length}`
            }
            onToggle={sectionToggle("activity")}
          />
          {openSections.activity ? (
            <>
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
                <RowsBlock
                  ariaLabel="Recent activity"
                  rows={activityRows}
                  stacked
                />
              ) : (
                <NoteBlock>No denied activity in this window.</NoteBlock>
              )}
              {activityTruncated && onSeeAllActivity ? (
                <div data-testid="activity-see-all">
                  <RowsBlock
                    ariaLabel="Raise the cap"
                    rows={[
                      {
                        action: {
                          label: "See all",
                          onClick: () => onSeeAllActivity(),
                        },
                        id: "see-all",
                        sub: "Raises the cap here — there is no separate audit log.",
                        title: `See all ${activity.length} decisions`,
                      },
                    ]}
                    stacked
                  />
                </div>
              ) : null}
              {onOpenAlertHistory ? (
                <RowsBlock
                  ariaLabel="Alert history"
                  rows={[
                    {
                      action: {
                        label: "Open",
                        onClick: () => onOpenAlertHistory(),
                      },
                      id: "alert-history",
                      meta: "System",
                      sub: "Machine health lives on System, not here.",
                      title: "Gateway alert history",
                    },
                  ]}
                />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );

  // ── The three conditional panels, above everything ──────────────────────
  const heads = (
    <>
      {refusal ? (
        <PanelBlock
          body={refusal.message}
          eyebrow="Not written"
          title={APPROVALS_REFUSED_TITLE}
          tone="net"
          wide
        />
      ) : null}
      {held !== null && arrived > 0 ? (
        <div data-testid="held-tray">
          <PanelBlock
            // Re-baseline rather than release: the member is still part-way
            // through their item, so dropping the hold outright would snapshot
            // again on the very next render.
            action={{ label: "Add them", onClick: () => setHeld(incoming) }}
            body={APPROVALS_HELD_BODY}
            eyebrow="Live"
            title={`${arrived} more arrived`}
            wide
          />
        </div>
      ) : null}
    </>
  );

  if (isEmpty) {
    return (
      <div className={styles.page}>
        {heads}
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
      {heads}

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

      {cards}

      {tail}
    </div>
  );
}
