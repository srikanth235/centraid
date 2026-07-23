// governance: allow-repo-hygiene file-size-limit (#325) single cohesive screen component (Name/Instructions/trigger-picker/tabs form for one surface); splitting would fragment one visual unit
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type JSX } from 'react';
import type { IconName } from '@centraid/design-tokens';
import { relativeRunLabel } from '../../app-format.js';
import { glyphForId, hueForId } from '../../automation-identity.js';
import { cronNextRuns } from '../../cron.js';
import type {
  AuEditorCatalogConnectorDTO,
  AuEditorTriggerInput,
  AutomationEditorBridgeProps,
  AutomationEditorData,
} from '../screen-contracts.js';
import { Button, Icon, IconButton } from '../ui/index.js';
import { cx } from '../ui/cx.js';
import au from '../styles/automation.module.css';
import inlineEmptyCss from '../styles/inlineEmpty.module.css';
import { AutomationEditorConnectorsPicker } from './AutomationEditorConnectorsPicker.js';
import styles from './AutomationEditorScreen.module.css';

// Automation editor — shared create/edit form (Automations UI revamp, see
// receipts/issue-387-automations-ui-revamp.md). Name, Instructions (manifest
// `prompt` — the source of intent the compiler compiles) with a Connectors
// catalog picker on the toolbar, Schedule/Data triggers only, and
// Notifications / Plan tabs. Connector OAuth + API-key attach reuses the
// same gateway flows as Settings → Connectors.

type TriggerKind = 'cron' | 'webhook' | 'condition' | 'data';
/** One row of a condition trigger's `where` builder. `value` is the raw text
 *  the user typed; it is coerced per-op into the manifest clause shape at save
 *  time (see `whereClauseOf`). */
type WhereRowDraft = { column: string; op: ConditionOp; value: string };
type TriggerDraft = {
  key: string;
  kind: TriggerKind;
  expr: string;
  entity: string;
  whereRows: WhereRowDraft[];
  every: string;
  entities: string;
};
type TabId = 'notifications' | 'plan';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'notifications', label: 'Notifications' },
  { id: 'plan', label: 'Plan' },
];

// Mirrors packages/automation/src/manifest/manifest.ts `CONDITION_OPS` — kept
// in sync by hand since the renderer bundle doesn't pull in the automation
// runtime package (main-process-only dependency today), same as
// BuilderAutomationTriggers.tsx.
const CONDITION_OPS = [
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
type ConditionOp = (typeof CONDITION_OPS)[number];
/** Kinds the owner can add from the create/edit form. Webhook + condition
 *  remain editable when already present on a loaded automation, but new
 *  authoring matches the Grok-style surface: schedule (cron) and vault data
 *  changes only. */
const ADDABLE_TRIGGER_KINDS = ['cron', 'data'] as const satisfies readonly TriggerKind[];
const TRIGGER_ADD_LABEL: Record<(typeof ADDABLE_TRIGGER_KINDS)[number], string> = {
  cron: 'Schedule',
  data: 'Data change',
};
const TRIGGER_KIND_LABEL: Record<TriggerKind, string> = {
  cron: 'Schedule',
  webhook: 'Webhook',
  data: 'Data change',
  condition: 'Condition',
};
/** Run-outcome notifications. Centraid surfaces failures on Home under needs
 *  attention today — only App / Off are real. (Email options were removed so
 *  the control doesn't promise a channel that isn't wired yet.) */
type NotifyMode = 'app' | 'off';
const NOTIFY_OPTIONS: readonly { id: NotifyMode; label: string }[] = [
  { id: 'app', label: 'In the app' },
  { id: 'off', label: 'Off' },
];
/** Ops that take no `value` (unary null checks). */
const NO_VALUE_OPS: ReadonlySet<string> = new Set(['is-null', 'not-null']);
/** Ops whose value is a comma-separated list. */
const LIST_OPS: ReadonlySet<string> = new Set(['in']);
/** Ops whose value is a bare day count (a number). */
const NUMERIC_OPS: ReadonlySet<string> = new Set(['within-days', 'within-next-days']);

/** Turn a clean numeric string into a number; leave everything else a string
 *  (so `eq status open` stays `"open"`, `eq amount 100` becomes `100`). */
function coerceScalar(raw: string): string | number {
  const t = raw.trim();
  return t !== '' && /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : t;
}

/** A DTO where clause (value is `unknown` on the wire) → an editable row. */
function whereRowOf(raw: unknown): WhereRowDraft {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const op = (CONDITION_OPS as readonly string[]).includes(c.op as string)
    ? (c.op as ConditionOp)
    : 'eq';
  let value = '';
  if (!NO_VALUE_OPS.has(op) && c.value !== undefined && c.value !== null) {
    value = Array.isArray(c.value) ? c.value.map(String).join(', ') : String(c.value);
  }
  return { column: typeof c.column === 'string' ? c.column : '', op, value };
}

/** An editable row → a manifest where clause, coerced per-op. Drops the row
 *  (returns null) when it has no column. */
function whereClauseOf(row: WhereRowDraft): { column: string; op: string; value?: unknown } | null {
  const column = row.column.trim();
  if (!column) return null;
  if (NO_VALUE_OPS.has(row.op)) return { column, op: row.op };
  if (LIST_OPS.has(row.op)) {
    const list = row.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(coerceScalar);
    return { column, op: row.op, value: list };
  }
  if (NUMERIC_OPS.has(row.op)) {
    const t = row.value.trim();
    const n = Number(t);
    return { column, op: row.op, value: t !== '' && Number.isFinite(n) ? n : t };
  }
  return { column, op: row.op, value: coerceScalar(row.value) };
}

let triggerKey = 0;
function draftTrigger(kind: TriggerKind): TriggerDraft {
  return {
    key: `trigger-${triggerKey++}`,
    kind,
    expr: kind === 'cron' ? '0 9 * * *' : '',
    entity: '',
    whereRows: [],
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
    draft.whereRows = Array.isArray(t.where) ? t.where.map(whereRowOf) : [];
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

/** Inline entity-KIND picker for the data/condition trigger inputs — the same
 *  at-token idiom as the Instructions at-mention (`.mentionPopover` /
 *  `.mentionOption` surface), applied to the trigger entity fields. It offers
 *  canonical entity TYPES (e.g. `core.transaction`) from the lazily-loaded
 *  `list`, filtered client-side and capped at eight; it never offers row
 *  instances (those live in the at-mention search, not here). Keyboard-navigable
 *  — ArrowUp/ArrowDown move, Enter accepts, Escape dismisses — and click to
 *  accept. When `segmented`, the value is a comma-separated list and only the
 *  trailing segment (after the last comma) is matched and completed, leaving
 *  the earlier entities intact. */
function EntityKindPicker({
  value,
  list,
  segmented = false,
  placeholder,
  onChange,
}: {
  value: string;
  list: string[];
  segmented?: boolean;
  placeholder: string;
  onChange: (next: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // For a comma-separated value everything up to and including the last comma
  // is a fixed prefix; the trailing segment is what we match and complete.
  const lastComma = segmented ? value.lastIndexOf(',') : -1;
  const prefix = value.slice(0, lastComma + 1);
  const query = value
    .slice(lastComma + 1)
    .trim()
    .toLowerCase();
  const matches = (query ? list.filter((k) => k.toLowerCase().includes(query)) : list).slice(0, 8);
  const activeIndex = matches.length ? Math.min(active, matches.length - 1) : 0;
  const showList = open && matches.length > 0;

  const accept = (kind: string): void => {
    onChange(segmented ? `${prefix}${prefix ? ' ' : ''}${kind}` : kind);
    setOpen(false);
    setActive(0);
  };

  return (
    <div className={styles.pickerAnchor}>
      <input
        className={cx(styles.input, styles.mono)}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (!showList) {
            if (event.key === 'ArrowDown') {
              setOpen(true);
              event.preventDefault();
            }
            return;
          }
          if (event.key === 'ArrowDown') {
            setActive((activeIndex + 1) % matches.length);
            event.preventDefault();
          } else if (event.key === 'ArrowUp') {
            setActive((activeIndex - 1 + matches.length) % matches.length);
            event.preventDefault();
          } else if (event.key === 'Enter') {
            accept(matches[activeIndex]!);
            event.preventDefault();
          } else if (event.key === 'Escape') {
            setOpen(false);
            event.stopPropagation();
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      {showList ? (
        <div className={styles.mentionPopover} role="listbox" aria-label="Choose entity type">
          {matches.map((kind, i) => (
            <button
              key={kind}
              type="button"
              role="option"
              aria-selected={i === activeIndex ? 'true' : 'false'}
              data-active={String(i === activeIndex)}
              className={styles.mentionOption}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => accept(kind)}
            >
              <span className={styles.pickerKind}>{kind}</span>
              <code>Domain model</code>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function NotificationsPanel({
  onFailure,
  model,
  notifyMode,
  onNotifyMode,
}: {
  onFailure: string | null;
  model: string | null;
  notifyMode: NotifyMode;
  onNotifyMode: (mode: NotifyMode) => void;
}): JSX.Element {
  return (
    <div className={styles.notifPanel}>
      <label className={styles.subField}>
        <span className={styles.microLabel}>Failed runs</span>
        <select
          className={styles.notifySelect}
          value={notifyMode}
          aria-label="Notification preference"
          onChange={(e) => onNotifyMode(e.target.value as NotifyMode)}
        >
          {NOTIFY_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <p className={styles.notifLine}>
        {onFailure ? (
          <>
            On failure, also runs <code>{onFailure}</code>
          </>
        ) : notifyMode === 'off' ? (
          'Failures stay in this automation’s run history only.'
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

// Minimal, dependency-free tokenizer — enough to give the read-only plan
// viewer life without pulling in a highlighter. Anything it doesn't match
// renders as plain text, so mis-tokenizing only ever means "less colour".
const CODE_TOKEN =
  /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(-?\b\d+(?:\.\d+)?\b)|(\b(?:const|let|var|function|return|if|else|for|of|in|await|async|import|export|from|new|class|extends|try|catch|throw|typeof|true|false|null|undefined)\b)/g;

function highlightLine(line: string): (string | JSX.Element)[] {
  const out: (string | JSX.Element)[] = [];
  let last = 0;
  let key = 0;
  for (const m of line.matchAll(CODE_TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(line.slice(last, idx));
    const cls = m[1] ? styles.tkCom : m[2] ? styles.tkStr : m[3] ? styles.tkNum : styles.tkKw;
    out.push(
      <span key={key++} className={cls}>
        {m[0]}
      </span>,
    );
    last = idx + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

function PlanPanel({
  mode,
  source,
  file,
  onFile,
}: {
  mode: 'create' | 'edit';
  source: { manifest: string | null; handler: string | null } | null;
  file: 'handler' | 'manifest';
  onFile: (f: 'handler' | 'manifest') => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  if (mode === 'create') {
    return (
      <div className={inlineEmptyCss.inlineEmpty}>
        <p>
          The compiler turns your instructions into a deterministic plan when you create the
          automation. Its <code>handler.js</code> and <code>automation.json</code> will show here.
        </p>
      </div>
    );
  }
  if (!source) {
    return (
      <div className={inlineEmptyCss.inlineEmpty}>
        <p>Loading compiled plan…</p>
      </div>
    );
  }
  const code = file === 'handler' ? source.handler : source.manifest;
  const lang = file === 'handler' ? 'JavaScript' : 'JSON';
  const copy = (): void => {
    if (!code) return;
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  const lines = (code ?? '').split('\n');
  return (
    <div className={styles.codeViewer}>
      <div className={styles.codeChrome}>
        <div className={styles.codeTabs} role="tablist" aria-label="Compiled files">
          {(['handler', 'manifest'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={file === f}
              className={cx(styles.tab, styles.codeTab)}
              data-active={String(file === f)}
              onClick={() => onFile(f)}
            >
              {f === 'handler' ? 'handler.js' : 'automation.json'}
            </button>
          ))}
        </div>
        <div className={styles.codeMeta}>
          <span className={styles.codeLang}>{lang}</span>
          <button
            type="button"
            className={styles.codeCopy}
            disabled={!code}
            onClick={copy}
            title="Copy to clipboard"
          >
            <Icon name="Copy" size={12} />
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>
      {code ? (
        <div className={styles.codeBody}>
          <pre className={styles.codePre}>
            {lines.map((ln, i) => (
              <div key={i} className={styles.codeLine}>
                <span className={styles.codeGutter} aria-hidden="true">
                  {i + 1}
                </span>
                <code className={styles.codeText}>{ln ? highlightLine(ln) : '\u00A0'}</code>
              </div>
            ))}
          </pre>
        </div>
      ) : (
        <div className={styles.codeEmpty}>
          <p>Not compiled yet — save the automation to compile its plan.</p>
        </div>
      )}
    </div>
  );
}

export default function AutomationEditorScreen({
  loadData,
  onSave,
  onCompile,
  onSearchEntities,
  loadEntityTypes,
  loadConnectorCatalog,
  configureConnection,
  beginAuthorize,
  showToast,
  onReadSource,
  onRunNow,
  onToggleEnabled,
  onCopyWebhook,
  onRotateWebhook,
  onDelete,
  onCancel,
}: AutomationEditorBridgeProps): JSX.Element {
  const [state, setState] = useState<AutomationEditorData | 'loading' | 'error'>('loading');
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [triggers, setTriggers] = useState<TriggerDraft[]>([]);
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionHits, setMentionHits] = useState<
    Array<{ type: string; id: string; title: string | null; subtitle: string | null }>
  >([]);
  const [enabled, setEnabled] = useState(false);
  const [tab, setTab] = useState<TabId>('notifications');
  const [source, setSource] = useState<{ manifest: string | null; handler: string | null } | null>(
    null,
  );
  const [sourceFile, setSourceFile] = useState<'handler' | 'manifest'>('handler');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);
  const [addTriggerOpen, setAddTriggerOpen] = useState(false);
  const [notifyMode, setNotifyMode] = useState<NotifyMode>('app');
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [catalog, setCatalog] = useState<AuEditorCatalogConnectorDTO[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [selectedConnectors, setSelectedConnectors] = useState<Set<string>>(() => new Set());
  /** Durable connection bindings keyed by catalog kind (connection id + label). */
  const [connectionBindings, setConnectionBindings] = useState<
    Map<string, { connectionId: string; kind: string; label: string }>
  >(() => new Map());

  const baselineInstructionsRef = useRef('');
  const instructionsRef = useRef<HTMLTextAreaElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const connectorsWrapRef = useRef<HTMLDivElement | null>(null);

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
    const bound = d.connectors?.connections ?? [];
    setSelectedConnectors(new Set(bound.map((b) => b.kind)));
    setConnectionBindings(
      new Map(
        bound.map((b) => [b.kind, { connectionId: b.connectionId, kind: b.kind, label: b.label }]),
      ),
    );
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

  const didInitialLoad = useRef(false);
  useEffect(() => {
    if (didInitialLoad.current) return;
    didInitialLoad.current = true;
    void reload();
  }, [reload]);

  // Lazily fetch the canonical entity-type list the first time a data/condition
  // trigger is present — feeds the `EntityKindPicker` autocomplete on their
  // entity inputs. The route caches the underlying gateway read, so re-fetches
  // are cheap even if this fires again after a reload.
  const needsEntityTypes = triggers.some((t) => t.kind === 'data' || t.kind === 'condition');
  const entityTypesLoaded = useRef(false);
  useEffect(() => {
    if (!needsEntityTypes || entityTypesLoaded.current || !loadEntityTypes) return;
    entityTypesLoaded.current = true;
    let active = true;
    void loadEntityTypes()
      .then((types) => {
        if (active) setEntityTypes(types);
      })
      .catch(() => {
        if (active) entityTypesLoaded.current = false;
      });
    return () => {
      active = false;
    };
  }, [needsEntityTypes, loadEntityTypes]);

  useEffect(() => {
    if (instructionsRef.current) autogrow(instructionsRef.current);
  }, [instructions]);

  // Lazy-load the compiled plan the first time the Plan tab is opened.
  useEffect(() => {
    if (tab !== 'plan' || source) return;
    let active = true;
    void onReadSource()
      .then((s) => {
        if (active) setSource(s);
      })
      .catch(() => {
        if (active) setSource({ handler: null, manifest: null });
      });
    return () => {
      active = false;
    };
  }, [tab, source, onReadSource]);

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

  const refreshCatalog = useCallback(async (): Promise<void> => {
    if (!loadConnectorCatalog) {
      setCatalog([]);
      return;
    }
    setCatalogLoading(true);
    try {
      const next = await loadConnectorCatalog();
      setCatalog(next);
      // Rehydrate durable bindings for any selected kinds that now have a
      // live vault connection (covers select-then-connect + post-refresh).
      setSelectedConnectors((selected) => {
        setConnectionBindings((prev) => {
          const copy = new Map(prev);
          for (const cat of next) {
            if (!selected.has(cat.kind) || !cat.connection) continue;
            copy.set(cat.kind, {
              connectionId: cat.connection.connectionId,
              kind: cat.kind,
              label: cat.connection.label,
            });
          }
          return copy;
        });
        return selected;
      });
    } catch {
      setCatalog([]);
    } finally {
      setCatalogLoading(false);
    }
  }, [loadConnectorCatalog]);

  // Dismiss the connectors popover on outside click or Escape.
  useEffect(() => {
    if (!connectorsOpen) return;
    const onDoc = (event: MouseEvent): void => {
      const t = event.target as Node | null;
      if (t && connectorsWrapRef.current?.contains(t)) return;
      setConnectorsOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setConnectorsOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [connectorsOpen]);

  // Create mode: land the caret in Name so the first action is obvious.
  const createFocused = useRef(false);
  useEffect(() => {
    if (createFocused.current) return;
    if (typeof state !== 'object' || state.mode !== 'create') return;
    createFocused.current = true;
    const id = window.requestAnimationFrame(() => nameInputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [state]);

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
        // Skip an empty data trigger — same spirit as the cron empty-expr skip.
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
      // condition — skip when no entity is named.
      if (!trigger.entity.trim()) return [];
      const where = trigger.whereRows
        .map(whereClauseOf)
        .filter((c): c is NonNullable<typeof c> => c !== null);
      return [
        {
          entity: trigger.entity.trim(),
          kind: 'condition',
          ...(trigger.every.trim() ? { every: trigger.every.trim() } : {}),
          ...(where.length ? { where } : {}),
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
      const connections = [...connectionBindings.values()].filter((b) =>
        selectedConnectors.has(b.kind),
      );
      const ok = await onSave({
        instructions,
        name: name.trim(),
        triggers: builtTriggers,
        connections,
      });
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

  const openConnectorsPicker = (): void => {
    setConnectorsOpen((open) => {
      const next = !open;
      if (next) void refreshCatalog();
      return next;
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

  const connectorCount = selectedConnectors.size;
  const isCreate = d.mode === 'create';

  const addTriggerMenu = (
    <div className={styles.addTriggerWrap}>
      <button
        type="button"
        className={styles.addTriggerBtn}
        aria-expanded={addTriggerOpen}
        aria-haspopup="menu"
        onClick={() => setAddTriggerOpen((o) => !o)}
      >
        + Add Trigger
      </button>
      {addTriggerOpen ? (
        <div className={styles.addTriggerMenu} role="menu" aria-label="Trigger kinds">
          {ADDABLE_TRIGGER_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className={styles.addTriggerItem}
              onClick={() => {
                setTriggers((current) => [...current, draftTrigger(kind)]);
                setAddTriggerOpen(false);
              }}
            >
              {TRIGGER_ADD_LABEL[kind]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );

  const renderTriggerRows = (): JSX.Element => (
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
        const everyPreview =
          (trigger.kind === 'data' || trigger.kind === 'condition') && trigger.every.trim()
            ? cronNextRuns(trigger.every.trim(), 3).map(relativeRunLabel)
            : [];
        // New authoring only offers cron + data; keep legacy kinds when loaded.
        const kindOptions: TriggerKind[] =
          trigger.kind === 'webhook' || trigger.kind === 'condition'
            ? [trigger.kind, ...ADDABLE_TRIGGER_KINDS]
            : [...ADDABLE_TRIGGER_KINDS];
        return (
          <div key={trigger.key} className={styles.triggerRow} data-trigger-kind={trigger.kind}>
            <div className={styles.triggerRowHead}>
              <span className={styles.triggerIndex}>{String(index + 1).padStart(2, '0')}</span>
              <select
                className={styles.triggerSelect}
                value={trigger.kind}
                aria-label={`Trigger ${index + 1} kind`}
                onChange={(event) => {
                  const kind = event.target.value as TriggerKind;
                  update({ ...draftTrigger(kind), key: trigger.key });
                }}
              >
                {kindOptions.map((kind) => (
                  <option key={kind} value={kind}>
                    {TRIGGER_KIND_LABEL[kind]}
                  </option>
                ))}
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
                  <span className={styles.microLabel}>Cron expression</span>
                  <input
                    className={cx(styles.input, styles.mono)}
                    value={trigger.expr}
                    onChange={(event) => update({ expr: event.target.value })}
                    placeholder="0 7 * * *"
                  />
                </label>
                {preview.length > 0 ? (
                  <div className={styles.cronPreview}>
                    <span className={cx(styles.microLabel, styles.cronPreviewLbl)}>Next</span>
                    {preview.map((label) => (
                      <span key={label} className={styles.cronPreviewPill}>
                        {label}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {trigger.kind === 'data' ? (
              <div className={styles.trigFields}>
                <div className={styles.subField}>
                  <span className={styles.microLabel}>Entities</span>
                  <EntityKindPicker
                    value={trigger.entities}
                    list={entityTypes}
                    segmented
                    onChange={(entities) => update({ entities })}
                    placeholder="core.transaction, billing.invoice"
                  />
                  <span className={styles.trigHint}>
                    Comma-separated <code>schema.table</code> names to watch for changes.
                  </span>
                </div>
                <label className={styles.subField}>
                  <span className={styles.microLabel}>Poll every (optional)</span>
                  <input
                    className={cx(styles.input, styles.mono)}
                    value={trigger.every}
                    onChange={(event) => update({ every: event.target.value })}
                    placeholder="* * * * *"
                    spellCheck={false}
                  />
                  <span className={styles.trigHint}>
                    5-field cron gate. Defaults to every minute.
                  </span>
                </label>
                {everyPreview.length > 0 ? (
                  <div className={styles.cronPreview}>
                    <span className={cx(styles.microLabel, styles.cronPreviewLbl)}>Next</span>
                    {everyPreview.map((label) => (
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
                <div className={styles.subField}>
                  <span className={styles.microLabel}>Entity</span>
                  <EntityKindPicker
                    value={trigger.entity}
                    list={entityTypes}
                    onChange={(entity) => update({ entity })}
                    placeholder="business.invoice"
                  />
                </div>
                <div className={styles.subField}>
                  <span className={styles.microLabel}>Where (optional)</span>
                  <div className={styles.whereBuilder}>
                    {trigger.whereRows.map((row, rowIndex) => {
                      const setRow = (patch: Partial<WhereRowDraft>): void =>
                        update({
                          whereRows: trigger.whereRows.map((r, i) =>
                            i === rowIndex ? { ...r, ...patch } : r,
                          ),
                        });
                      const takesValue = !NO_VALUE_OPS.has(row.op);
                      return (
                        <div key={rowIndex} className={styles.whereRow}>
                          <input
                            className={cx(styles.input, styles.mono, styles.whereField)}
                            value={row.column}
                            onChange={(event) => setRow({ column: event.target.value })}
                            placeholder="column"
                            aria-label="Filter column"
                            spellCheck={false}
                          />
                          <select
                            className={styles.whereSelect}
                            value={row.op}
                            aria-label="Filter operator"
                            onChange={(event) => setRow({ op: event.target.value as ConditionOp })}
                          >
                            {CONDITION_OPS.map((op) => (
                              <option key={op} value={op}>
                                {op}
                              </option>
                            ))}
                          </select>
                          {takesValue ? (
                            <input
                              className={cx(styles.input, styles.mono, styles.whereField)}
                              value={row.value}
                              onChange={(event) => setRow({ value: event.target.value })}
                              placeholder={
                                LIST_OPS.has(row.op)
                                  ? 'a, b, c'
                                  : NUMERIC_OPS.has(row.op)
                                    ? 'days'
                                    : 'value'
                              }
                              inputMode={NUMERIC_OPS.has(row.op) ? 'numeric' : undefined}
                              aria-label="Filter value"
                              spellCheck={false}
                            />
                          ) : (
                            <span className={styles.whereValueOff}>no value</span>
                          )}
                          <IconButton
                            icon="Trash"
                            ariaLabel={`Remove filter ${rowIndex + 1}`}
                            title="Remove filter"
                            onClick={() =>
                              update({
                                whereRows: trigger.whereRows.filter((_, i) => i !== rowIndex),
                              })
                            }
                          />
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      className={styles.whereAddBtn}
                      onClick={() =>
                        update({
                          whereRows: [...trigger.whereRows, { column: '', op: 'eq', value: '' }],
                        })
                      }
                    >
                      + Add filter
                    </button>
                  </div>
                </div>
                <label className={styles.subField}>
                  <span className={styles.microLabel}>Evaluate every (optional)</span>
                  <input
                    className={cx(styles.input, styles.mono)}
                    value={trigger.every}
                    onChange={(event) => update({ every: event.target.value })}
                    placeholder="*/5 * * * *"
                    spellCheck={false}
                  />
                  <span className={styles.trigHint}>
                    5-field cron gate. Defaults to every 5 minutes.
                  </span>
                </label>
                {everyPreview.length > 0 ? (
                  <div className={styles.cronPreview}>
                    <span className={cx(styles.microLabel, styles.cronPreviewLbl)}>Next</span>
                    {everyPreview.map((label) => (
                      <span key={label} className={styles.cronPreviewPill}>
                        {label}
                      </span>
                    ))}
                  </div>
                ) : null}
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
  );

  const toggleConnector = (kind: string): void => {
    setSelectedConnectors((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) {
        next.delete(kind);
        setConnectionBindings((m) => {
          const copy = new Map(m);
          copy.delete(kind);
          return copy;
        });
      } else {
        next.add(kind);
        const cat = catalog.find((c) => c.kind === kind);
        if (cat?.connection) {
          setConnectionBindings((m) => {
            const copy = new Map(m);
            copy.set(kind, {
              connectionId: cat.connection!.connectionId,
              kind: cat.kind,
              label: cat.connection!.label,
            });
            return copy;
          });
        }
      }
      return next;
    });
  };

  /** After picker configure/authorize — always select + persist durable id. */
  const bindConnection = (binding: { connectionId: string; kind: string; label: string }): void => {
    setSelectedConnectors((prev) => new Set(prev).add(binding.kind));
    setConnectionBindings((m) => {
      const copy = new Map(m);
      copy.set(binding.kind, binding);
      return copy;
    });
  };

  const selectedConnectorItems = catalog.filter((c) => selectedConnectors.has(c.kind));

  const instructionsBlock = (
    <div className={cx(styles.field, styles.instructionsField, styles.instructionsCard)}>
      <span className={cx(styles.fieldLabel, styles.instructionsLabel)}>Instructions</span>
      <textarea
        ref={instructionsRef}
        className={styles.textarea}
        rows={6}
        value={instructions}
        onChange={onInstructionsChange}
        placeholder="Read my unread emails and summarize…"
        aria-label="Instructions"
      />
      {Array.from(instructions.matchAll(/@\[([^/\]]+)\/([^\]]+)\]/g)).length > 0 ? (
        <div className={styles.entityTokens} aria-label="Tagged data">
          {Array.from(instructions.matchAll(/@\[([^/\]]+)\/([^\]]+)\]/g), (match) => (
            <span key={match[0]} className={styles.entityToken}>
              <code>@{match[1]}</code>
              <span>{match[2] === '*' ? 'type' : match[2]}</span>
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
              <code>{hit.subtitle ?? hit.type}</code>
            </button>
          ))}
        </div>
      ) : null}
      {selectedConnectorItems.length > 0 ? (
        <div className={styles.selectedConnectors} aria-label="Selected connectors">
          {selectedConnectorItems.map((c) => (
            <button
              key={c.key}
              type="button"
              className={styles.selectedConnChip}
              title={
                c.connection?.health === 'ok'
                  ? `${c.name} · connected — click to remove`
                  : `${c.name} · not fully connected — click to remove`
              }
              onClick={() => toggleConnector(c.kind)}
            >
              <span className={styles.selectedConnMark} aria-hidden="true">
                <Icon name="Plug" size={11} />
              </span>
              <span>{c.name}</span>
              {c.connection?.health === 'ok' ? (
                <span className={styles.selectedConnOk} aria-hidden="true">
                  ✓
                </span>
              ) : (
                <span className={styles.selectedConnWarn} aria-hidden="true">
                  !
                </span>
              )}
              <span className={styles.selectedConnX} aria-hidden="true">
                ×
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.instrToolbar} ref={connectorsWrapRef}>
        <button
          type="button"
          className={styles.instrChip}
          data-open={String(connectorsOpen)}
          onClick={openConnectorsPicker}
          aria-expanded={connectorsOpen}
          aria-haspopup="dialog"
          title="Choose connectors this automation may use"
        >
          <Icon name="Plug" size={14} />
          <span>Connectors</span>
          <span className={styles.instrChipCount}>{connectorCount}</span>
          <Icon name="ChevronDown" size={12} />
        </button>
        <span className={styles.instrHint}>
          {connectorCount === 0
            ? 'Optional — attach Gmail, GitHub, …'
            : `${connectorCount} selected`}
        </span>
        <AutomationEditorConnectorsPicker
          open={connectorsOpen}
          catalog={catalog}
          loading={catalogLoading}
          selected={selectedConnectors}
          onToggleSelect={toggleConnector}
          onBoundConnection={bindConnection}
          onClose={() => setConnectorsOpen(false)}
          configureConnection={configureConnection}
          beginAuthorize={beginAuthorize}
          onConnected={() => void refreshCatalog()}
          showToast={showToast}
        />
      </div>
    </div>
  );

  return (
    <div className={styles.page} data-testid="automation-editor" data-mode={d.mode}>
      <div className={styles.head} data-hue={hue}>
        <div className={styles.headIdentity}>
          <span className={au.auGlyph} data-hue={hue} data-size="lg" aria-hidden="true">
            <Icon name={glyph as IconName} size={20} />
          </span>
          <div>
            <div className={styles.headName}>
              {name.trim() || (isCreate ? 'New Automation' : d.name)}
            </div>
            <span
              className={au.auStatus}
              data-tone={isCreate ? 'draft' : enabled ? 'active' : 'paused'}
            >
              <span className={au.auStatusIc} aria-hidden="true">
                <Icon name={isCreate ? 'Pencil' : enabled ? 'Power' : 'Pause'} size={11} />
              </span>
              <span>{isCreate ? 'Draft' : enabled ? 'Active' : 'Paused'}</span>
            </span>
          </div>
        </div>
        <div className={styles.headActions}>
          {isCreate ? (
            <IconButton icon="X" ariaLabel="Close" title="Close" onClick={onCancel} />
          ) : (
            <>
              <label className={styles.enableControl} title={enabled ? 'Disable' : 'Enable'}>
                <span className={styles.enableText}>{enabled ? 'On' : 'Off'}</span>
                <span className={styles.switch}>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={`${enabled ? 'Disable' : 'Enable'} automation`}
                    checked={enabled}
                    disabled={toggleBusy}
                    onChange={(e) => doToggle(e.target.checked)}
                  />
                  <span className={styles.switchTrack} aria-hidden="true" />
                </span>
              </label>
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
            </>
          )}
        </div>
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Name</span>
        <input
          ref={nameInputRef}
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Automation"
          aria-label="Name"
          required
        />
      </label>

      {instructionsBlock}

      <section className={styles.section}>
        <div className={styles.sectionHeading}>
          <div>
            <h2 className={styles.sectionTitle}>Triggers</h2>
            <p className={styles.sectionHint}>
              Optional. Without a trigger, this only runs when you press Run now.
            </p>
          </div>
          {addTriggerMenu}
        </div>
        {triggers.length === 0 ? (
          <div className={styles.triggerEmptyCard}>
            <p className={styles.triggerEmpty}>
              Manual only for now — add a schedule or watch vault data to run automatically.
            </p>
            <div className={styles.triggerEmptyActions}>
              <button
                type="button"
                className={styles.triggerEmptyBtn}
                onClick={() => setTriggers((t) => [...t, draftTrigger('cron')])}
              >
                + Schedule
              </button>
              <button
                type="button"
                className={styles.triggerEmptyBtn}
                onClick={() => setTriggers((t) => [...t, draftTrigger('data')])}
              >
                + Data change
              </button>
            </div>
          </div>
        ) : null}
        {renderTriggerRows()}
      </section>

      <section className={styles.section}>
        <nav className={styles.tabs} role="tablist" aria-label="Automation details">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={styles.tab}
              data-active={String(tab === t.id)}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className={styles.tabPanel}>
          {tab === 'notifications' ? (
            <NotificationsPanel
              onFailure={d.onFailure ?? null}
              model={d.model ?? null}
              notifyMode={notifyMode}
              onNotifyMode={setNotifyMode}
            />
          ) : null}
          {tab === 'plan' ? (
            <PlanPanel mode={d.mode} source={source} file={sourceFile} onFile={setSourceFile} />
          ) : null}
        </div>
      </section>

      <div className={styles.footer}>
        <p className={styles.footerHint}>
          {!name.trim()
            ? 'Name required to save'
            : isCreate
              ? 'Creates a draft plan from your instructions'
              : 'Saves name, instructions, and triggers'}
        </p>
        <div className={styles.footerActions}>
          <Button variant="ghost" label="Cancel" onClick={onCancel} />
          <Button
            variant="primary"
            label={
              isCreate
                ? saving
                  ? 'Creating…'
                  : 'Create automation'
                : saving
                  ? 'Saving…'
                  : 'Save changes'
            }
            disabled={!name.trim() || saving}
            onClick={() => void doSave()}
          />
        </div>
      </div>
    </div>
  );
}
