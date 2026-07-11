import { type JSX, useState } from 'react';
import { describeCron } from '../../../../cron.js';
import styles from './BuilderAutomationPane.module.css';
import buttonCss from '../../../ui/Button.module.css';
import { cx } from '../../../ui/cx.js';

// Re-exported so this module's existing importers (BuilderAutomationPane,
// BuilderAutomationConfigView, this file's own tests) keep working — the
// compact `column op value` formatter now lives in app-format.ts, shared
// with the automation view screen's condition-detail rendering
// (automationsData.ts), which used to duplicate it as raw JSON only.
export { formatWhereClauses } from '../../../../app-format.js';

/**
 * Trigger authoring form for the automation builder's Config view ("When it
 * runs" section). Split out of BuilderAutomationPane.tsx to keep that file
 * under the repo's file-size cap.
 *
 * IMPORTANT: the pane persists edits through the generic draft-file route
 * (`PUT /_apps/<id>/files/<path>` + `POST /_apps/<id>/publish` — see
 * gateway-client-editing.ts `writeAppFile`/`publish`). That route does NOT
 * run the automation manifest validator (packages/automation/src/manifest/
 * manifest.ts `validateManifest`) — `publish` only validates `app.json` +
 * lints handler.js for replay-safety (packages/gateway/src/validate-
 * manifest.ts). So a malformed automation.json would write and publish
 * silently, only breaking later at schedule/fire time. This form mirrors
 * the manifest's own trigger rules client-side (cron shape, entity naming,
 * condition ops, the outbox.* guard, the one-webhook-max rule, the
 * vault-required-for-condition/data rule) so bad shapes are refused here
 * instead of shipping quietly.
 */

export type TriggerKind = 'cron' | 'webhook' | 'data' | 'condition';

export interface ConditionWhereClauseLike {
  column: string;
  op: string;
  value?: unknown;
}

export type EditableTrigger =
  | { kind: 'cron'; expr: string }
  | { kind: 'webhook'; pending: true }
  | { kind: 'data'; entities: string[]; every?: string }
  | { kind: 'condition'; entity: string; where?: ConditionWhereClauseLike[]; every?: string };

// Mirrors packages/automation/src/manifest/manifest.ts `CONDITION_OPS` — kept
// in sync by hand since the renderer bundle doesn't pull in the automation
// runtime package (main-process-only dependency today).
export const CONDITION_OPS = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'is-null',
  'not-null',
  'within-days',
  'within-next-days',
] as const;

const ENTITY_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const CRON_FIELD_RE = /^[0-9*,\-/?A-Za-z]+$/;

/** Mirrors manifest.ts `isValidCronExpression`. */
export function isValidCronExpr(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;
  const fields = trimmed.split(/\s+/);
  return fields.length === 5 && fields.every((f) => CRON_FIELD_RE.test(f));
}

/** Mirrors manifest.ts's `<schema>.<table>` entity-name grammar. */
export function isValidEntityName(name: string): boolean {
  return ENTITY_RE.test(name);
}

interface FieldError {
  field: string;
  message: string;
}

function parseEntities(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseWhereInput(text: string): { where?: ConditionWhereClauseLike[] } | FieldError {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      field: 'where',
      message: `must be valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { field: 'where', message: 'must be a JSON array of {column, op, value?} clauses' };
  }
  const clauses: ConditionWhereClauseLike[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const raw = parsed[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { field: 'where', message: `[${i}] must be an object` };
    }
    const c = raw as Record<string, unknown>;
    if (typeof c.column !== 'string' || !c.column) {
      return { field: 'where', message: `[${i}].column must be a non-empty string` };
    }
    if (typeof c.op !== 'string' || !(CONDITION_OPS as readonly string[]).includes(c.op)) {
      return { field: 'where', message: `[${i}].op must be one of ${CONDITION_OPS.join(', ')}` };
    }
    clauses.push({
      column: c.column,
      op: c.op,
      ...(c.value !== undefined ? { value: c.value } : {}),
    });
  }
  return { where: clauses };
}

const KIND_LABEL: Record<TriggerKind, string> = {
  cron: 'Schedule',
  webhook: 'Webhook',
  data: 'Data change',
  condition: 'Condition',
};

export interface TriggerEditorProps {
  mode: 'add' | 'edit';
  initialTrigger?: EditableTrigger;
  /** Another trigger already claims the single webhook slot (manifest allows at most one). */
  webhookTaken: boolean;
  /** Whether the manifest already carries a `vault` access block. */
  hasVaultBlock: boolean;
  saving: boolean;
  serverError: string | null;
  onCancel: () => void;
  onSave: (trigger: EditableTrigger) => void;
}

/** Minimal, honest per-kind trigger form (GAP 1) — raw-ish fields + helper text. */
export default function TriggerEditor(props: TriggerEditorProps): JSX.Element {
  const {
    mode,
    initialTrigger,
    webhookTaken,
    hasVaultBlock,
    saving,
    serverError,
    onCancel,
    onSave,
  } = props;
  const [kind, setKind] = useState<TriggerKind>(initialTrigger?.kind ?? 'cron');
  const [expr, setExpr] = useState(
    initialTrigger?.kind === 'cron' ? initialTrigger.expr : '0 9 * * *',
  );
  const [entitiesText, setEntitiesText] = useState(
    initialTrigger?.kind === 'data' ? initialTrigger.entities.join(', ') : '',
  );
  const [entity, setEntity] = useState(
    initialTrigger?.kind === 'condition' ? initialTrigger.entity : '',
  );
  const [whereText, setWhereText] = useState(
    initialTrigger?.kind === 'condition' && initialTrigger.where
      ? JSON.stringify(initialTrigger.where, null, 2)
      : '',
  );
  const [every, setEvery] = useState(
    initialTrigger?.kind === 'data' || initialTrigger?.kind === 'condition'
      ? (initialTrigger.every ?? '')
      : '',
  );
  const [fieldError, setFieldError] = useState<FieldError | null>(null);

  const vaultBlocked =
    mode === 'add' && (kind === 'data' || kind === 'condition') && !hasVaultBlock;

  const attemptSave = (): void => {
    setFieldError(null);
    if (kind === 'cron') {
      if (!isValidCronExpr(expr)) {
        setFieldError({
          field: 'expr',
          message: 'must be a 5-field cron expression, e.g. "0 9 * * *".',
        });
        return;
      }
      onSave({ kind: 'cron', expr: expr.trim() });
      return;
    }
    if (kind === 'webhook') {
      onSave({ kind: 'webhook', pending: true });
      return;
    }
    if (kind === 'data') {
      const entities = parseEntities(entitiesText);
      if (entities.length === 0) {
        setFieldError({ field: 'entities', message: 'list at least one <schema>.<table> entity.' });
        return;
      }
      const bad = entities.find((e) => !isValidEntityName(e));
      if (bad) {
        setFieldError({
          field: 'entities',
          message: `"${bad}" is not a <schema>.<table> entity name.`,
        });
        return;
      }
      const outboxHit = entities.find((e) => e.startsWith('outbox.'));
      if (outboxHit) {
        setFieldError({
          field: 'entities',
          message: `"${outboxHit}" — outbox.* is excluded from data triggers (a drain's own receipts would re-fire it).`,
        });
        return;
      }
      if (every.trim() && !isValidCronExpr(every)) {
        setFieldError({ field: 'every', message: 'must be a 5-field cron expression.' });
        return;
      }
      onSave({ kind: 'data', entities, ...(every.trim() ? { every: every.trim() } : {}) });
      return;
    }
    // condition
    if (!isValidEntityName(entity.trim())) {
      setFieldError({
        field: 'entity',
        message: 'must be a <schema>.<table> entity name, e.g. "business.invoice".',
      });
      return;
    }
    const parsedWhere = parseWhereInput(whereText);
    if ('field' in parsedWhere) {
      setFieldError(parsedWhere);
      return;
    }
    if (every.trim() && !isValidCronExpr(every)) {
      setFieldError({ field: 'every', message: 'must be a 5-field cron expression.' });
      return;
    }
    onSave({
      kind: 'condition',
      entity: entity.trim(),
      ...(parsedWhere.where ? { where: parsedWhere.where } : {}),
      ...(every.trim() ? { every: every.trim() } : {}),
    });
  };

  return (
    <div className={styles.triggerForm}>
      {mode === 'add' ? (
        <div className={styles.triggerKindPicker} role="tablist" aria-label="Trigger kind">
          {(['cron', 'webhook', 'data', 'condition'] as const).map((k) => {
            const disabled =
              (k === 'webhook' && webhookTaken) ||
              ((k === 'data' || k === 'condition') && !hasVaultBlock);
            const title =
              k === 'webhook' && webhookTaken
                ? 'Only one webhook trigger is allowed per automation'
                : (k === 'data' || k === 'condition') && !hasVaultBlock
                  ? 'Needs a manifest.vault access block — describe the access in the chat first'
                  : undefined;
            return (
              <button
                key={k}
                type="button"
                className={styles.triggerKindBtn}
                data-active={String(kind === k)}
                disabled={disabled}
                title={title}
                onClick={() => {
                  setKind(k);
                  setFieldError(null);
                }}
              >
                {KIND_LABEL[k]}
              </button>
            );
          })}
        </div>
      ) : null}

      {kind === 'cron' ? (
        <div className={styles.formRow}>
          <label className={styles.formLabel} htmlFor="trig-expr">
            Cron expression
          </label>
          <input
            id="trig-expr"
            className={styles.formInput}
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            placeholder="0 9 * * *"
            spellCheck={false}
          />
          <p className={styles.formHint}>
            {isValidCronExpr(expr)
              ? describeCron(expr)
              : 'Five space-separated fields: minute hour day month weekday.'}
          </p>
        </div>
      ) : null}

      {kind === 'webhook' ? (
        <p className={styles.formHint}>
          A URL and shared secret are minted server-side once this is saved and published — they'll
          be shown once, right here in the pane.
        </p>
      ) : null}

      {kind === 'data' ? (
        <>
          <div className={styles.formRow}>
            <label className={styles.formLabel} htmlFor="trig-entities">
              Entities
            </label>
            <input
              id="trig-entities"
              className={styles.formInput}
              value={entitiesText}
              onChange={(e) => setEntitiesText(e.target.value)}
              placeholder="core.transaction, billing.invoice"
              spellCheck={false}
            />
            <p className={styles.formHint}>
              Comma-separated &lt;schema&gt;.&lt;table&gt; names to watch for changes.
            </p>
          </div>
          <div className={styles.formRow}>
            <label className={styles.formLabel} htmlFor="trig-data-every">
              Poll every (optional)
            </label>
            <input
              id="trig-data-every"
              className={styles.formInput}
              value={every}
              onChange={(e) => setEvery(e.target.value)}
              placeholder="* * * * *"
              spellCheck={false}
            />
            <p className={styles.formHint}>5-field cron gate. Defaults to every minute.</p>
          </div>
        </>
      ) : null}

      {kind === 'condition' ? (
        <>
          <div className={styles.formRow}>
            <label className={styles.formLabel} htmlFor="trig-entity">
              Entity
            </label>
            <input
              id="trig-entity"
              className={styles.formInput}
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              placeholder="business.invoice"
              spellCheck={false}
            />
          </div>
          <div className={styles.formRow}>
            <label className={styles.formLabel} htmlFor="trig-where">
              Where (optional)
            </label>
            <textarea
              id="trig-where"
              className={cx(styles.formInput, styles.formTextarea)}
              value={whereText}
              onChange={(e) => setWhereText(e.target.value)}
              placeholder={'[{"column":"status","op":"eq","value":"open"}]'}
              spellCheck={false}
              rows={3}
            />
            <p className={styles.formHint}>
              JSON array of clauses, ANDed. Ops: {CONDITION_OPS.join(', ')}.
            </p>
          </div>
          <div className={styles.formRow}>
            <label className={styles.formLabel} htmlFor="trig-cond-every">
              Evaluate every (optional)
            </label>
            <input
              id="trig-cond-every"
              className={styles.formInput}
              value={every}
              onChange={(e) => setEvery(e.target.value)}
              placeholder="*/5 * * * *"
              spellCheck={false}
            />
            <p className={styles.formHint}>5-field cron gate. Defaults to every 5 minutes.</p>
          </div>
        </>
      ) : null}

      {vaultBlocked ? (
        <p className={styles.formError}>
          This automation has no vault access block yet — a data/condition trigger reads the vault
          under a manifest.vault grant the owner approves. Describe the access it needs in the chat,
          then come back to add this trigger.
        </p>
      ) : null}
      {fieldError ? (
        <p className={styles.formError}>
          {fieldError.field} {fieldError.message}
        </p>
      ) : null}
      {serverError ? <p className={styles.formError}>{serverError}</p> : null}

      <div className={styles.formActions}>
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.ghost, buttonCss.sm)}
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
          onClick={attemptSave}
          disabled={saving || vaultBlocked}
        >
          {saving ? 'Saving…' : 'Save trigger'}
        </button>
      </div>
    </div>
  );
}
