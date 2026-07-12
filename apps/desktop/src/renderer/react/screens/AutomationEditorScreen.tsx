// governance: allow-repo-hygiene file-size-limit (#325) single cohesive screen component (Name/Instructions/trigger-picker/tabs form for one surface); splitting would fragment one visual unit
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type JSX } from 'react';
import type { IconName } from '@centraid/design-tokens';
import { formatWhereClauses, relativeRunLabel } from '../../app-format.js';
import { glyphForId, hueForId } from '../../automation-identity.js';
import { cronNextRuns } from '../../cron.js';
import type {
  AuEditorConnectorsDTO,
  AuEditorTriggerInput,
  AutomationEditorBridgeProps,
  AutomationEditorData,
  GrantDTO,
} from '../screen-contracts.js';
import { Button, Icon, IconButton } from '../ui/index.js';
import { cx } from '../ui/cx.js';
import au from '../styles/automation.module.css';
import styles from './AutomationEditorScreen.module.css';

// Automation editor — the instructions-first create/edit form (Automations
// UI revamp, see receipts/issue-387-automations-ui-revamp.md). Name, Instructions (manifest
// `prompt` — the source of intent the builder compiles), a single-trigger
// picker, and Connectors / Behavior / Notifications tabs.
//
// v1 is deliberately SINGLE-TRIGGER: the manifest (and the older builder
// config UI, BuilderAutomationTriggers.tsx) support multiple triggers per
// automation, but this form always saves exactly one (or none, for a
// manual-only automation) — `AutomationEditorSaveFields.triggers` is a full
// replacement of the automation's trigger list. Loading an automation that
// already has more than one trigger keeps only the first for editing and
// surfaces a banner warning that saving will drop the rest; see this
// screen's test + the Lane B report for the rationale (owner-approved scope
// cut, not an oversight).
//
// The Connectors tab's manifest `requires`/`connector`/`vault`-scope chips
// and the Notifications tab's `onFailure`/`model` lines read
// `AutomationEditorData.connectors`/`onFailure`/`model` (screen-contracts.ts,
// populated by `automationEditorData.ts`'s `deriveConnectors` et al). Those
// fields are optional/additive on the DTO, so a `loadData` implementation
// that hasn't been updated to populate them (or a create-mode load, which
// has nothing compiled yet) degrades to the same explainer/empty-state text
// this screen always showed.

type TriggerKind = 'none' | 'cron' | 'webhook' | 'condition' | 'data';
type TabId = 'connectors' | 'behavior' | 'notifications';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'connectors', label: 'Connectors' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'notifications', label: 'Notifications' },
];

/** Best-effort readable summary of a condition trigger's `where` — a
 *  structured `{column,op,value?}[]` clause list renders compactly (shared
 *  `formatWhereClauses`), a plain string passes through, anything else
 *  falls back to JSON. Mirrors automationsData.ts's private
 *  `formatWhereClause` (not exported) so the read-only v1 summary reads the
 *  same way the thread/view screens do. */
function whereSummary(where: unknown): string {
  if (where === undefined || where === null) return '';
  if (typeof where === 'string') return where;
  const compact = formatWhereClauses(where);
  if (compact !== null) return compact;
  try {
    return JSON.stringify(where);
  } catch {
    return String(where);
  }
}

function autogrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function TriggerCard({
  kind,
  title,
  description,
  icon,
  selected,
  onSelect,
  children,
}: {
  kind: TriggerKind;
  title: string;
  description: string;
  icon: IconName;
  selected: boolean;
  onSelect: (kind: TriggerKind) => void;
  children?: JSX.Element | null;
}): JSX.Element {
  return (
    <div
      className={cx(styles.trigCard, selected && styles.trigCardSelected)}
      data-trigger-kind={selected ? kind : undefined}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={title}
        className={styles.trigHead}
        onClick={() => onSelect(kind)}
      >
        <span className={styles.trigIcon} aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
        <span className={styles.trigBody}>
          <span className={styles.trigTitle}>{title}</span>
          <span className={styles.trigDesc}>{description}</span>
        </span>
      </button>
      {selected && children ? <div className={styles.trigDetail}>{children}</div> : null}
    </div>
  );
}

/** A labeled row of pill chips; renders nothing when `items` is empty so
 *  callers can list every group unconditionally. */
function ChipGroup({
  label,
  items,
  mono,
}: {
  label: string;
  items: string[];
  mono?: boolean;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className={styles.connGroup}>
      <div className={styles.connGroupLbl}>{label}</div>
      <div className={styles.chipRow}>
        {items.map((item) => (
          <span key={item} className={cx(styles.chip, mono && styles.chipMono)}>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function ConnectorsPanel({
  mode,
  connectors,
}: {
  mode: 'create' | 'edit';
  connectors: AuEditorConnectorsDTO | null;
}): JSX.Element {
  if (mode === 'create') {
    return (
      <div className={styles.emptyPanel}>
        <p>Connectors and vault scopes are declared when the plan is compiled.</p>
      </div>
    );
  }
  const c = connectors;
  const hasAny =
    !!c &&
    (c.mcps.length > 0 ||
      c.tools.length > 0 ||
      c.secrets.length > 0 ||
      c.connector !== null ||
      c.vaultScopes.length > 0);
  if (!c || !hasAny) {
    return (
      <div className={styles.emptyPanel}>
        <p>Nothing declared yet — the compiled plan declares what it needs.</p>
      </div>
    );
  }
  return (
    <div className={styles.connectorsPanel}>
      <ChipGroup label="Connector" items={c.connector ? [c.connector] : []} />
      <ChipGroup label="MCPs" items={c.mcps} mono />
      <ChipGroup label="Tools" items={c.tools} mono />
      <ChipGroup label="Secrets" items={c.secrets} mono />
      {c.vaultScopes.length > 0 ? (
        <div className={styles.connGroup}>
          <div className={styles.connGroupLbl}>Vault access</div>
          {c.vaultPurpose ? <p className={styles.vaultPurpose}>{c.vaultPurpose}</p> : null}
          <div className={styles.chipRow}>
            {c.vaultScopes.map((scope) => (
              <span key={scope} className={cx(styles.chip, styles.chipMono)}>
                {scope}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NotificationsPanel({
  onFailure,
  model,
}: {
  onFailure: string | null;
  model: string | null;
}): JSX.Element {
  return (
    <div className={styles.notifPanel}>
      <p className={styles.notifLine}>
        {onFailure ? (
          <>
            On failure, runs <code>{onFailure}</code>
          </>
        ) : (
          'Failed runs surface on Home under needs attention.'
        )}
      </p>
      {model ? (
        <p className={cx(styles.notifLine, styles.notifMeta)}>
          Plan runs on <code>{model}</code>
        </p>
      ) : null}
    </div>
  );
}

function GrantRow({
  grant,
  onRevoke,
}: {
  grant: GrantDTO;
  onRevoke: (id: string) => void;
}): JSX.Element {
  const revoked = grant.revokedAt !== null;
  return (
    <div className={cx(styles.grantRow, revoked && styles.grantRowRevoked)}>
      <code className={styles.grantVerb}>{grant.verb}</code>
      <span className={styles.grantTarget}>{grant.target}</span>
      {revoked ? (
        <span className={styles.grantRevoked}>Revoked</span>
      ) : (
        <button
          type="button"
          className={styles.grantRevokeBtn}
          onClick={() => onRevoke(grant.grantId)}
        >
          Revoke
        </button>
      )}
    </div>
  );
}

function BehaviorPanel({
  mode,
  enabled,
  busy,
  onToggle,
  grants,
  onRevokeGrant,
}: {
  mode: 'create' | 'edit';
  enabled: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
  grants: GrantDTO[];
  onRevokeGrant: (id: string) => void;
}): JSX.Element {
  return (
    <div className={styles.behaviorPanel}>
      {mode === 'edit' ? (
        <div className={styles.enableRow}>
          <div>
            <div className={styles.enableLabel}>Enabled</div>
            <div className={styles.enableHint}>
              {enabled ? 'Runs on its trigger.' : "Paused — won't fire until enabled."}
            </div>
          </div>
          <label className={styles.switch} title={enabled ? 'Disable' : 'Enable'}>
            <input
              type="checkbox"
              role="switch"
              aria-checked={enabled}
              aria-label={`${enabled ? 'Disable' : 'Enable'} automation`}
              checked={enabled}
              disabled={busy}
              onChange={(e) => onToggle(e.target.checked)}
            />
            <span className={styles.switchTrack} aria-hidden="true" />
          </label>
        </div>
      ) : null}
      <p className={styles.behaviorExplainer}>
        Writes park for your review unless you mint a standing grant. External sends always stage in
        the outbox.
      </p>
      {mode === 'edit' && grants.length > 0 ? (
        <div className={styles.grants}>
          <div className={styles.grantsLbl}>Standing grants</div>
          {grants.map((g) => (
            <GrantRow key={g.grantId} grant={g} onRevoke={onRevokeGrant} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function AutomationEditorScreen({
  loadData,
  onSave,
  onOpenBuilder,
  onRunNow,
  onToggleEnabled,
  onDecideConsent,
  onCopyWebhook,
  onRotateWebhook,
  onDelete,
  onCancel,
}: AutomationEditorBridgeProps): JSX.Element {
  const [state, setState] = useState<AutomationEditorData | 'loading' | 'error'>('loading');
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [triggerKind, setTriggerKind] = useState<TriggerKind>('none');
  const [cronExpr, setCronExpr] = useState('');
  const [condEntity, setCondEntity] = useState('');
  const [condEvery, setCondEvery] = useState('');
  const [dataEntities, setDataEntities] = useState('');
  const [dataEvery, setDataEvery] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [tab, setTab] = useState<TabId>('connectors');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);
  const [recompileVisible, setRecompileVisible] = useState(false);
  const [multiTrigger, setMultiTrigger] = useState(false);

  const baselineInstructionsRef = useRef('');
  const preservedWhereRef = useRef<unknown>(undefined);
  const instructionsRef = useRef<HTMLTextAreaElement | null>(null);

  // Applies a freshly-loaded DTO to `state` plus, on the initial load
  // (`resetForm: true`), every editable field derived from it. Actions that
  // only need to pick up server-derived data that the form itself never
  // edits — a rotated webhook's URL, a grant's `revokedAt` — pass
  // `resetForm: false` so they don't clobber in-progress edits or the
  // just-earned "Recompile plan" affordance (see `doSave`, which
  // deliberately does NOT reload after a successful save: the local form
  // state is already authoritative for what was just persisted).
  const applyLoaded = useCallback((d: AutomationEditorData, resetForm: boolean): void => {
    setState(d);
    setEnabled(d.enabled);
    if (!resetForm) return;
    setName(d.name);
    setInstructions(d.instructions);
    baselineInstructionsRef.current = d.instructions;
    setRecompileVisible(false);
    setMultiTrigger(d.triggers.length > 1);
    const first = d.triggers[0];
    preservedWhereRef.current = undefined;
    if (!first) {
      setTriggerKind('none');
    } else if (first.kind === 'cron') {
      setTriggerKind('cron');
      setCronExpr(first.expr);
    } else if (first.kind === 'webhook') {
      setTriggerKind('webhook');
    } else if (first.kind === 'condition') {
      setTriggerKind('condition');
      setCondEntity(first.entity);
      setCondEvery(first.every ?? '');
      preservedWhereRef.current = first.where;
    } else {
      setTriggerKind('data');
      setDataEntities(first.entities.join(', '));
      setDataEvery(first.every ?? '');
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      applyLoaded(await loadData(), true);
    } catch {
      setState('error');
    }
  }, [applyLoaded, loadData]);

  /** Re-fetch server-derived data (webhook, consent) without resetting the
   *  fields the owner may be mid-edit on. */
  const refreshConsent = useCallback(async () => {
    try {
      applyLoaded(await loadData(), false);
    } catch {
      // Best-effort background refresh — keep showing the last-known state.
    }
  }, [applyLoaded, loadData]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (instructionsRef.current) autogrow(instructionsRef.current);
  }, [instructions]);

  if (state === 'loading' || state === 'error') {
    return (
      <div className={styles.page}>
        <div className={styles.loadingBody} role="status">
          {state === 'loading' ? 'Loading automation…' : 'Could not load automation.'}
        </div>
      </div>
    );
  }

  const d = state;
  // Identity hue/glyph key on `row.id` — the same field Overview/Thread key
  // on (`automationsData.ts`, `automationThreadData.ts`) — not `automationId`
  // (`row.ref`, a `<ownerApp>/<id>` handle), so the editor's identity matches
  // the rest of the app. `rowId` is optional/additive on the DTO, so a
  // `loadData` that hasn't been updated to populate it falls back to
  // `automationId`.
  const identityId = d.rowId ?? d.automationId ?? 'draft';
  const hue = hueForId(identityId);
  const glyph = glyphForId(identityId);

  function buildTriggers(): AuEditorTriggerInput[] {
    switch (triggerKind) {
      case 'none':
        return [];
      case 'cron':
        return cronExpr.trim() ? [{ expr: cronExpr.trim(), kind: 'cron' }] : [];
      case 'webhook':
        return [{ kind: 'webhook' }];
      case 'condition':
        return condEntity.trim()
          ? [
              {
                entity: condEntity.trim(),
                kind: 'condition',
                ...(condEvery.trim() ? { every: condEvery.trim() } : {}),
                ...(preservedWhereRef.current !== undefined
                  ? { where: preservedWhereRef.current }
                  : {}),
              },
            ]
          : [];
      case 'data': {
        const entities = dataEntities
          .split(',')
          .map((e) => e.trim())
          .filter(Boolean);
        return entities.length
          ? [{ entities, kind: 'data', ...(dataEvery.trim() ? { every: dataEvery.trim() } : {}) }]
          : [];
      }
    }
  }

  const doSave = async (): Promise<void> => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const changed = instructions !== baselineInstructionsRef.current;
    try {
      const ok = await onSave({ instructions, name: name.trim(), triggers: buildTriggers() });
      if (ok) {
        baselineInstructionsRef.current = instructions;
        if (d.mode === 'create') {
          // The compile step: a fresh automation always hands off to the
          // builder chat. Frame the seed as an explicit compile request —
          // raw instructions pasted as chat read as conversation, and the
          // agent sometimes discusses the plan instead of writing the
          // handler. The instructions themselves are already saved as the
          // manifest `prompt`; this message is the work order.
          onOpenBuilder(
            `Compile this automation now: update automation.json and write the real handler.js implementing these instructions, then stop.\n\nInstructions:\n${instructions}`,
          );
        } else if (changed) {
          setRecompileVisible(true);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const doRecompile = (): void => {
    onOpenBuilder(`My instructions changed. Recompile the handler to match:\n\n${instructions}`);
  };

  const doRun = (): void => {
    setRunning(true);
    void onRunNow().then((started) => {
      if (!started) setRunning(false);
    });
  };

  const doDelete = (): void => {
    setDeleting(true);
    void onDelete().then((deleted) => {
      if (!deleted) setDeleting(false);
    });
  };

  const doToggle = (next: boolean): void => {
    setToggleBusy(true);
    setEnabled(next);
    void onToggleEnabled(next)
      .then((ok) => {
        if (!ok) setEnabled(!next);
      })
      .finally(() => setToggleBusy(false));
  };

  const doRegenerate = (): void => {
    setRegenBusy(true);
    void onRotateWebhook()
      .then(() => refreshConsent())
      .finally(() => setRegenBusy(false));
  };

  const doRevokeGrant = (id: string): void => {
    void onDecideConsent('grant', id, 'revoke').then((ok) => {
      if (ok) void refreshConsent();
    });
  };

  const cronPreview = cronExpr.trim() ? cronNextRuns(cronExpr.trim(), 3).map(relativeRunLabel) : [];

  const onInstructionsChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    setInstructions(e.target.value);
    autogrow(e.target);
  };

  return (
    <div className={styles.page}>
      {d.mode === 'edit' ? (
        <div className={styles.head} data-hue={hue}>
          <div className={styles.headIdentity}>
            <span className={au.auGlyph} data-hue={hue} data-size="lg" aria-hidden="true">
              <Icon name={glyph as IconName} size={20} />
            </span>
            <div>
              <div className={styles.headName}>{name || d.name}</div>
              <span className={au.auStatus} data-tone={enabled ? 'active' : 'paused'}>
                <span className={au.auStatusIc} aria-hidden="true">
                  <Icon name={enabled ? 'Power' : 'Pause'} size={11} />
                </span>
                <span>{enabled ? 'Active' : 'Paused'}</span>
              </span>
            </div>
          </div>
          <div className={styles.headActions}>
            <Button
              variant="ghost"
              size="sm"
              icon="Send"
              label="Open builder chat"
              onClick={() => onOpenBuilder()}
            />
            <Button
              variant="soft"
              size="sm"
              icon="Play"
              label={running ? 'Starting…' : 'Run now'}
              disabled={running}
              onClick={doRun}
            />
            <IconButton
              icon="Trash"
              ariaLabel="Delete automation"
              title="Delete automation"
              disabled={deleting}
              onClick={doDelete}
            />
          </div>
        </div>
      ) : null}

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name</span>
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Untitled automation"
          required
        />
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Instructions</span>
        <textarea
          ref={instructionsRef}
          className={styles.textarea}
          rows={8}
          value={instructions}
          onChange={onInstructionsChange}
          placeholder="Describe what this automation should do — the builder compiles it into a deterministic plan."
        />
      </label>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>When should it run?</h2>
        {multiTrigger ? (
          <div className={styles.warnBanner}>
            <Icon name="AlertTriangle" size={13} />
            <span>
              This automation has multiple triggers today. Editing here keeps only the one you
              select below — manage multiple triggers from the builder chat.
            </span>
          </div>
        ) : null}
        <div className={styles.trigGroup} role="radiogroup" aria-label="When should it run?">
          <TriggerCard
            kind="cron"
            title="Schedule"
            description="Runs on a cron expression."
            icon="Clock"
            selected={triggerKind === 'cron'}
            onSelect={setTriggerKind}
          >
            <div className={styles.trigFields}>
              <label className={styles.subField}>
                <span className={styles.subFieldLabel}>Cron expression</span>
                <input
                  className={cx(styles.input, styles.mono)}
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder="0 7 * * *"
                />
              </label>
              {cronPreview.length > 0 ? (
                <div className={styles.cronPreview}>
                  <span className={styles.cronPreviewLbl}>Next runs</span>
                  {cronPreview.map((label, i) => (
                    <span key={i} className={styles.cronPreviewPill}>
                      {label}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </TriggerCard>

          <TriggerCard
            kind="webhook"
            title="Webhook"
            description="An inbound URL is minted when you save; the secret is shown once."
            icon="Webhook"
            selected={triggerKind === 'webhook'}
            onSelect={setTriggerKind}
          >
            <div className={styles.trigFields}>
              {d.webhook && !d.webhook.pending && d.webhook.url ? (
                <div className={styles.webhookRow}>
                  <code className={styles.webhookUrl}>{d.webhook.url}</code>
                  <IconButton
                    icon="Copy"
                    ariaLabel="Copy webhook URL"
                    title="Copy webhook URL"
                    onClick={() => d.webhook?.url && onCopyWebhook(d.webhook.url)}
                  />
                  <button
                    type="button"
                    className={styles.regenBtn}
                    disabled={regenBusy}
                    onClick={doRegenerate}
                  >
                    <Icon name="Refresh" size={12} />
                    <span>{regenBusy ? 'Regenerating…' : 'Regenerate secret'}</span>
                  </button>
                </div>
              ) : d.webhook && d.webhook.pending ? (
                <div className={styles.webhookRow}>
                  <span className={au.auStatusIc} data-spin="true" aria-hidden="true">
                    <Icon name="Loader" size={13} />
                  </span>
                  <span>Provisioning endpoint… secret minted server-side</span>
                </div>
              ) : (
                <p className={styles.trigHint}>
                  An inbound URL is minted when you save; the secret is shown once.
                </p>
              )}
            </div>
          </TriggerCard>

          <TriggerCard
            kind="condition"
            title="Condition"
            description="A consented read gate — fires when your data matches."
            icon="Filter"
            selected={triggerKind === 'condition'}
            onSelect={setTriggerKind}
          >
            <div className={styles.trigFields}>
              <label className={styles.subField}>
                <span className={styles.subFieldLabel}>Entity</span>
                <input
                  className={cx(styles.input, styles.mono)}
                  value={condEntity}
                  onChange={(e) => setCondEntity(e.target.value)}
                  placeholder="core.event"
                />
              </label>
              <label className={styles.subField}>
                <span className={styles.subFieldLabel}>Every</span>
                <input
                  className={cx(styles.input, styles.mono)}
                  value={condEvery}
                  onChange={(e) => setCondEvery(e.target.value)}
                  placeholder="*/5"
                />
              </label>
              {preservedWhereRef.current !== undefined ? (
                <p className={styles.trigHint}>
                  Checks: <code>{whereSummary(preservedWhereRef.current)}</code> — edit filters from
                  the builder chat.
                </p>
              ) : null}
            </div>
          </TriggerCard>

          <TriggerCard
            kind="data"
            title="Data"
            description="Fires on a change feed for the entities you list."
            icon="Folder"
            selected={triggerKind === 'data'}
            onSelect={setTriggerKind}
          >
            <div className={styles.trigFields}>
              <label className={styles.subField}>
                <span className={styles.subFieldLabel}>Entities</span>
                <input
                  className={styles.input}
                  value={dataEntities}
                  onChange={(e) => setDataEntities(e.target.value)}
                  placeholder="core.event, core.content_derivative"
                />
              </label>
              <label className={styles.subField}>
                <span className={styles.subFieldLabel}>Every</span>
                <input
                  className={cx(styles.input, styles.mono)}
                  value={dataEvery}
                  onChange={(e) => setDataEvery(e.target.value)}
                  placeholder="*/5"
                />
              </label>
            </div>
          </TriggerCard>
        </div>
      </section>

      <section className={styles.section}>
        <nav className={styles.tabs} role="tablist" aria-label="Automation details">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={cx(styles.tab, tab === t.id && styles.tabActive)}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className={styles.tabPanel}>
          {tab === 'connectors' ? (
            <ConnectorsPanel mode={d.mode} connectors={d.connectors ?? null} />
          ) : null}
          {tab === 'behavior' ? (
            <BehaviorPanel
              mode={d.mode}
              enabled={enabled}
              busy={toggleBusy}
              onToggle={doToggle}
              grants={d.consent.grants}
              onRevokeGrant={doRevokeGrant}
            />
          ) : null}
          {tab === 'notifications' ? (
            <NotificationsPanel onFailure={d.onFailure ?? null} model={d.model ?? null} />
          ) : null}
        </div>
      </section>

      <div className={styles.footer}>
        <Button variant="ghost" label="Cancel" onClick={onCancel} />
        {recompileVisible ? (
          <Button variant="soft" icon="Send" label="Recompile plan" onClick={doRecompile} />
        ) : null}
        <Button
          variant="primary"
          label={d.mode === 'create' ? 'Create automation' : 'Save changes'}
          disabled={!name.trim() || saving}
          onClick={() => void doSave()}
        />
      </div>
    </div>
  );
}
