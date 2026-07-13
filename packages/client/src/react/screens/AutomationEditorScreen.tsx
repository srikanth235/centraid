// governance: allow-repo-hygiene file-size-limit (#325) single cohesive screen component (Name/Instructions/trigger-picker/tabs form for one surface); splitting would fragment one visual unit
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type JSX } from 'react';
import type { IconName } from '@centraid/design-tokens';
import { relativeRunLabel } from '../../app-format.js';
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
// `prompt` — the source of intent the compiler compiles), a multi-trigger
// editor, and Connectors / Behavior / Notifications tabs.
//
// The Connectors tab's manifest `requires`/`connector`/`vault`-scope chips
// and the Notifications tab's `onFailure`/`model` lines read
// `AutomationEditorData.connectors`/`onFailure`/`model` (screen-contracts.ts,
// populated by `automationEditorData.ts`'s `deriveConnectors` et al). Those
// fields are optional/additive on the DTO, so a `loadData` implementation
// that hasn't been updated to populate them (or a create-mode load, which
// has nothing compiled yet) degrades to the same explainer/empty-state text
// this screen always showed.

type TriggerKind = 'cron' | 'webhook' | 'condition' | 'data';
type TriggerDraft = {
  key: string;
  kind: TriggerKind;
  expr: string;
  entity: string;
  where: string;
  every: string;
  entities: string;
};
type TabId = 'connectors' | 'behavior' | 'notifications';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'connectors', label: 'Connectors' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'notifications', label: 'Notifications' },
];

let triggerKey = 0;
function draftTrigger(kind: TriggerKind): TriggerDraft {
  return {
    key: `trigger-${triggerKey++}`,
    kind,
    expr: kind === 'cron' ? '0 9 * * *' : '',
    entity: '',
    where: '',
    every: '',
    entities: '',
  };
}

function loadedTrigger(t: AutomationEditorData['triggers'][number]): TriggerDraft {
  const draft = draftTrigger(t.kind);
  if (t.kind === 'cron') draft.expr = t.expr;
  if (t.kind === 'condition') {
    draft.entity = t.entity;
    draft.every = t.every ?? '';
    draft.where = t.where === undefined ? '' : JSON.stringify(t.where);
  }
  if (t.kind === 'data') {
    draft.entities = t.entities.join(', ');
    draft.every = t.every ?? '';
  }
  return draft;
}

function autogrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
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
  onCompile,
  onSearchEntities,
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
  const [triggers, setTriggers] = useState<TriggerDraft[]>([]);
  const [whereError, setWhereError] = useState<string | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionHits, setMentionHits] = useState<
    Array<{ type: string; id: string; title: string | null; subtitle: string | null }>
  >([]);
  const [enabled, setEnabled] = useState(false);
  const [tab, setTab] = useState<TabId>('connectors');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);

  const baselineInstructionsRef = useRef('');
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
    setTriggers(d.triggers.map(loadedTrigger));
    setWhereError(null);
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

  useEffect(() => {
    if (!mention || mention.query.length < 1) {
      setMentionHits([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void onSearchEntities(mention.query)
        .then((hits) => {
          if (active) setMentionHits(hits);
        })
        .catch(() => {
          if (active) setMentionHits([]);
        });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [mention, onSearchEntities]);

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
    setWhereError(null);
    return triggers.flatMap((trigger): AuEditorTriggerInput[] => {
      if (trigger.kind === 'cron') {
        return trigger.expr.trim() ? [{ expr: trigger.expr.trim(), kind: 'cron' }] : [];
      }
      if (trigger.kind === 'webhook') return [{ kind: 'webhook' }];
      if (trigger.kind === 'data') {
        const entities = trigger.entities
          .split(',')
          .map((e) => e.trim())
          .filter(Boolean);
        return entities.length
          ? [
              {
                entities,
                kind: 'data',
                ...(trigger.every.trim() ? { every: trigger.every.trim() } : {}),
              },
            ]
          : [];
      }
      if (!trigger.entity.trim()) return [];
      let where: unknown = undefined;
      if (trigger.where.trim()) {
        try {
          where = JSON.parse(trigger.where);
          if (!Array.isArray(where)) throw new Error('must be a JSON array');
        } catch (error) {
          const message = error instanceof Error ? error.message : 'invalid JSON';
          setWhereError(`Condition filters ${message}.`);
          throw new Error(`Condition filters ${message}.`, { cause: error });
        }
      }
      return [
        {
          entity: trigger.entity.trim(),
          kind: 'condition',
          ...(trigger.every.trim() ? { every: trigger.every.trim() } : {}),
          ...(where !== undefined ? { where } : {}),
        },
      ];
    });
  }

  const doSave = async (): Promise<void> => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const changed = instructions !== baselineInstructionsRef.current;
    try {
      const builtTriggers = buildTriggers();
      const ok = await onSave({ instructions, name: name.trim(), triggers: builtTriggers });
      if (ok) {
        baselineInstructionsRef.current = instructions;
        if (d.mode === 'create' || changed) await onCompile(d.mode === 'create');
      }
    } catch {
      // Validation errors are rendered next to their field.
    } finally {
      setSaving(false);
    }
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

  const onInstructionsChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    setInstructions(e.target.value);
    autogrow(e.target);
    const cursor = e.target.selectionStart;
    const before = e.target.value.slice(0, cursor);
    const match = /(?:^|\s)@([^\s@\]]*)$/.exec(before);
    setMention(match ? { start: cursor - match[1]!.length - 1, query: match[1]! } : null);
  };

  const insertMention = (hit: { type: string; id: string }): void => {
    if (!mention) return;
    const cursor = instructionsRef.current?.selectionStart ?? instructions.length;
    const token = `@[${hit.type}/${hit.id}]`;
    const next = `${instructions.slice(0, mention.start)}${token}${instructions.slice(cursor)}`;
    setInstructions(next);
    setMention(null);
    setMentionHits([]);
    requestAnimationFrame(() => {
      const pos = mention.start + token.length;
      instructionsRef.current?.focus();
      instructionsRef.current?.setSelectionRange(pos, pos);
    });
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

      <label className={cx(styles.field, styles.instructionsField)}>
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
          placeholder="Describe the outcome, data, and actions this automation should handle. Type @ to tag vault data."
        />
        {Array.from(instructions.matchAll(/@\[([^/\]]+)\/([^\]]+)\]/g)).length > 0 ? (
          <div className={styles.entityTokens} aria-label="Tagged data">
            {Array.from(instructions.matchAll(/@\[([^/\]]+)\/([^\]]+)\]/g), (match) => (
              <span key={match[0]} className={styles.entityToken}>
                <code>@{match[1]}</code>
                <span>{match[2]}</span>
              </span>
            ))}
          </div>
        ) : null}
        {mention && mentionHits.length > 0 ? (
          <div className={styles.mentionPopover} role="listbox" aria-label="Tag vault data">
            {mentionHits.map((hit) => (
              <button
                key={`${hit.type}/${hit.id}`}
                type="button"
                role="option"
                aria-selected="false"
                className={styles.mentionOption}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMention(hit)}
              >
                <span>{hit.title ?? hit.id}</span>
                <code>{hit.type}</code>
              </button>
            ))}
          </div>
        ) : null}
      </label>

      <section className={styles.section}>
        <div className={styles.sectionHeading}>
          <div>
            <h2 className={styles.sectionTitle}>Triggers</h2>
            <p className={styles.sectionHint}>Any trigger can start this automation.</p>
          </div>
          <div className={styles.addTrigger} aria-label="Add trigger">
            {(['cron', 'condition', 'data', 'webhook'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                disabled={
                  kind === 'webhook' && triggers.some((trigger) => trigger.kind === 'webhook')
                }
                onClick={() => setTriggers((current) => [...current, draftTrigger(kind)])}
              >
                + {kind === 'cron' ? 'Schedule' : kind[0]?.toUpperCase() + kind.slice(1)}
              </button>
            ))}
          </div>
        </div>
        {triggers.length === 0 ? (
          <p className={styles.triggerEmpty}>Manual only — add a trigger to run automatically.</p>
        ) : null}
        <div className={styles.triggerList}>
          {triggers.map((trigger, index) => {
            const update = (patch: Partial<TriggerDraft>): void =>
              setTriggers((current) =>
                current.map((item) => (item.key === trigger.key ? { ...item, ...patch } : item)),
              );
            const preview =
              trigger.kind === 'cron' && trigger.expr.trim()
                ? cronNextRuns(trigger.expr.trim(), 3).map(relativeRunLabel)
                : [];
            return (
              <div key={trigger.key} className={styles.triggerRow} data-trigger-kind={trigger.kind}>
                <div className={styles.triggerRowHead}>
                  <span className={styles.triggerIndex}>{String(index + 1).padStart(2, '0')}</span>
                  <select
                    className={styles.triggerSelect}
                    value={trigger.kind}
                    onChange={(event) => {
                      const kind = event.target.value as TriggerKind;
                      if (kind === 'webhook' && triggers.some((item) => item.kind === 'webhook'))
                        return;
                      update({ ...draftTrigger(kind), key: trigger.key });
                    }}
                  >
                    <option value="cron">Schedule</option>
                    <option value="condition">Condition</option>
                    <option value="data">Data change</option>
                    <option
                      value="webhook"
                      disabled={triggers.some(
                        (item) => item.kind === 'webhook' && item.key !== trigger.key,
                      )}
                    >
                      Webhook
                    </option>
                  </select>
                  <IconButton
                    icon="Trash"
                    ariaLabel={`Remove trigger ${index + 1}`}
                    title="Remove trigger"
                    onClick={() =>
                      setTriggers((current) => current.filter((item) => item.key !== trigger.key))
                    }
                  />
                </div>
                {trigger.kind === 'cron' ? (
                  <div className={styles.trigFields}>
                    <label className={styles.subField}>
                      <span className={styles.subFieldLabel}>Cron expression</span>
                      <input
                        className={cx(styles.input, styles.mono)}
                        value={trigger.expr}
                        onChange={(event) => update({ expr: event.target.value })}
                        placeholder="0 7 * * *"
                      />
                    </label>
                    {preview.length > 0 ? (
                      <div className={styles.cronPreview}>
                        <span className={styles.cronPreviewLbl}>Next</span>
                        {preview.map((label) => (
                          <span key={label} className={styles.cronPreviewPill}>
                            {label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {trigger.kind === 'condition' ? (
                  <div className={styles.trigFields}>
                    <label className={styles.subField}>
                      <span className={styles.subFieldLabel}>Entity</span>
                      <input
                        className={cx(styles.input, styles.mono)}
                        value={trigger.entity}
                        onChange={(event) => update({ entity: event.target.value })}
                        placeholder="core.event"
                      />
                    </label>
                    <label className={styles.subField}>
                      <span className={styles.subFieldLabel}>Where (JSON array)</span>
                      <input
                        className={cx(styles.input, styles.mono)}
                        value={trigger.where}
                        onChange={(event) => {
                          setWhereError(null);
                          update({ where: event.target.value });
                        }}
                        placeholder='[{"column":"status","op":"eq","value":"open"}]'
                        aria-invalid={whereError !== null}
                      />
                    </label>
                    <label className={styles.subField}>
                      <span className={styles.subFieldLabel}>Every</span>
                      <input
                        className={cx(styles.input, styles.mono)}
                        value={trigger.every}
                        onChange={(event) => update({ every: event.target.value })}
                        placeholder="*/5 * * * *"
                      />
                    </label>
                  </div>
                ) : null}
                {trigger.kind === 'data' ? (
                  <div className={styles.trigFields}>
                    <label className={styles.subField}>
                      <span className={styles.subFieldLabel}>Entities</span>
                      <input
                        className={styles.input}
                        value={trigger.entities}
                        onChange={(event) => update({ entities: event.target.value })}
                        placeholder="core.event, core.content_derivative"
                      />
                    </label>
                    <label className={styles.subField}>
                      <span className={styles.subFieldLabel}>Every</span>
                      <input
                        className={cx(styles.input, styles.mono)}
                        value={trigger.every}
                        onChange={(event) => update({ every: event.target.value })}
                        placeholder="*/5 * * * *"
                      />
                    </label>
                  </div>
                ) : null}
                {trigger.kind === 'webhook' ? (
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
                    ) : (
                      <p className={styles.trigHint}>
                        The endpoint and one-time secret are minted when you save.
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {whereError ? (
          <p className={styles.fieldError} role="alert">
            {whereError}
          </p>
        ) : null}
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
