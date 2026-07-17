import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  browseColumns,
  browseDeleteRow,
  browseDependents,
  browseRows,
  browseTables,
  type BrowseColumnsResult,
  type BrowseTableEntry,
} from '../../gateway-client.js';
import Icon from '../ui/Icon.js';
import styles from './AtlasBrowseTab.module.css';
import { DeleteDialog } from './AtlasBrowseDeleteDialog.js';
import { Grid, MachineryBar } from './AtlasBrowseGrid.js';
import { RowEditor } from './AtlasBrowseRowEditor.js';
import { TablePicker } from './AtlasBrowseTablePicker.js';
import {
  groupBrowseTables,
  rowIdOf,
  type DeleteState,
  type EditorState,
} from './atlasBrowseData.js';

// Browse tab — the vault-aware table editor (issue #441 B3). A table picker
// (left rail on desktop, a collapsible sheet on narrow), a keyset-paginated
// sortable grid, and an inline row editor whose writes ride the gateway's
// journalled command path — never raw SQL. Sealed columns render as chips and
// refuse edits; machinery bands are read-only until an explicit unlock; deletes
// first ask which rows (engine FK + polymorphic) depend on the target. Reads
// and writes come straight from the vault client; the only prop is the table a
// Kinds card asked to open. The picker/grid/editor/dialog are sibling modules;
// this component orchestrates them and owns all state.

export interface AtlasBrowseTabProps {
  /** Logical `schema.table` to preselect, set when a Kinds card opened Browse. */
  initialTable?: string;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export default function AtlasBrowseTab({ initialTable }: AtlasBrowseTabProps): JSX.Element {
  const [tables, setTables] = useState<BrowseTableEntry[] | null>(null);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(initialTable);

  const [cols, setCols] = useState<BrowseColumnsResult | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [orderBy, setOrderBy] = useState<string | null>(null);
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [cursor, setCursor] = useState<string | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const [gridLoading, setGridLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);

  const [unlockMachinery, setUnlockMachinery] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [del, setDel] = useState<DeleteState | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load the picker once.
  useEffect(() => {
    void browseTables()
      .then((t) => {
        if (mountedRef.current) setTables(t);
      })
      .catch((e) => {
        if (mountedRef.current) setTablesError(errText(e));
      });
  }, []);

  // React to the preselect prop changing while mounted (a fresh Kinds click).
  useEffect(() => {
    if (initialTable) {
      setSelected(initialTable);
      setPickerOpen(false);
    }
  }, [initialTable]);

  const selectedEntry = tables?.find((t) => t.logical === selected);
  const isMachinery = selectedEntry?.machinery ?? cols?.machinery ?? false;
  const writesLocked = isMachinery && !unlockMachinery;

  // Fetch one page of rows. `mode:'append'` keeps the current rows (Load more),
  // otherwise the page replaces them (selection change / sort / refresh).
  const fetchRows = useCallback(
    async (
      logical: string,
      opts: { orderBy?: string; dir?: 'asc' | 'desc'; after?: string },
      mode: 'replace' | 'append',
    ) => {
      if (mode === 'append') setMoreLoading(true);
      else setGridLoading(true);
      setGridError(null);
      try {
        const page = await browseRows({
          table: logical,
          ...(opts.orderBy ? { orderBy: opts.orderBy } : {}),
          ...(opts.dir ? { dir: opts.dir } : {}),
          ...(opts.after ? { after: opts.after } : {}),
        });
        if (!mountedRef.current) return;
        setRows((prev) => (mode === 'append' ? [...prev, ...page.rows] : page.rows));
        setOrderBy(page.orderBy);
        setDir(page.dir);
        setCursor(page.nextCursor);
      } catch (e) {
        if (mountedRef.current) setGridError(errText(e));
      } finally {
        if (mountedRef.current) {
          setGridLoading(false);
          setMoreLoading(false);
        }
      }
    },
    [],
  );

  // A selection change resets everything table-scoped, then loads columns + the
  // first page. Guarded against a fast re-selection racing an in-flight load.
  useEffect(() => {
    if (!selected) {
      setCols(null);
      setRows([]);
      return;
    }
    let cancelled = false;
    setCols(null);
    setRows([]);
    setOrderBy(null);
    setDir('asc');
    setCursor(null);
    setUnlockMachinery(false);
    setEditor(null);
    setDel(null);
    setExpanded(new Set());
    setGridError(null);
    setGridLoading(true);
    void (async () => {
      try {
        const meta = await browseColumns(selected);
        if (cancelled || !mountedRef.current) return;
        setCols(meta);
      } catch (e) {
        if (!cancelled && mountedRef.current) {
          setGridError(errText(e));
          setGridLoading(false);
        }
        return;
      }
      await fetchRows(selected, {}, 'replace');
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, fetchRows]);

  const onSort = useCallback(
    (col: string) => {
      if (!selected) return;
      const nextDir: 'asc' | 'desc' = orderBy === col && dir === 'asc' ? 'desc' : 'asc';
      void fetchRows(selected, { orderBy: col, dir: nextDir }, 'replace');
    },
    [selected, orderBy, dir, fetchRows],
  );

  const loadMore = useCallback(() => {
    if (!selected || !cursor) return;
    void fetchRows(selected, { after: cursor, ...(orderBy ? { orderBy } : {}), dir }, 'append');
  }, [selected, cursor, orderBy, dir, fetchRows]);

  const refresh = useCallback(() => {
    if (!selected) return;
    void fetchRows(selected, { ...(orderBy ? { orderBy } : {}), dir }, 'replace');
  }, [selected, orderBy, dir, fetchRows]);

  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const pick = useCallback((logical: string) => {
    setSelected(logical);
    setPickerOpen(false);
  }, []);

  // ── Delete flow ──────────────────────────────────────────────────────────
  const askDelete = useCallback(
    (row: Record<string, unknown>) => {
      if (!selected || !cols) return;
      const id = rowIdOf(row, cols.columns);
      setDel({
        id,
        loading: true,
        dependents: [],
        hasEngineDependents: false,
        totalRows: 0,
        blockedReason: null,
        error: null,
      });
      void browseDependents(selected, id)
        .then((dep) => {
          if (!mountedRef.current) return;
          setDel({
            id,
            loading: false,
            dependents: dep.dependents,
            hasEngineDependents: dep.hasEngineDependents,
            totalRows: dep.totalRows,
            blockedReason: dep.hasEngineDependents
              ? 'Engine foreign keys still point at this row — the database refuses the delete until they are cleared.'
              : null,
            error: null,
          });
        })
        .catch((e) => {
          if (mountedRef.current) {
            setDel((d) => (d ? { ...d, loading: false, error: errText(e) } : d));
          }
        });
    },
    [selected, cols],
  );

  const confirmDelete = useCallback(() => {
    if (!selected || !del) return;
    setDel((d) => (d ? { ...d, loading: true, error: null } : d));
    void browseDeleteRow({
      table: selected,
      id: del.id,
      ...(unlockMachinery ? { unlockMachinery: true } : {}),
    }).then((res) => {
      if (!mountedRef.current) return;
      if (res.ok) {
        setDel(null);
        setEditor(null);
        refresh();
        return;
      }
      // A race: dependents appeared between the ask and the confirm (409). Show
      // the freshly-returned set and block rather than failing silently.
      setDel((d) =>
        d
          ? {
              ...d,
              loading: false,
              dependents: res.dependents ?? d.dependents,
              totalRows: res.totalRows ?? d.totalRows,
              hasEngineDependents: (res.dependents ?? d.dependents).some(
                (x) => x.mechanism === 'fk',
              ),
              blockedReason:
                res.error === 'has_dependents'
                  ? 'Other rows still reference this one — clear them first.'
                  : (res.error ?? 'Delete was refused.'),
              error: null,
            }
          : d,
      );
    });
  }, [selected, del, unlockMachinery, refresh]);

  // ── Render ───────────────────────────────────────────────────────────────
  if (tablesError && !tables) {
    return (
      <div className={styles.tab}>
        <div className={styles.gridError} data-testid="atlas-browse-tables-error">
          Couldn’t list your vault’s tables: {tablesError}
        </div>
      </div>
    );
  }
  if (!tables) {
    return (
      <div className={styles.tab}>
        <div className={styles.loading}>Listing your vault’s tables…</div>
      </div>
    );
  }

  const grouped = groupBrowseTables(tables, query);

  return (
    <div className={styles.tab}>
      <div className={styles.layout}>
        <TablePicker
          grouped={grouped}
          selected={selected}
          selectedEntry={selectedEntry}
          query={query}
          onQuery={setQuery}
          open={pickerOpen}
          onToggleOpen={() => setPickerOpen((o) => !o)}
          onPick={pick}
        />

        <section className={styles.main}>
          {!selected ? (
            <div className={styles.prompt} data-testid="atlas-browse-empty">
              <span className={styles.promptIcon}>
                <Icon name="Braces" size={22} />
              </span>
              <p className={styles.promptText}>
                Pick a table to page through its rows and edit them through the vault’s journalled
                write path — never raw SQL.
              </p>
            </div>
          ) : (
            <>
              <header className={styles.mainHead}>
                <div className={styles.mainTitle}>
                  <h2 className={styles.mainName}>{selectedEntry?.label ?? selected}</h2>
                  <code className={styles.mainLogical}>{selected}</code>
                  {isMachinery ? <span className={styles.machineryTag}>machinery</span> : null}
                </div>
                <div className={styles.headActions}>
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    onClick={refresh}
                    disabled={gridLoading}
                    aria-label="Refresh rows"
                  >
                    <Icon name="Refresh" size={13} />
                  </button>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    onClick={() => setEditor({ mode: 'insert' })}
                    disabled={writesLocked || !cols}
                    data-testid="atlas-browse-insert"
                  >
                    <Icon name="Plus" size={13} />
                    Insert row
                  </button>
                </div>
              </header>

              {isMachinery ? (
                <MachineryBar
                  unlocked={unlockMachinery}
                  onToggle={() => setUnlockMachinery((u) => !u)}
                />
              ) : null}

              {gridError ? (
                <div className={styles.gridError} data-testid="atlas-browse-grid-error">
                  {gridError}
                </div>
              ) : null}

              {cols ? (
                <Grid
                  cols={cols}
                  rows={rows}
                  orderBy={orderBy}
                  dir={dir}
                  loading={gridLoading}
                  expanded={expanded}
                  onSort={onSort}
                  onToggleExpand={toggleExpand}
                  writesLocked={writesLocked}
                  onEdit={(row) => setEditor({ mode: 'edit', id: rowIdOf(row, cols.columns), row })}
                  onDelete={askDelete}
                />
              ) : gridLoading ? (
                <div className={styles.loading}>Reading rows…</div>
              ) : null}

              {cursor ? (
                <button
                  type="button"
                  className={styles.loadMore}
                  onClick={loadMore}
                  disabled={moreLoading}
                  data-testid="atlas-browse-load-more"
                >
                  {moreLoading ? 'Loading…' : 'Load more'}
                </button>
              ) : null}
            </>
          )}
        </section>
      </div>

      {editor && cols && selected ? (
        <RowEditor
          key={editor.mode === 'edit' ? editor.id : 'insert'}
          table={selected}
          cols={cols}
          editor={editor}
          unlockMachinery={unlockMachinery}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            refresh();
          }}
          onDelete={
            editor.mode === 'edit'
              ? () => {
                  if (editor.mode === 'edit') askDelete(editor.row);
                }
              : undefined
          }
        />
      ) : null}

      {del ? (
        <DeleteDialog state={del} onCancel={() => setDel(null)} onConfirm={confirmDelete} />
      ) : null}
    </div>
  );
}
