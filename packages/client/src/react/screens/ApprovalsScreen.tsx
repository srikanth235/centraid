// governance: allow-repo-hygiene file-size-limit (#363) single cohesive screen component (list + detail + action rows for one surface); splitting would fragment one visual unit
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import type { IconName } from "@centraid/design";

import Button from "../ui/Button.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import KindBadge from "../ui/KindBadge.js";

import emptyCss from "../styles/pageEmpty.module.css";
import styles from "./ApprovalsScreen.module.css";

// The Approvals screen (issues #306/#308) — the desktop UI for the vault's
// consent surface that shipped with no renderer: agents stage external
// writes (outbox), connections lapse and need reconnection, Tier 3/4 acts
// park, and republished manifests ask for wider scopes. This screen is the
// one place an owner sees all four and decides. Standing grants (the
// "always allow" bypass an outbox approval can mint) live here too — a
// list + revoke, not a Settings page (Settings is another surface's own).
//
// Purely presentational: ApprovalsRoute fetches `GET /_vault/blocking` +
// `GET /_vault/outbox-grants`, maps the wire shapes to the DTOs below, and
// wires the callbacks to `gateway-client-outbox.ts` (confirm/prompt
// overlays live at the route, not here — see HomeRoute's delete/rename
// flows for the same split).

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
  /** Every artifact key/value, readably stringified, for the detail panel. */
  fields: readonly { key: string; label: string; value: string }[];
  stagedAgo: string;
  note: string | null;
  /**
   * WHO staged this write — the sibling gap to the parked-row requester-
   * identity fix (issue: parked-invocation trust legibility applies just as
   * much to an outbound external send, arguably more). Never null: falls
   * back to the raw kind string when no display name is known. The gateway
   * refines the stored `ai_agent` into `'agent' | 'assistant'` on the wire
   * (VaultPlane.refineActorKind, matching the parked plane's vocabulary), so
   * the badge distinguishes App vs Automation vs Assistant like parked rows.
   */
  caller: string;
  callerKind: string;
  /**
   * Whether the gateway has a request rebuilder for this item's verb
   * (issue #308 A5 UI slice) — gates the "Edit" affordance. `false` keeps
   * the honest "can't be edited yet" copy.
   */
  canEdit: boolean;
  /** Raw artifact, keyed exactly as staged — seeds the edit form and lets non-editable fields ride through unchanged. */
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
  /**
   * WHO is asking — refines a raw 'agent' credential into 'assistant' when
   * it's the vault assistant's own identity, not an automation's (issue:
   * parked-invocation trust legibility — the owner deciding whether to
   * approve a destructive command couldn't tell app vs automation vs
   * assistant apart before this field existed).
   */
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
  /** Absolute ISO timestamp for `title` + expanded detail. */
  occurredAt: string;
  /** Wire decision: `allow` | `deny` (schema); rendered as Allowed / Denied. */
  decision: string;
  /** Salience marker; null on pre-#306 receipts — no placeholder. */
  risk: string | null;
  /** Acting identity display name; falls back to kind when null. */
  actor: string | null;
  /** Refined kind for KindBadge (`app` / `agent` / `assistant` / `owner`). */
  actorKind: string | null;
  /** Standing outbox grant when this receipt was auto-allowed. */
  grantId: string | null;
  /**
   * How the allow decision was made — grant auto-allow vs owner approval.
   * Null on denies and rows with no attribution signal.
   */
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
  activity: readonly ApprovalsActivityRowDTO[];
  notices?: readonly NoticeRowDTO[];
  /**
   * Whether the review feed was truncated at the current limit — drives the
   * in-place "See all" affordance (issue #552; no separate audit screen).
   */
  activityTruncated?: boolean;
  /** The itemId/invocationId/requestId/grantId currently mid-flight — disables its row's actions. */
  busyId: string | null;
  /**
   * `artifact` is present only for an edit-then-approve (issue #308 A5 UI
   * slice) — the gateway rebuilds the wire request server-side from it.
   */
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
  onReadNotice?: (noticeId: string) => void;
  onArchiveNotice?: (noticeId: string) => void;
  onOpenNotice?: (notice: NoticeRowDTO) => void;
  /** Raise the review-feed limit in place when the list is truncated. */
  onSeeAllActivity?: () => void;
  /**
   * A request to bring one outbox decision into view — what tapping an
   * `outbox` notice means (#647 D10). `nonce` makes a repeat tap on the SAME
   * item a new request; the screen switches to "Needs me", expands that row
   * and scrolls it into view. A null itemId — or one that is no longer open
   * (already decided, drained) — lands on "Needs me" with nothing focused.
   */
  focusOutbox?: { itemId: string | null; nonce: number } | null;
}

function GroupHead({
  icon,
  label,
  count,
}: {
  icon: JSX.Element;
  label: string;
  count: number;
}): JSX.Element {
  return (
    <div className={styles.groupHead}>
      <span className={styles.groupIcon}>{icon}</span>
      <h2>{label}</h2>
      <span className={styles.groupCount}>{count}</span>
    </div>
  );
}

/** `artifact[key]` is editable (string or a list of strings) — the shape the gateway's shape-drift guard accepts. */
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

/** A textarea reads better than a single-line input for body-like or already-multi-line text. */
function wantsTextarea(key: string, value: string): boolean {
  return (
    key.toLowerCase().includes("body") ||
    value.includes("\n") ||
    value.length > 120
  );
}

/** The requester badge an outbox row shows next to its actor name — mirrors `parkedKindBadge`. */
function outboxKindBadge(kind: string): JSX.Element | null {
  switch (kind) {
    case "app":
      return <KindBadge kind="app">App</KindBadge>;
    case "agent":
      return <KindBadge kind="automation">Automation</KindBadge>;
    case "assistant":
      return <KindBadge kind="assistant">Assistant</KindBadge>;
    default:
      return null;
  }
}

function OutboxRow({
  row,
  busy,
  expanded,
  focused = false,
  onToggle,
  onApprove,
  onDeny,
}: {
  row: ApprovalsOutboxRowDTO;
  busy: boolean;
  expanded: boolean;
  /** Deep-link target from an outbox notice — highlight and scroll into view. */
  focused?: boolean;
  onToggle: () => void;
  onApprove: (alwaysAllow: boolean, artifact?: Record<string, unknown>) => void;
  onDeny: () => void;
}): JSX.Element {
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    // `scrollIntoView` is absent under jsdom — the highlight is the assertable
    // half of the behaviour, the scroll is the browser-only nicety.
    if (focused && el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [focused]);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState<Record<string, string>>({});

  const editableKeys = useMemo(
    () =>
      row.fields
        .map((f) => f.key)
        .filter((key) => isEditableKey(row.artifact, key)),
    [row.artifact, row.fields]
  );
  const isListKey = (key: string): boolean => Array.isArray(row.artifact[key]);

  const startEdit = (): void => {
    const seed: Record<string, string> = {};
    for (const key of editableKeys) {
      const v = row.artifact[key];
      seed[key] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    setEditText(seed);
    setEditing(true);
  };
  const cancelEdit = (): void => setEditing(false);
  const submitEdit = (): void => {
    const artifact: Record<string, unknown> = { ...row.artifact };
    for (const key of editableKeys) {
      const raw = editText[key] ?? "";
      artifact[key] = isListKey(key)
        ? raw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : raw;
    }
    onApprove(alwaysAllow, artifact);
    setEditing(false);
  };

  return (
    <div
      ref={rootRef}
      className={styles.row}
      data-expanded={expanded ? "true" : undefined}
      data-focused={focused ? "true" : undefined}
      data-testid={`outbox-row-${row.itemId}`}
    >
      <button type="button" className={styles.rowMain} onClick={onToggle}>
        <span className={styles.rowIcon}>
          <Icon name="Send" size={14} />
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowTitle}>{row.subject ?? row.target}</span>
          <span className={styles.rowSub}>
            {row.recipient} · {row.connectionLabel}
          </span>
          <span className={cx(styles.rowSub, styles.rowSubCaller)}>
            {outboxKindBadge(row.callerKind)}
            <span>{row.caller}</span>
          </span>
        </span>
        <span className={styles.rowMeta}>{row.stagedAgo}</span>
        <Icon name="ChevronRight" size={14} />
      </button>
      {expanded ? (
        <div className={styles.detail}>
          <dl className={styles.fields}>
            {row.fields.map((f) => {
              const editableHere = editing && editableKeys.includes(f.key);
              return (
                <div key={f.key} className={styles.field}>
                  <dt>{f.label}</dt>
                  {editableHere ? (
                    isListKey(f.key) ||
                    !wantsTextarea(f.key, editText[f.key] ?? "") ? (
                      <input
                        type="text"
                        className={styles.editInput}
                        aria-label={f.label}
                        value={editText[f.key] ?? ""}
                        onChange={(e) =>
                          setEditText((prev) => ({
                            ...prev,
                            [f.key]: e.target.value,
                          }))
                        }
                      />
                    ) : (
                      <textarea
                        className={styles.editTextarea}
                        aria-label={f.label}
                        value={editText[f.key] ?? ""}
                        onChange={(e) =>
                          setEditText((prev) => ({
                            ...prev,
                            [f.key]: e.target.value,
                          }))
                        }
                      />
                    )
                  ) : (
                    <dd>{f.value}</dd>
                  )}
                </div>
              );
            })}
          </dl>
          {row.note ? (
            <p className={styles.detailNote}>Note: {row.note}</p>
          ) : null}
          <label className={styles.alwaysAllow}>
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => setAlwaysAllow(e.target.checked)}
            />
            Always allow {row.verb} → {row.target}
          </label>
          {row.canEdit ? null : (
            <p className={styles.editNote}>
              This preview can’t be edited yet — approving sends exactly what’s
              shown above.
            </p>
          )}
          <div className={styles.actions}>
            {row.canEdit && !editing ? (
              <Button
                label="Edit"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={startEdit}
              />
            ) : null}
            <Button
              label="Deny"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onDeny}
              className={styles.denyBtn}
            />
            {editing ? (
              <Button
                label="Cancel"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={cancelEdit}
              />
            ) : null}
            <Button
              label={editing ? "Approve with edits" : "Approve"}
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => (editing ? submitEdit() : onApprove(alwaysAllow))}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NeedsAuthRow({
  row,
  onOpenSettings,
}: {
  row: ApprovalsNeedsAuthRowDTO;
  onOpenSettings: () => void;
}): JSX.Element {
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <span className={cx(styles.rowIcon, styles.warnIcon)}>
          <Icon name="AlertTriangle" size={14} />
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowTitle}>{row.label}</span>
          <span className={styles.rowSub}>
            {row.note ?? `${row.kind} needs reconnecting`}
          </span>
        </span>
        <Button
          label="Reconnect"
          variant="soft"
          size="sm"
          onClick={onOpenSettings}
        />
      </div>
    </div>
  );
}

/** The requester badge a parked row shows next to its display name. */
function parkedKindBadge(
  kind: ApprovalsParkedRowDTO["callerKind"]
): JSX.Element | null {
  switch (kind) {
    case "app":
      return <KindBadge kind="app">App</KindBadge>;
    case "agent":
      return <KindBadge kind="automation">Automation</KindBadge>;
    case "assistant":
      return <KindBadge kind="assistant">Assistant</KindBadge>;
    case "owner-device":
      return null;
    default:
      return null;
  }
}

function ParkedRow({
  row,
  busy,
  expanded,
  onToggle,
  onConfirm,
}: {
  row: ApprovalsParkedRowDTO;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onConfirm: (approve: boolean) => void;
}): JSX.Element {
  return (
    <div className={styles.row} data-expanded={expanded ? "true" : undefined}>
      <button type="button" className={styles.rowMain} onClick={onToggle}>
        <span className={styles.rowIcon}>
          <Icon name="Clock" size={14} />
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowTitle}>{row.command}</span>
          <span className={cx(styles.rowSub, styles.rowSubCaller)}>
            {parkedKindBadge(row.callerKind)}
            <span>{row.caller}</span>
          </span>
        </span>
        <span className={styles.rowMeta}>{row.parkedAgo}</span>
        <Icon name="ChevronRight" size={14} />
      </button>
      {expanded ? (
        <div className={styles.detail}>
          <pre className={styles.inputPreview}>{row.inputPreview}</pre>
          <div className={styles.actions}>
            <Button
              label="Deny"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onConfirm(false)}
              className={styles.denyBtn}
            />
            <Button
              label="Approve"
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => onConfirm(true)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ScopeRequestRow({
  row,
  busy,
  onDecide,
}: {
  row: ApprovalsScopeRequestRowDTO;
  busy: boolean;
  onDecide: (approve: boolean) => void;
}): JSX.Element {
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <span className={styles.rowIcon}>
          <Icon name="Key" size={14} />
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowTitle}>{row.appId}</span>
          <span className={styles.rowSub}>
            {row.purpose} · {row.scopeSummary}
          </span>
        </span>
        <span className={styles.rowMeta}>{row.requestedAgo}</span>
        <div className={styles.inlineActions}>
          <Button
            label="Deny"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onDecide(false)}
            className={styles.denyBtn}
          />
          <Button
            label="Approve"
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => onDecide(true)}
          />
        </div>
      </div>
    </div>
  );
}

// No kind badge here: `OutboxGrant` (gateway-client-outbox.ts) carries
// `actor`/`actorId` but no `actorKind` — the wire data this screen would
// need to mirror the App/Automation badge treatment doesn't exist yet for
// standing grants. Left as plain text rather than guessing at a kind.
function GrantRow({
  row,
  busy,
  onRevoke,
}: {
  row: ApprovalsGrantRowDTO;
  busy: boolean;
  onRevoke: () => void;
}): JSX.Element {
  return (
    <div className={styles.grantRow}>
      <span className={styles.grantActor}>{row.actorLabel}</span>
      <span className={styles.grantVerb}>{row.verb}</span>
      <Icon name="ArrowRight" size={12} />
      <span className={styles.grantTarget}>{row.target}</span>
      <span className={styles.grantMeta}>{row.createdAgo}</span>
      <Button
        label="Revoke"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={onRevoke}
        className={styles.denyBtn}
      />
    </div>
  );
}

/** Decision → icon + accent class for Recent activity (issue #552). */
function activityDecisionVisual(decision: string): {
  icon: "CheckCircle" | "X" | "Clock";
  accentClass: string;
  badge: string;
} {
  // CSS-module class names are `string | undefined` under noUncheckedIndexedAccess.
  const allow = styles.decisionAllow ?? "";
  const deny = styles.decisionDeny ?? "";
  const parked = styles.decisionParked ?? "";
  switch (decision) {
    case "allow":
      return { icon: "CheckCircle", accentClass: allow, badge: "Allowed" };
    case "deny":
      return { icon: "X", accentClass: deny, badge: "Denied" };
    case "parked":
      return { icon: "Clock", accentClass: parked, badge: "Parked" };
    default:
      return { icon: "Clock", accentClass: parked, badge: decision };
  }
}

/** Absolute local timestamp for title/expanded detail (issue #552). */
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

function ActivityRow({
  row,
  busy,
  expanded,
  onToggle,
  onRevokeGrant,
}: {
  row: ApprovalsActivityRowDTO;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRevokeGrant: (grantId: string) => void;
}): JSX.Element {
  const visual = activityDecisionVisual(row.decision);
  const absolute = formatAbsoluteTime(row.occurredAt);
  return (
    <div
      className={cx(styles.row, styles.activityRow, visual.accentClass)}
      data-expanded={expanded ? "true" : undefined}
      data-decision={row.decision}
      data-risk={row.risk ?? undefined}
    >
      {row.risk ? (
        <span
          className={styles.riskMarker}
          data-testid="activity-risk-marker"
          title={`Risk: ${row.risk}`}
          aria-label={`Risk ${row.risk}`}
        />
      ) : null}
      <button
        type="button"
        className={styles.rowMain}
        onClick={onToggle}
        title={absolute}
        aria-expanded={expanded}
      >
        <span
          className={cx(styles.rowIcon, styles.activityIcon)}
          data-testid="activity-decision-icon"
        >
          <Icon name={visual.icon} size={14} />
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowTitle}>
            {row.label}
            {row.count > 1 ? (
              <span className={styles.countMarker} data-testid="activity-count">
                ×{row.count}
              </span>
            ) : null}
            <span
              className={styles.decisionBadge}
              data-testid="activity-decision-badge"
            >
              {visual.badge}
            </span>
          </span>
          <span className={styles.rowSub}>{row.detail}</span>
          {row.actor || row.actorKind ? (
            <span
              className={cx(styles.rowSub, styles.rowSubCaller)}
              data-testid="activity-actor"
            >
              {outboxKindBadge(row.actorKind ?? "")}
              <span>{row.actor ?? row.actorKind}</span>
            </span>
          ) : null}
          {row.attribution === "grant" ? (
            <span
              className={styles.attribution}
              data-testid="activity-attribution-grant"
            >
              Auto-allowed by standing grant
            </span>
          ) : null}
          {row.attribution === "owner" ? (
            <span
              className={styles.attribution}
              data-testid="activity-attribution-owner"
            >
              Approved by the owner
            </span>
          ) : null}
        </span>
        <span className={styles.rowMeta}>{row.occurredAgo}</span>
        <Icon name="ChevronRight" size={14} />
      </button>
      {expanded ? (
        <div className={styles.detail} data-testid="activity-detail">
          <dl className={styles.fields}>
            <div className={styles.field}>
              <dt>Decision</dt>
              <dd>{visual.badge}</dd>
            </div>
            <div className={styles.field}>
              <dt>When</dt>
              <dd>{absolute}</dd>
            </div>
            <div className={styles.field}>
              <dt>Object</dt>
              <dd>
                {row.objectType}
                {row.objectId ? ` · ${row.objectId}` : ""}
              </dd>
            </div>
            {row.risk ? (
              <div className={styles.field}>
                <dt>Risk</dt>
                <dd>{row.risk}</dd>
              </div>
            ) : null}
            {row.actor || row.actorKind ? (
              <div className={styles.field}>
                <dt>Actor</dt>
                <dd>
                  {row.actor ?? row.actorKind}
                  {row.actorKind ? ` (${row.actorKind})` : ""}
                </dd>
              </div>
            ) : null}
            {row.count > 1 ? (
              <div className={styles.field}>
                <dt>Repeats</dt>
                <dd>×{row.count} consecutive</dd>
              </div>
            ) : null}
            <div className={styles.field}>
              <dt>Receipt</dt>
              <dd className={styles.monoId}>{row.receiptId}</dd>
            </div>
          </dl>
          {row.grantId ? (
            <div className={styles.actions} data-testid="activity-revoke-grant">
              <Button
                label="Revoke grant"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onRevokeGrant(row.grantId!)}
                className={styles.denyBtn}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Empty state for the Notifications groups — the grants section renders
 * regardless. `text` defaults to the nothing-waiting claim, which is only
 * honest when NOTHING
 * is waiting; a chip that filters the notice stream passes neutral copy so an
 * empty notice list never implies the pinned decisions are gone too.
 */
function NotificationsEmpty({
  text = "Nothing waiting on you.",
}: {
  text?: string;
}): JSX.Element {
  return (
    <div className={emptyCss.pageEmpty}>
      <div className={emptyCss.pageEmptyIcon}>
        <Icon name="CheckCircle" size={22} />
      </div>
      <div className={emptyCss.pageEmptyText}>{text}</div>
    </div>
  );
}

/**
 * The eight app-icon palette hues (`--c-<hue>` in design-tokens). A notice's
 * correspondent tile borrows one so the same source always looks the same —
 * scan-level "who is talking" identity, the way an app icon works.
 */
const NOTICE_HUES = [
  "amber",
  "forest",
  "indigo",
  "ochre",
  "rose",
  "slate",
  "teal",
  "violet",
] as const;

export type NoticeHue = (typeof NOTICE_HUES)[number];

/** Deterministic hue for a correspondent — stable across renders and reloads. */
export function noticeHue(source: string): NoticeHue {
  let h = 0;
  for (let i = 0; i < source.length; i += 1) {
    h = (h * 31 + source.charCodeAt(i)) % 100003;
  }
  return NOTICE_HUES[h % NOTICE_HUES.length] ?? "slate";
}

/**
 * Correspondent glyph — kind wins (gateway health isn't an "app"), else source
 * type.
 *
 * Nothing WRITES `gateway-health` notices any more (issue #665 retired the
 * desktop's dual-write; health lives on the Gateway page). The branch stays
 * because rows already persisted in `vault.db` by an earlier build are still
 * listed until their owner archives them — deleting it would render real,
 * still-visible cards as generic "app" news the owner can't place.
 */
function noticeIcon(
  kind: string,
  sourceType: NoticeRowDTO["sourceType"]
): IconName {
  if (kind === "gateway-health") return "Cpu";
  switch (sourceType) {
    case "automation":
      return "Bolt";
    case "agent":
      return "Sparkle";
    case "app":
      return "Command";
  }
}

/**
 * Severity as a WORD, not a coloured rail — the pill replaces the off-system
 * `border-left` treatment. `info` gets nothing: a quiet update needs no label.
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

/** Attempt-strip bars are capped; the remainder becomes a leading "+N". */
export const NOTICE_BAR_MAX = 8;

export function noticeBarCount(count: number): number {
  if (!Number.isFinite(count) || count <= 1) return 0;
  return Math.min(Math.floor(count), NOTICE_BAR_MAX);
}

function NoticeRow({
  row,
  busy,
  onRead,
  onArchive,
  onOpen,
}: {
  row: NoticeRowDTO;
  busy: boolean;
  onRead: () => void;
  onArchive: () => void;
  onOpen: () => void;
}): JSX.Element {
  const hue = noticeHue(row.sourceRef || row.sourceLabel || row.kind);
  const severityLabel = noticeSeverityLabel(row.kind, row.severity);
  const spanPhrase = noticeSpanPhrase(row);
  const bars = noticeBarCount(row.count);
  const overflow = row.count - NOTICE_BAR_MAX;
  return (
    <article
      className={styles.noticeRow}
      data-severity={row.severity}
      data-unread={row.readAt === null ? "true" : undefined}
    >
      <span
        className={styles.noticeTile}
        data-hue={hue}
        data-testid="notice-tile"
        aria-hidden="true"
      >
        <Icon name={noticeIcon(row.kind, row.sourceType)} size={14} />
      </span>
      <button type="button" className={styles.noticeBody} onClick={onOpen}>
        <span className={styles.noticeHeadline}>
          {row.readAt === null ? (
            <span
              className={styles.unreadDot}
              data-testid="notice-unread-dot"
              aria-hidden="true"
            />
          ) : null}
          <span className={styles.noticeHeadlineText}>{row.headline}</span>
        </span>
        <span className={styles.noticeMeta}>
          {severityLabel ? (
            <span
              className={styles.severityPill}
              data-testid="notice-severity-pill"
            >
              {severityLabel}
            </span>
          ) : null}
          {row.kind.replaceAll("-", " ")}
          {row.sourceLabel ? ` · ${row.sourceLabel}` : ""} ·{" "}
          {new Date(row.lastAt).toLocaleString()}
          {spanPhrase ? ` · ${spanPhrase}` : ""}
        </span>
        {bars > 0 ? (
          <span className={styles.streak} data-testid="notice-streak">
            {overflow > 0 ? (
              <span className={styles.streakOverflow}>+{overflow}</span>
            ) : null}
            <span className={styles.streakBars} aria-hidden="true">
              {Array.from({ length: bars }, (_, i) => (
                <span key={i} className={styles.streakBar} />
              ))}
            </span>
          </span>
        ) : null}
        {row.detailText ? (
          <span className={styles.noticeDetail}>{row.detailText}</span>
        ) : null}
      </button>
      <div className={styles.noticeActions}>
        {row.readAt === null && row.archivedAt === null ? (
          <Button
            label="Mark read"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onRead}
          />
        ) : null}
        {row.archivedAt === null ? (
          <Button
            label="Archive"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onArchive}
          />
        ) : null}
      </div>
    </article>
  );
}

export default function ApprovalsScreen(
  props: ApprovalsScreenProps
): JSX.Element {
  const {
    outbox,
    needsAuth,
    parked,
    scopeRequests,
    grants,
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
    onReadNotice = () => undefined,
    onArchiveNotice = () => undefined,
    onOpenNotice = () => undefined,
    onSeeAllActivity,
    focusOutbox = null,
  } = props;
  const [expandedOutbox, setExpandedOutbox] = useState<string | null>(null);
  const [expandedParked, setExpandedParked] = useState<string | null>(null);
  const [expandedActivity, setExpandedActivity] = useState<string | null>(null);
  const [activityFilter, setActivityFilter] = useState<"all" | "denied">("all");
  const [notificationsFilter, setNotificationsFilter] = useState<
    "needs" | "automations" | "agents" | "apps" | "archived"
  >("needs");
  const [focusedOutbox, setFocusedOutbox] = useState<string | null>(null);
  const [seenFocusNonce, setSeenFocusNonce] = useState<number | null>(null);

  // Honor a deep link from an outbox notice (#647 D10). Adjusting state while
  // rendering (React's documented "derived from props" escape) rather than in
  // an effect: the move must be part of the same paint as the tap, and a
  // nonce-keyed effect would cascade an extra render. Keyed on the nonce so
  // tapping the same notice twice re-focuses; an item that is no longer open
  // (decided or drained since the notice) lands on "Needs me" with nothing
  // highlighted rather than pointing at a row that isn't there.
  if (focusOutbox && focusOutbox.nonce !== seenFocusNonce) {
    const { itemId } = focusOutbox;
    const stillOpen =
      itemId !== null && outbox.some((row) => row.itemId === itemId);
    setSeenFocusNonce(focusOutbox.nonce);
    setNotificationsFilter("needs");
    setFocusedOutbox(stillOpen ? itemId : null);
    setExpandedOutbox(stillOpen ? itemId : null);
  }

  const filteredActivity = useMemo(() => {
    if (activityFilter === "denied") {
      return activity.filter((r) => r.decision === "deny");
    }
    return activity;
  }, [activity, activityFilter]);

  const activeNotices = notices.filter((notice) => notice.archivedAt === null);
  const archivedNotices = notices.filter(
    (notice) => notice.archivedAt !== null
  );
  const filteredNotices =
    notificationsFilter === "archived"
      ? archivedNotices
      : notificationsFilter === "needs"
        ? // "Needs me" means "requires my attention": an info-severity notice
          // (a gateway recovering, an FYI) is news, not a demand — it stays
          // reachable under its source-type chip and in Archived, but doesn't
          // sit in the default view as an unread obligation (#665). Warning
          // and high keep their place.
          activeNotices.filter((notice) => notice.severity !== "info")
        : activeNotices.filter(
            (notice) =>
              notice.sourceType ===
              (notificationsFilter === "automations"
                ? "automation"
                : notificationsFilter === "agents"
                  ? "agent"
                  : "app")
          );
  const totalCount =
    outbox.length + needsAuth.length + parked.length + scopeRequests.length;
  // Open decisions are pinned at the top under EVERY chip (Archived
  // included): the chips filter the notice stream, they never hide something
  // that is blocking the owner. Hiding them behind "Needs me" made a decision
  // vanish the moment the owner tapped any other chip (#647 D3).
  const showDecisions = totalCount > 0;
  const notificationsEmpty =
    outbox.length === 0 &&
    needsAuth.length === 0 &&
    parked.length === 0 &&
    scopeRequests.length === 0 &&
    activeNotices.length === 0;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.title}>
          <span className={styles.titleIcon}>
            <Icon name="CheckCircle" size={18} strokeWidth={2} />
          </span>
          <h1>Notifications</h1>
        </div>
        <p className={styles.subtitle}>
          {totalCount > 0
            ? `${totalCount} waiting on you`
            : activeNotices.length > 0
              ? `${activeNotices.length} recent update${activeNotices.length === 1 ? "" : "s"}`
              : "Decisions and updates from your automations, agents, and apps."}
        </p>
      </div>

      <fieldset
        className={styles.notificationsFilters}
        aria-label="Notifications filter"
      >
        {(
          [
            ["needs", "Needs me"],
            ["automations", "Automations"],
            ["agents", "Agents"],
            ["apps", "Apps"],
            ["archived", "Archived"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={styles.filterChip}
            data-active={notificationsFilter === value ? "true" : undefined}
            onClick={() => setNotificationsFilter(value)}
          >
            {label}
          </button>
        ))}
      </fieldset>

      {notificationsEmpty && notificationsFilter === "needs" ? (
        <NotificationsEmpty />
      ) : (
        <div className={styles.groups}>
          {showDecisions && totalCount > 0 ? (
            <section>
              <GroupHead
                icon={<Icon name="CheckCircle" size={13} />}
                label="Needs me"
                count={totalCount}
              />
              <div className={styles.list}>
                {outbox.map((row) => (
                  <OutboxRow
                    key={row.itemId}
                    row={row}
                    busy={busyId === row.itemId}
                    expanded={expandedOutbox === row.itemId}
                    focused={focusedOutbox === row.itemId}
                    onToggle={() =>
                      setExpandedOutbox(
                        expandedOutbox === row.itemId ? null : row.itemId
                      )
                    }
                    onApprove={(alwaysAllow, artifact) =>
                      artifact === undefined
                        ? onApproveOutbox(row.itemId, alwaysAllow)
                        : onApproveOutbox(row.itemId, alwaysAllow, artifact)
                    }
                    onDeny={() => onDenyOutbox(row.itemId)}
                  />
                ))}
                {needsAuth.map((row) => (
                  <NeedsAuthRow
                    key={row.connectionId}
                    row={row}
                    onOpenSettings={onOpenSettings}
                  />
                ))}
                {parked.map((row) => (
                  <ParkedRow
                    key={row.invocationId}
                    row={row}
                    busy={busyId === row.invocationId}
                    expanded={expandedParked === row.invocationId}
                    onToggle={() =>
                      setExpandedParked(
                        expandedParked === row.invocationId
                          ? null
                          : row.invocationId
                      )
                    }
                    onConfirm={(approve) =>
                      onConfirmParked(row.invocationId, approve)
                    }
                  />
                ))}
                {scopeRequests.map((row) => (
                  <ScopeRequestRow
                    key={row.requestId}
                    row={row}
                    busy={busyId === row.requestId}
                    onDecide={(approve) =>
                      onDecideScopeRequest(row.requestId, approve)
                    }
                  />
                ))}
              </div>
            </section>
          ) : null}

          {filteredNotices.length > 0 ? (
            <section>
              <GroupHead
                icon={<Icon name="Bell" size={13} />}
                label={
                  notificationsFilter === "archived" ? "Archived" : "Updates"
                }
                count={filteredNotices.length}
              />
              <div className={styles.list}>
                {filteredNotices.map((notice) => (
                  <NoticeRow
                    key={notice.noticeId}
                    row={notice}
                    busy={busyId === notice.noticeId}
                    onRead={() => onReadNotice(notice.noticeId)}
                    onArchive={() => onArchiveNotice(notice.noticeId)}
                    onOpen={() => onOpenNotice(notice)}
                  />
                ))}
              </div>
            </section>
          ) : notificationsFilter === "needs" ? null : (
            // A notice-filtering chip with no matches says only that: the
            // pinned decisions above are still waiting.
            <NotificationsEmpty text="No notices here." />
          )}
        </div>
      )}

      {notificationsFilter === "archived" ? (
        <section className={styles.grantsSection}>
          <GroupHead
            icon={<Icon name="Key" size={13} />}
            label="Standing grants"
            count={grants.length}
          />
          {grants.length > 0 ? (
            <div className={styles.grantsList}>
              {grants.map((row) => (
                <GrantRow
                  key={row.grantId}
                  row={row}
                  busy={busyId === row.grantId}
                  onRevoke={() => onRevokeGrant(row.grantId)}
                />
              ))}
            </div>
          ) : (
            <p className={styles.grantsEmpty}>
              No standing grants yet — “always allow” on an outbox approval
              mints one.
            </p>
          )}
        </section>
      ) : null}

      {notificationsFilter === "archived" && activity.length > 0 ? (
        <section className={styles.grantsSection} data-testid="recent-activity">
          <div className={styles.activityHead}>
            <GroupHead
              icon={<Icon name="History" size={13} />}
              label="Recent activity"
              count={filteredActivity.length}
            />
            <fieldset
              className={styles.activityFilters}
              aria-label="Activity filter"
            >
              <button
                type="button"
                className={styles.filterChip}
                data-active={activityFilter === "all" ? "true" : undefined}
                onClick={() => setActivityFilter("all")}
              >
                All
              </button>
              <button
                type="button"
                className={styles.filterChip}
                data-active={activityFilter === "denied" ? "true" : undefined}
                onClick={() => setActivityFilter("denied")}
                data-testid="activity-filter-denied"
              >
                Denied
              </button>
            </fieldset>
          </div>
          <div className={styles.grantsList}>
            {filteredActivity.map((row) => (
              <ActivityRow
                key={row.receiptId}
                row={row}
                busy={busyId === row.grantId || busyId === row.receiptId}
                expanded={expandedActivity === row.receiptId}
                onToggle={() =>
                  setExpandedActivity(
                    expandedActivity === row.receiptId ? null : row.receiptId
                  )
                }
                onRevokeGrant={onRevokeGrant}
              />
            ))}
          </div>
          {filteredActivity.length === 0 ? (
            <p className={styles.grantsEmpty}>
              No denied activity in this window.
            </p>
          ) : null}
          {activityTruncated && onSeeAllActivity ? (
            <div className={styles.seeAllRow} data-testid="activity-see-all">
              <Button
                label="See all"
                variant="ghost"
                size="sm"
                onClick={onSeeAllActivity}
              />
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
