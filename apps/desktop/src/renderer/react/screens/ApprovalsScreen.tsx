import { type JSX, useMemo, useState } from 'react';
import Icon from '../ui/Icon.js';
import Button from '../ui/Button.js';
import KindBadge from '../ui/KindBadge.js';
import { cx } from '../ui/cx.js';
import emptyCss from '../styles/pageEmpty.module.css';
import styles from './ApprovalsScreen.module.css';

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
  callerKind: 'app' | 'agent' | 'assistant' | 'owner-device';
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

export interface ApprovalsScreenProps {
  outbox: readonly ApprovalsOutboxRowDTO[];
  needsAuth: readonly ApprovalsNeedsAuthRowDTO[];
  parked: readonly ApprovalsParkedRowDTO[];
  scopeRequests: readonly ApprovalsScopeRequestRowDTO[];
  grants: readonly ApprovalsGrantRowDTO[];
  /** The itemId/invocationId/requestId/grantId currently mid-flight — disables its row's actions. */
  busyId: string | null;
  /**
   * `artifact` is present only for an edit-then-approve (issue #308 A5 UI
   * slice) — the gateway rebuilds the wire request server-side from it.
   */
  onApproveOutbox: (itemId: string, alwaysAllow: boolean, artifact?: Record<string, unknown>) => void;
  onDenyOutbox: (itemId: string) => void;
  onOpenSettings: () => void;
  onConfirmParked: (invocationId: string, approve: boolean) => void;
  onDecideScopeRequest: (requestId: string, approve: boolean) => void;
  onRevokeGrant: (grantId: string) => void;
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
function isEditableKey(artifact: Record<string, unknown>, key: string): boolean {
  const v = artifact[key];
  return typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
}

/** A textarea reads better than a single-line input for body-like or already-multi-line text. */
function wantsTextarea(key: string, value: string): boolean {
  return key.toLowerCase().includes('body') || value.includes('\n') || value.length > 120;
}

function OutboxRow({
  row,
  busy,
  expanded,
  onToggle,
  onApprove,
  onDeny,
}: {
  row: ApprovalsOutboxRowDTO;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onApprove: (alwaysAllow: boolean, artifact?: Record<string, unknown>) => void;
  onDeny: () => void;
}): JSX.Element {
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState<Record<string, string>>({});

  const editableKeys = useMemo(
    () => row.fields.map((f) => f.key).filter((key) => isEditableKey(row.artifact, key)),
    [row.artifact, row.fields],
  );
  const isListKey = (key: string): boolean => Array.isArray(row.artifact[key]);

  const startEdit = (): void => {
    const seed: Record<string, string> = {};
    for (const key of editableKeys) {
      const v = row.artifact[key];
      seed[key] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    setEditText(seed);
    setEditing(true);
  };
  const cancelEdit = (): void => setEditing(false);
  const submitEdit = (): void => {
    const artifact: Record<string, unknown> = { ...row.artifact };
    for (const key of editableKeys) {
      const raw = editText[key] ?? '';
      artifact[key] = isListKey(key)
        ? raw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : raw;
    }
    onApprove(alwaysAllow, artifact);
    setEditing(false);
  };

  return (
    <div className={styles.row} data-expanded={expanded ? 'true' : undefined}>
      <button type="button" className={styles.rowMain} onClick={onToggle}>
        <span className={styles.rowIcon}>
          <Icon name="Send" size={14} />
        </span>
        <span className={styles.rowBody}>
          <span className={styles.rowTitle}>{row.subject ?? row.target}</span>
          <span className={styles.rowSub}>
            {row.recipient} · {row.connectionLabel}
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
                    isListKey(f.key) || !wantsTextarea(f.key, editText[f.key] ?? '') ? (
                      <input
                        type="text"
                        className={styles.editInput}
                        aria-label={f.label}
                        value={editText[f.key] ?? ''}
                        onChange={(e) =>
                          setEditText((prev) => ({ ...prev, [f.key]: e.target.value }))
                        }
                      />
                    ) : (
                      <textarea
                        className={styles.editTextarea}
                        aria-label={f.label}
                        value={editText[f.key] ?? ''}
                        onChange={(e) =>
                          setEditText((prev) => ({ ...prev, [f.key]: e.target.value }))
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
          {row.note ? <p className={styles.detailNote}>Note: {row.note}</p> : null}
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
              This preview can’t be edited yet — approving sends exactly what’s shown above.
            </p>
          )}
          <div className={styles.actions}>
            {row.canEdit && !editing ? (
              <Button label="Edit" variant="ghost" size="sm" disabled={busy} onClick={startEdit} />
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
              <Button label="Cancel" variant="ghost" size="sm" disabled={busy} onClick={cancelEdit} />
            ) : null}
            <Button
              label={editing ? 'Approve with edits' : 'Approve'}
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
          <span className={styles.rowSub}>{row.note ?? `${row.kind} needs reconnecting`}</span>
        </span>
        <Button label="Reconnect" variant="soft" size="sm" onClick={onOpenSettings} />
      </div>
    </div>
  );
}

/** The requester badge a parked row shows next to its display name. */
function parkedKindBadge(kind: ApprovalsParkedRowDTO['callerKind']): JSX.Element | null {
  switch (kind) {
    case 'app':
      return <KindBadge kind="app">App</KindBadge>;
    case 'agent':
      return <KindBadge kind="automation">Automation</KindBadge>;
    case 'assistant':
      return <KindBadge kind="assistant">Assistant</KindBadge>;
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
    <div className={styles.row} data-expanded={expanded ? 'true' : undefined}>
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

/** Empty state for the inbox groups — the grants section renders regardless. */
function InboxEmpty(): JSX.Element {
  return (
    <div className={emptyCss.pageEmpty}>
      <div className={emptyCss.pageEmptyIcon}>
        <Icon name="CheckCircle" size={22} />
      </div>
      <div className={emptyCss.pageEmptyText}>Nothing waiting on you.</div>
    </div>
  );
}

export default function ApprovalsScreen(props: ApprovalsScreenProps): JSX.Element {
  const {
    outbox,
    needsAuth,
    parked,
    scopeRequests,
    grants,
    busyId,
    onApproveOutbox,
    onDenyOutbox,
    onOpenSettings,
    onConfirmParked,
    onDecideScopeRequest,
    onRevokeGrant,
  } = props;
  const [expandedOutbox, setExpandedOutbox] = useState<string | null>(null);
  const [expandedParked, setExpandedParked] = useState<string | null>(null);

  const inboxEmpty =
    outbox.length === 0 && needsAuth.length === 0 && parked.length === 0 && scopeRequests.length === 0;
  const totalCount = outbox.length + needsAuth.length + parked.length + scopeRequests.length;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div className={styles.title}>
          <span className={styles.titleIcon}>
            <Icon name="CheckCircle" size={18} strokeWidth={2} />
          </span>
          <h1>Approvals</h1>
        </div>
        <p className={styles.subtitle}>
          {totalCount > 0
            ? `${totalCount} waiting on you`
            : 'Everything the vault has staged or parked for your say-so.'}
        </p>
      </div>

      {inboxEmpty ? (
        <InboxEmpty />
      ) : (
        <div className={styles.groups}>
          {outbox.length > 0 ? (
            <section>
              <GroupHead icon={<Icon name="Send" size={13} />} label="Outbox" count={outbox.length} />
              <div className={styles.list}>
                {outbox.map((row) => (
                  <OutboxRow
                    key={row.itemId}
                    row={row}
                    busy={busyId === row.itemId}
                    expanded={expandedOutbox === row.itemId}
                    onToggle={() =>
                      setExpandedOutbox(expandedOutbox === row.itemId ? null : row.itemId)
                    }
                    onApprove={(alwaysAllow, artifact) =>
                      artifact !== undefined
                        ? onApproveOutbox(row.itemId, alwaysAllow, artifact)
                        : onApproveOutbox(row.itemId, alwaysAllow)
                    }
                    onDeny={() => onDenyOutbox(row.itemId)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {needsAuth.length > 0 ? (
            <section>
              <GroupHead
                icon={<Icon name="AlertTriangle" size={13} />}
                label="Needs auth"
                count={needsAuth.length}
              />
              <div className={styles.list}>
                {needsAuth.map((row) => (
                  <NeedsAuthRow key={row.connectionId} row={row} onOpenSettings={onOpenSettings} />
                ))}
              </div>
            </section>
          ) : null}

          {parked.length > 0 ? (
            <section>
              <GroupHead icon={<Icon name="Clock" size={13} />} label="Parked" count={parked.length} />
              <div className={styles.list}>
                {parked.map((row) => (
                  <ParkedRow
                    key={row.invocationId}
                    row={row}
                    busy={busyId === row.invocationId}
                    expanded={expandedParked === row.invocationId}
                    onToggle={() =>
                      setExpandedParked(expandedParked === row.invocationId ? null : row.invocationId)
                    }
                    onConfirm={(approve) => onConfirmParked(row.invocationId, approve)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {scopeRequests.length > 0 ? (
            <section>
              <GroupHead
                icon={<Icon name="Key" size={13} />}
                label="Scope requests"
                count={scopeRequests.length}
              />
              <div className={styles.list}>
                {scopeRequests.map((row) => (
                  <ScopeRequestRow
                    key={row.requestId}
                    row={row}
                    busy={busyId === row.requestId}
                    onDecide={(approve) => onDecideScopeRequest(row.requestId, approve)}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      <section className={styles.grantsSection}>
        <GroupHead icon={<Icon name="Key" size={13} />} label="Standing grants" count={grants.length} />
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
            No standing grants yet — “always allow” on an outbox approval mints one.
          </p>
        )}
      </section>
    </div>
  );
}
