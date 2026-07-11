import { type JSX, useEffect, useState } from 'react';
import { cronNextRuns, describeCron } from '../../../../cron.js';
import {
  listAutomationRuns,
  publish,
  readAutomation,
  writeAppFile,
} from '../../../../gateway-client.js';
import { iconSvg } from '../../iconSvg.js';
import TriggerEditor, {
  formatWhereClauses,
  type EditableTrigger,
} from './BuilderAutomationTriggers.js';
import {
  Glyph,
  fmtNextRun,
  fmtRetention,
  getVaultBlock,
  manifestHasVault,
  relTime,
  runOriginLabel,
} from './BuilderAutomationPaneShared.js';
import styles from './BuilderAutomationPane.module.css';
import { cx } from '../../../ui/cx.js';

// Config view — see BuilderAutomationPane.tsx's file header for the overall
// automation-mode right-pane layout this is one tab of. Split into its own
// file (repo file-size cap) once the trigger add/edit/remove UI (GAP 1) grew
// it past a single-screen read; the Section/triggers/behavior/apps bodies
// below are otherwise the same content the vanilla `renderConfig` drew.
//
// Sections form a 2-column grid at wide widths (BuilderAutomationPane.module.css
// `.config`'s `@media (min-width: 1100px)` rule) — "What it does" and
// "Connected apps" span both columns as the hero/footer; "When it runs"
// pairs with the new "Activity" card, and "Behavior" pairs with "Vault
// access" (full-width on its own when the automation has no vault block).
// Below that width every section stacks in one column, same as before.

const svgCheck11 = iconSvg('Check', 11);
const svgHistory14 = iconSvg('History', 14);
const svgGlobe14 = iconSvg('Globe', 14);
const svgPencil12 = iconSvg('Pencil', 12);
const svgX12 = iconSvg('X', 12);
const svgPlus12 = iconSvg('Plus', 12);
const svgActivity14 = iconSvg('Activity', 14);
const svgKey14 = iconSvg('Key', 14);

type ConfigSectionKey = 'what' | 'when' | 'activity' | 'behavior' | 'vault' | 'apps';

/** Earliest upcoming cron fire across every cron trigger, or null with none. */
function nextCronFire(triggers: CentraidAutomationManifest['triggers']): Date | null {
  const dates = triggers
    .filter((t): t is Extract<typeof t, { kind: 'cron' }> => t.kind === 'cron')
    .flatMap((t) => cronNextRuns(t.expr, 1));
  return dates.length > 0 ? dates.reduce((a, b) => (b < a ? b : a)) : null;
}

/** "When it'll next fire" summary — cron gets an exact time; data/condition/webhook get an honest cadence description instead of a fabricated one. */
function scheduleSummary(triggers: CentraidAutomationManifest['triggers']): string {
  const cronNext = nextCronFire(triggers);
  if (cronNext) return fmtNextRun(cronNext);
  if (triggers.some((t) => t.kind === 'data' || t.kind === 'condition')) {
    const every = triggers.find((t) => t.kind === 'data' || t.kind === 'condition') as
      | { every?: string }
      | undefined;
    return every?.every ? `Checks ${every.every}` : 'Checks continuously';
  }
  if (triggers.some((t) => t.kind === 'webhook')) return 'Waiting for a webhook call';
  return 'Manual only';
}

/** "What happened last" + "when it fires next" — the at-a-glance pairing for "When it runs". */
function ActivityCard({ automationRef, triggers }: {
  automationRef: string;
  triggers: CentraidAutomationManifest['triggers'];
}): JSX.Element {
  const [lastRun, setLastRun] = useState<CentraidAutomationRunRecord[] | null | 'error'>(null);

  useEffect(() => {
    let alive = true;
    setLastRun(null);
    listAutomationRuns({ automationId: automationRef, limit: 1 })
      .then((r) => {
        if (alive) setLastRun(r);
      })
      .catch(() => {
        if (alive) setLastRun('error');
      });
    return () => {
      alive = false;
    };
  }, [automationRef]);

  const last = Array.isArray(lastRun) ? (lastRun[0] ?? null) : null;

  return (
    <div className={styles.activity}>
      <div className={styles.activityRow}>
        <span className={styles.rowLabel}>Next fires</span>
        <span className={styles.rowValue}>{scheduleSummary(triggers)}</span>
      </div>
      <div className={styles.activityRow}>
        <span className={styles.rowLabel}>Last run</span>
        <span className={styles.rowValue}>
          {lastRun === null ? (
            'Loading…'
          ) : lastRun === 'error' ? (
            "Couldn't load"
          ) : !last ? (
            'No runs yet'
          ) : (
            <span className={styles.activityLast}>
              <span className={styles.runDot} data-ok={String(last.ok)} />
              <span>{last.summary || last.error || (last.ok ? 'Completed' : 'Failed')}</span>
              <span className={styles.muted}>
                {`· ${runOriginLabel(last)} · ${relTime(last.startedAt)}`}
              </span>
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/** `automations/<id>/automation.json` — the write path createAutomation/
 *  scaffold.ts both use (packages/automation/src/scaffold/scaffold.ts
 *  `APP_AUTOMATIONS_SUBDIR`/`MANIFEST_FILE`). */
function manifestPath(automationId: string): string {
  return `automations/${automationId}/automation.json`;
}

export default function ConfigView({
  automationRow,
  flashSections,
}: {
  automationRow: CentraidAutomationRow;
  flashSections: ReadonlySet<string>;
}): JSX.Element {
  // The shell (useBuilder.ts) only re-fetches `automationRow` after a chat
  // turn; a save made here needs its own optimistic-then-confirmed state so
  // the pane reflects it immediately without touching that wiring. Reset
  // whenever the prop identity changes (a genuine upstream refresh landed).
  const [manifestOverride, setManifestOverride] = useState<CentraidAutomationManifest | null>(null);
  useEffect(() => setManifestOverride(null), [automationRow]);
  const m = manifestOverride ?? automationRow.manifest;
  const enabled = automationRow.enabled === true;

  const [editing, setEditing] = useState<{ mode: 'add' } | { mode: 'edit'; index: number } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const hasVaultBlock = manifestHasVault(m);
  const webhookTaken = m.triggers.some((t) => t.kind === 'webhook');

  const closeEditor = (): void => {
    setEditing(null);
    setSaveError(null);
  };

  // Persist edits through the same draft-file-write + publish path the
  // builder's chat-driven edits use (gateway-client-editing.ts `writeAppFile`
  // / `publish`) — see BuilderAutomationTriggers.tsx's header comment for why
  // this form validates client-side rather than trusting that route to.
  const persistTriggers = async (
    nextTriggers: CentraidAutomationManifest['triggers'],
  ): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    const nextManifest = { ...m, triggers: nextTriggers } as CentraidAutomationManifest;
    try {
      await writeAppFile({
        id: automationRow.ownerApp,
        path: manifestPath(automationRow.id),
        content: JSON.stringify(nextManifest, null, 2),
      });
      await publish({ id: automationRow.ownerApp });
      const fresh = await readAutomation({ automationId: automationRow.ref });
      setManifestOverride(fresh?.manifest ?? nextManifest);
      setEditing(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTrigger = (trigger: EditableTrigger): void => {
    const nextTriggers =
      editing?.mode === 'edit'
        ? m.triggers.map((t, i) => (i === editing.index ? trigger : t))
        : [...m.triggers, trigger];
    void persistTriggers(nextTriggers);
  };

  const handleRemoveTrigger = (index: number): void => {
    const t = m.triggers[index];
    if (!t || saving) return;
    if (!confirm(`Remove this ${t.kind} trigger?`)) return;
    void persistTriggers(m.triggers.filter((_, i) => i !== index));
  };

  // A titled section that flashes a one-shot diff ribbon when the latest chat
  // turn changed it. The shell owns/clears `flashSections`; we only read it.
  // `full` spans both grid columns at the wide-window breakpoint (see this
  // file's header comment) — a no-op below it, where every section stacks.
  const Section = (
    key: ConfigSectionKey,
    label: string,
    body: JSX.Element,
    full = false,
  ): JSX.Element => {
    const flash = flashSections.has(key);
    return (
      <div
        key={key}
        className={cx(styles.section, flash && styles.sectionFlash, full && styles.sectionFull)}
        data-section={key}
      >
        <div className={styles.sectionLabel}>
          <span>{label}</span>
          {flash ? (
            <span className={styles.diffRibbon}>
              <Glyph svg={svgCheck11} />
              Updated
            </span>
          ) : null}
        </div>
        {body}
      </div>
    );
  };

  // Per-trigger Edit/Remove affordances (GAP 1). Editing a trigger swaps its
  // card for the TriggerEditor form in place; kind is fixed once a trigger
  // exists (there's nothing sane to "convert" a cron trigger into).
  const triggerActions = (i: number, editable: boolean): JSX.Element => (
    <div className={styles.triggerActions}>
      {editable ? (
        <button
          type="button"
          className={styles.triggerActionBtn}
          aria-label="Edit trigger"
          title="Edit trigger"
          disabled={saving || editing !== null}
          onClick={() => setEditing({ mode: 'edit', index: i })}
          dangerouslySetInnerHTML={{ __html: svgPencil12 }}
        />
      ) : null}
      <button
        type="button"
        className={styles.triggerActionBtn}
        aria-label="Remove trigger"
        title="Remove trigger"
        disabled={saving || editing !== null}
        onClick={() => handleRemoveTrigger(i)}
        dangerouslySetInnerHTML={{ __html: svgX12 }}
      />
    </div>
  );

  const triggerCards = m.triggers.map((t, i) => {
    if (editing?.mode === 'edit' && editing.index === i) {
      return (
        <div className={styles.trigger} key={i}>
          <TriggerEditor
            mode="edit"
            initialTrigger={t as EditableTrigger}
            webhookTaken={false}
            hasVaultBlock={hasVaultBlock}
            saving={saving}
            serverError={saveError}
            onCancel={closeEditor}
            onSave={handleSaveTrigger}
          />
        </div>
      );
    }
    if (t.kind === 'cron') {
      const next = cronNextRuns(t.expr, 3);
      return (
        <div className={styles.trigger} key={i}>
          <div className={styles.triggerMain}>
            <Glyph svg={svgHistory14} className={styles.triggerIcon} />
            <span className={styles.triggerDesc}>{describeCron(t.expr)}</span>
            <code className={styles.triggerExpr}>{t.expr}</code>
            {triggerActions(i, true)}
          </div>
          {next.length > 0 ? (
            <div className={styles.nextruns}>
              <span className={styles.muted}>Next: </span>
              {next.map((d, j) => (
                <span className={styles.nextrun} key={j}>
                  {fmtNextRun(d)}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      );
    }
    // Data / condition triggers — journal-feed or vault-read watchers.
    if (t.kind === 'data' || t.kind === 'condition') {
      const desc =
        t.kind === 'data'
          ? `Fires on changes to ${t.entities.join(', ')}`
          : `Fires when ${t.entity} matches its condition`;
      // GAP 2: the `where` clause used to be swallowed entirely — render it
      // readably (monospace, one clause per line) instead of hiding it.
      const whereText = t.kind === 'condition' ? formatWhereClauses(t.where) : null;
      return (
        <div className={styles.trigger} key={i}>
          <div className={styles.triggerMain}>
            <Glyph svg={svgHistory14} className={styles.triggerIcon} />
            <span className={styles.triggerDesc}>{desc}</span>
            {t.every ? <code className={styles.triggerExpr}>{t.every}</code> : null}
            {triggerActions(i, true)}
          </div>
          {whereText ? <pre className={styles.whereBlock}>{whereText}</pre> : null}
        </div>
      );
    }
    // Webhook trigger — provisioned (has a minted route id) or pending.
    const pending = t.id === undefined;
    return (
      <div className={styles.trigger} key={i}>
        <div className={styles.triggerMain}>
          <Glyph svg={svgGlobe14} className={styles.triggerIcon} />
          <span className={styles.triggerDesc}>
            {pending ? 'Webhook trigger — provisioning…' : 'Webhook trigger'}
          </span>
          {pending ? null : <code className={styles.triggerExpr}>{`/${t.id}`}</code>}
          {triggerActions(i, false)}
        </div>
        {pending ? (
          <div className={styles.nextruns}>
            <span className={styles.muted}>A URL + secret are minted server-side.</span>
          </div>
        ) : null}
      </div>
    );
  });

  const addTriggerRow =
    editing?.mode === 'add' ? (
      <div className={styles.trigger}>
        <TriggerEditor
          mode="add"
          webhookTaken={webhookTaken}
          hasVaultBlock={hasVaultBlock}
          saving={saving}
          serverError={saveError}
          onCancel={closeEditor}
          onSave={handleSaveTrigger}
        />
      </div>
    ) : (
      <button
        type="button"
        className={styles.addTriggerBtn}
        disabled={saving || editing !== null}
        onClick={() => setEditing({ mode: 'add' })}
      >
        <Glyph svg={svgPlus12} />
        <span>Add trigger</span>
      </button>
    );

  const triggersBody = (
    <div className={styles.triggers}>
      {m.triggers.length === 0 && !(editing?.mode === 'add') ? (
        <p className={styles.muted}>Manual runs only — no schedule.</p>
      ) : (
        triggerCards
      )}
      {addTriggerRow}
    </div>
  );

  const tools = m.requires.tools ?? [];
  const apps = m.apps ?? [];

  const cfgRow = (label: string, value: string): JSX.Element => (
    <div className={styles.row} key={label}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  );

  const behaviorBody = (
    <div className={styles.rows}>
      {cfgRow('Model', m.requires.model || 'Workspace default')}
      {cfgRow('Run history', fmtRetention(m.history.keep))}
      {m.onFailure ? cfgRow('On failure', `Run "${m.onFailure}"`) : null}
      {tools.length > 0 ? cfgRow('Tools', tools.join(', ')) : null}
    </div>
  );

  const appsBody =
    apps.length > 0 ? (
      <div className={styles.tags}>
        {apps.map((a) => (
          <span className={styles.tag} key={a}>
            {a}
          </span>
        ))}
      </div>
    ) : (
      <p className={styles.muted}>Not linked to any app.</p>
    );

  const vault = getVaultBlock(m);
  const vaultBody = vault ? (
    <div className={styles.vaultBody}>
      {vault.why ? <p className={styles.vaultWhy}>{vault.why}</p> : null}
      <div className={styles.tags}>
        {vault.scopes.map((s, i) => (
          <span className={styles.tag} key={i}>
            {s.table ? `${s.schema}.${s.table}` : s.schema}
            <span className={styles.vaultVerb}>{s.verbs}</span>
          </span>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <div className={styles.config}>
      <div className={styles.configHead}>
        <div className={styles.configTitle}>{m.name || automationRow.id}</div>
        <span className={styles.chip} data-on={String(enabled)}>
          {enabled ? 'Enabled' : 'Draft'}
        </span>
      </div>
      {Section(
        'what',
        'What it does',
        <p className={styles.prompt}>{m.prompt || 'Not described yet.'}</p>,
        true,
      )}
      {Section('when', 'When it runs', triggersBody)}
      {Section(
        'activity',
        'Activity',
        <ActivityCard automationRef={automationRow.ref} triggers={m.triggers} />,
      )}
      {Section('behavior', 'Behavior', behaviorBody, !vault)}
      {vault ? Section('vault', 'Vault access', vaultBody as JSX.Element) : null}
      {Section('apps', 'Connected apps', appsBody, true)}
      <div className={styles.hint}>
        Triggers can be added, edited, and removed above. Everything else here is filled in by the
        chat — describe any other change in the conversation.
      </div>
    </div>
  );
}
