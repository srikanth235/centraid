import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import {
  browseInsertRow,
  browseRefSearch,
  browseUpdateRow,
  type BrowseColumn,
  type BrowseColumnsResult,
  type BrowseRefHit,
} from '../../gateway-client.js';
import Icon from '../ui/Icon.js';
import styles from './AtlasBrowseTab.module.css';
import {
  cellText,
  insertableColumns,
  isNumericColumn,
  pkColumns,
  type EditorState,
} from './atlasBrowseData.js';

// The row editor drawer (issue #441 B3), split out of AtlasBrowseTab. An insert
// or edit form whose writes ride the gateway's journalled command path — never
// raw SQL. Sealed columns render as read-only chips and are never written; pk
// columns are auto-minted on insert; FK columns get a reference-picker combobox.

// ── Row editor ───────────────────────────────────────────────────────────────
export function RowEditor({
  table,
  cols,
  editor,
  unlockMachinery,
  onClose,
  onSaved,
  onDelete,
}: {
  table: string;
  cols: BrowseColumnsResult;
  editor: Exclude<EditorState, null>;
  unlockMachinery: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => void;
}): JSX.Element {
  const isInsert = editor.mode === 'insert';
  const original = editor.mode === 'edit' ? editor.row : null;

  const initial: Record<string, string> = {};
  for (const c of cols.columns) {
    if (c.sealed) continue;
    if (isInsert) initial[c.name] = '';
    else initial[c.name] = original ? cellText(original[c.name]) : '';
  }
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setField = (name: string, v: string): void => setDraft((d) => ({ ...d, [name]: v }));

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const machineryFlag = unlockMachinery ? { unlockMachinery: true } : {};

    const coerce = (c: BrowseColumn, raw: string): unknown => {
      if (raw === '') return null;
      if (isNumericColumn(c)) {
        const n = Number(raw);
        return Number.isNaN(n) ? raw : n;
      }
      return raw;
    };

    const finish = (res: { ok: boolean; error?: string }): void => {
      setSaving(false);
      if (res.ok) onSaved();
      else setError(res.error ?? 'The write was refused.');
    };

    if (isInsert) {
      const values: Record<string, unknown> = {};
      for (const c of insertableColumns(cols.columns)) {
        if (c.sealed) continue;
        const raw = draft[c.name] ?? '';
        if (raw === '') continue; // let NOT NULL surface a clean server message
        values[c.name] = coerce(c, raw);
      }
      void browseInsertRow({ table, values, ...machineryFlag }).then(finish);
    } else if (editor.mode === 'edit') {
      const set: Record<string, unknown> = {};
      for (const c of cols.columns) {
        if (c.sealed || c.pk > 0) continue;
        const raw = draft[c.name] ?? '';
        const was = original ? cellText(original[c.name]) : '';
        if (raw !== was) set[c.name] = coerce(c, raw);
      }
      void browseUpdateRow({ table, id: editor.id, set, ...machineryFlag }).then(finish);
    }
  };

  const pks = pkColumns(cols.columns);

  return (
    <div className={styles.drawerScrim}>
      <div className={styles.drawerBackdrop} role="presentation" onClick={onClose} />
      <form
        className={styles.drawer}
        onSubmit={submit}
        aria-label={isInsert ? 'Insert row' : 'Edit row'}
        data-testid="atlas-row-editor"
      >
        <header className={styles.drawerHead}>
          <h3 className={styles.drawerTitle}>
            {isInsert ? 'Insert row' : 'Edit row'}
            <code className={styles.drawerTable}>{table}</code>
          </h3>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onClose}
            aria-label="Close editor"
          >
            <Icon name="X" size={14} />
          </button>
        </header>

        <div className={styles.fields}>
          {cols.columns.map((c) => (
            <Field
              key={c.name}
              col={c}
              isInsert={isInsert}
              value={draft[c.name] ?? ''}
              isPk={pks.some((p) => p.name === c.name)}
              onChange={(v) => setField(c.name, v)}
            />
          ))}
        </div>

        {error ? (
          <div className={styles.drawerError} data-testid="atlas-row-error">
            {error}
          </div>
        ) : null}

        <footer className={styles.drawerFoot}>
          {onDelete ? (
            <button
              type="button"
              className={styles.dangerBtn}
              onClick={onDelete}
              data-testid="atlas-editor-delete"
            >
              <Icon name="Trash" size={13} />
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className={styles.footRight}>
            <button type="button" className={styles.ghostBtn} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className={styles.primaryBtn}
              disabled={saving}
              data-testid="atlas-row-submit"
            >
              {saving ? 'Saving…' : isInsert ? 'Insert' : 'Save'}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function Field({
  col,
  isInsert,
  value,
  isPk,
  onChange,
}: {
  col: BrowseColumn;
  isInsert: boolean;
  value: string;
  isPk: boolean;
  onChange: (v: string) => void;
}): JSX.Element {
  const required = col.notnull && col.defaultValue === null && !isPk;

  return (
    <label className={styles.field} data-col={col.name}>
      <span className={styles.fieldLabel}>
        {col.name}
        {required ? <span className={styles.reqStar}>*</span> : null}
        <span className={styles.fieldType}>{col.type.toLowerCase()}</span>
      </span>

      {col.sealed ? (
        <span className={styles.sealedField} data-testid="atlas-field-sealed">
          <Icon name="Key" size={11} />
          sealed — value is encrypted and cannot be edited here
        </span>
      ) : isPk && isInsert ? (
        <span className={styles.autoField}>auto-minted on insert</span>
      ) : isPk ? (
        <input
          className={styles.input}
          value={value}
          readOnly
          data-testid="atlas-field"
          data-col={col.name}
        />
      ) : col.fkTable ? (
        <FkField
          fkTable={col.fkTable}
          fkLabel={col.fkLogical ?? col.fkTable}
          value={value}
          onChange={onChange}
          colName={col.name}
        />
      ) : (
        <input
          className={styles.input}
          type={isNumericColumn(col) ? 'number' : 'text'}
          value={value}
          required={required}
          onChange={(e) => onChange(e.target.value)}
          data-testid="atlas-field"
          data-col={col.name}
        />
      )}
    </label>
  );
}

// FK reference picker — searches the target table as the owner types, shows the
// target's display field, and stores its id. A pasted id that never matches a
// hit is kept verbatim, so manual entry still works.
function FkField({
  fkTable,
  fkLabel,
  value,
  onChange,
  colName,
}: {
  fkTable: string;
  fkLabel: string;
  value: string;
  onChange: (id: string) => void;
  colName: string;
}): JSX.Element {
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<BrowseRefHit[]>([]);
  const [display, setDisplay] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  const search = (q: string): void => {
    setTerm(q);
    onChange(q); // manual-paste path: the raw text is the id until a hit is picked
    setOpen(true);
    if (q.trim() === '') {
      setHits([]);
      return;
    }
    void browseRefSearch(fkTable, q).then((h) => {
      if (liveRef.current) setHits(h);
    });
  };

  const choose = (hit: BrowseRefHit): void => {
    onChange(hit.id);
    setDisplay(hit.display);
    setTerm(hit.display);
    setOpen(false);
    setHits([]);
  };

  return (
    <div className={styles.fkField}>
      <input
        className={styles.input}
        placeholder={`Search ${fkLabel}…`}
        value={open ? term : (display ?? value)}
        onFocus={() => {
          setOpen(true);
          setTerm(value);
        }}
        onChange={(e) => search(e.target.value)}
        data-testid="atlas-fk-input"
        data-col={colName}
      />
      {value ? (
        <span className={styles.fkChosen} data-testid="atlas-fk-value">
          {display ? `${display} · ` : ''}
          {value}
        </span>
      ) : null}
      {open && hits.length > 0 ? (
        <ul className={styles.fkHits}>
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className={styles.fkHit}
                onClick={() => choose(h)}
                data-testid="atlas-fk-hit"
                data-id={h.id}
              >
                <span className={styles.fkHitDisplay}>{h.display}</span>
                <span className={styles.fkHitId}>{h.id}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
