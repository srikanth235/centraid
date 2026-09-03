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

export interface ApprovalsOutboxRowDTO {
  itemId: string;
  connectionLabel: string;
  connectionKind: string;
  verb: string;
  target: string;
  recipient: string;
  subject: string | null;
  bodyPreview: string | null;
  fields: readonly { key: string; label: string; value: string }[];
  stagedAgo: string;
  note: string | null;
  caller: string;
  callerKind: string;
  canEdit: boolean;
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

export interface ApprovalsActivityRowDTO {
  receiptId: string;
  label: string;
  detail: string;
  objectId: string | null;
  objectType: string;
  occurredAgo: string;
  occurredAt: string;
  decision: string;
  risk: string | null;
  actor: string | null;
  actorKind: string | null;
  grantId: string | null;
  attribution: "grant" | "owner" | null;
  count: number;
  action: string;
}

export interface ApprovalsEnrichConsentRowDTO {
  id: string;
  title: string;
  sub: string;
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
  sourceType: "automation" | "agent" | "app" | "share";
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
  storeGrants: readonly StoreGroup[];
  enrichConsent?: readonly ApprovalsEnrichConsentRowDTO[];
  enrichConsentReadable?: boolean;
  activity: readonly ApprovalsActivityRowDTO[];
  notices?: readonly NoticeRowDTO[];
  activityTruncated?: boolean;
  busyId: string | null;
  discardConsequence?: string;
  refusal?: { itemId: string | null; message: string; nonce: number } | null;
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
  onRevokeStoreGrant: (holder: StoreHolderDTO) => void;
  onReadNotice?: (noticeId: string) => void;
  onArchiveNotice?: (noticeId: string) => void;
  onOpenNotice?: (notice: NoticeRowDTO) => void;
  onSeeAllActivity?: () => void;
  onOpenAlertHistory?: () => void;
  focusOutbox?: { itemId: string | null; nonce: number } | null;
  reviewAll?: { nonce: number } | null;
}

const LEDGER_NOTE =
  "Everything an app can reach — revoking takes effect at once.";

const ENRICH_CONSENT_NOTE =
  "Asked once, answered once, recorded — including the answers that were no.";

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
  const [revokedStoreHolders, setRevokedStoreHolders] = useState<
    ReadonlyMap<string, StoreHolderDTO>
  >(new Map());
  const [held, setHeld] = useState<Blocking | null>(null);

  const focusRef = useRef<HTMLDivElement | null>(null);
  const grantsRef = useRef<HTMLDivElement | null>(null);

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
  if (refusal && refusal.nonce !== seenRefusalNonce) {
    setSeenRefusalNonce(refusal.nonce);
    if (refusal.itemId !== null) {
      setExpandedId(refusal.itemId);
      if (drafts[refusal.itemId]) setEditingId(refusal.itemId);
    }
  }

  const partWay =
    confirming !== null ||
    editingId !== null ||
    (expandedId !== null && alwaysAllow[expandedId] === true) ||
    (expandedId !== null && drafts[expandedId] !== undefined);

  const incoming: Blocking = { needsAuth, outbox, parked, scopeRequests };
  if (held === null && partWay) setHeld(incoming);
  if (held !== null && !partWay) setHeld(null);
  const shown = held ?? incoming;
  const arrived = held === null ? 0 : arrivalCount(held, incoming);

  useEffect(() => {
    const el = focusRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [focusOutbox]);

  const activeNotices = notices.filter((notice) => notice.archivedAt === null);
  const archivedNotices = notices.filter(
    (notice) => notice.archivedAt !== null
  );
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

  const statedFacts = (row: ApprovalsOutboxRowDTO): DecideFact[] => {
    const facts: DecideFact[] = [];
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
  const showChips = totalWaiting > WAITING_CHIPS.length;

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
