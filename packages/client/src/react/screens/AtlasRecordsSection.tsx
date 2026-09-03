import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import type { GridSortData } from "@centraid/design/blocks";

import {
  browseColumns,
  browseDeleteRow,
  browseDependents,
  browseRows,
} from "../../gateway-client.js";
import type { BrowseColumnsResult } from "../../gateway-client.js";
import type { CtxItem } from "../shell/contextMenu.js";
import { PageSkeleton } from "../shell/status.js";
import { postStatus } from "../shell/statusChannel.js";
import Button from "../ui/Button.js";
import { cx } from "../ui/cx.js";
import GridBlock from "../ui/GridBlock.js";
import Icon from "../ui/Icon.js";
import NoteBlock from "../ui/NoteBlock.js";
import PanelBlock from "../ui/PanelBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import { rowIdOf } from "./atlasBrowseData.js";
import type { DeleteState, EditorState } from "./atlasBrowseData.js";
import { DeleteDialog } from "./AtlasBrowseDeleteDialog.js";
import { RowEditor } from "./AtlasBrowseRowEditor.js";
import {
  defaultSortKey,
  gridColumnsFrom,
  gridRowsFrom,
  sortLabel,
  tableCaption,
} from "./atlasScreenModel.js";

import styles from "./AtlasRecordsSection.module.css";

export interface AtlasRecordsSectionProps {
  logical: string;
  label: string;
  records: number;
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

function MachineryBar({
  unlocked,
  onToggle,
}: {
  unlocked: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div
      className={cx(styles.machineryBar, unlocked && styles.machineryBarOpen)}
    >
      <Icon name="AlertTriangle" size={14} />
      <p className={styles.machineryNote} data-testid="atlas-machinery-locked">
        {unlocked
          ? "Machinery edits unlocked — hand-editing plumbing rows can break vault invariants."
          : "Machinery band — browsing only, since hand-edits can break vault invariants."}
      </p>
      <button
        type="button"
        className={styles.unlockBtn}
        role="switch"
        aria-checked={unlocked}
        onClick={onToggle}
        data-testid="atlas-machinery-unlock"
      >
        {unlocked ? "Lock" : "Unlock machinery edits"}
      </button>
    </div>
  );
}

export default function AtlasRecordsSection({
  logical,
  label,
  records,
}: AtlasRecordsSectionProps): JSX.Element {
  const [cols, setCols] = useState<BrowseColumnsResult | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sort, setSort] = useState<GridSortData | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);

  const [unlockMachinery, setUnlockMachinery] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [del, setDel] = useState<DeleteState | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isMachinery = cols?.machinery ?? false;
  const writesLocked = isMachinery && !unlockMachinery;

  const fetchRows = useCallback(
    async (
      table: string,
      order: GridSortData,
      after: string | null
    ): Promise<void> => {
      if (after) setMoreLoading(true);
      else setLoading(true);
      setReadError(null);
      try {
        const page = await browseRows({
          dir: order.dir,
          orderBy: order.key,
          table,
          ...(after ? { after } : {}),
        });
        if (!mountedRef.current) return;
        setRows((prev) => (after ? [...prev, ...page.rows] : page.rows));
        setCursor(page.nextCursor);
        setSort({ dir: page.dir, key: page.orderBy });
      } catch (error) {
        if (mountedRef.current) setReadError(errText(error));
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setMoreLoading(false);
        }
      }
    },
    []
  );

  const [seen, setSeen] = useState(logical);
  if (seen !== logical) {
    setSeen(logical);
    setCols(null);
    setRows([]);
    setCursor(null);
    setSort(null);
    setUnlockMachinery(false);
    setEditor(null);
    setDel(null);
    setReadError(null);
    setLoading(true);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const meta = await browseColumns(logical);
        if (cancelled || !mountedRef.current) return;
        setCols(meta);
        await fetchRows(
          logical,
          { dir: "desc", key: defaultSortKey(meta) },
          null
        );
      } catch (error) {
        if (!cancelled && mountedRef.current) {
          setReadError(errText(error));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [logical, fetchRows]);

  const order = useMemo<GridSortData | null>(
    () => (cols ? (sort ?? { dir: "desc", key: defaultSortKey(cols) }) : null),
    [cols, sort]
  );

  const refresh = useCallback(() => {
    if (!order) return;
    void fetchRows(logical, order, null);
  }, [fetchRows, logical, order]);

  const reorder = useCallback(
    (next: GridSortData) => {
      void fetchRows(logical, next, null);
    },
    [fetchRows, logical]
  );

  const askDelete = useCallback(
    (row: Record<string, unknown>) => {
      if (!cols) return;
      const id = rowIdOf(row, cols.columns);
      setDel({
        dependents: [],
        blockedReason: null,
        error: null,
        hasEngineDependents: false,
        id,
        loading: true,
        totalRows: 0,
      });
      void browseDependents(logical, id)
        .then((dep) => {
          if (!mountedRef.current) return;
          setDel({
            blockedReason: dep.hasEngineDependents
              ? "Engine foreign keys still point at this row — the database refuses the delete until they are cleared."
              : null,
            dependents: dep.dependents,
            error: null,
            hasEngineDependents: dep.hasEngineDependents,
            id,
            loading: false,
            totalRows: dep.totalRows,
          });
        })
        .catch((error) => {
          if (mountedRef.current)
            setDel((d) =>
              d ? { ...d, error: errText(error), loading: false } : d
            );
        });
    },
    [cols, logical]
  );

  const confirmDelete = useCallback(() => {
    if (!del) return;
    setDel((d) => (d ? { ...d, error: null, loading: true } : d));
    void browseDeleteRow({
      id: del.id,
      table: logical,
      ...(unlockMachinery ? { unlockMachinery: true } : {}),
    }).then((res) => {
      if (!mountedRef.current) return;
      if (res.ok) {
        setDel(null);
        setEditor(null);
        refresh();
        return;
      }
      setDel((d) =>
        d
          ? {
              ...d,
              blockedReason:
                res.error === "has_dependents"
                  ? "Other rows still reference this one — clear them first."
                  : (res.error ?? "Delete was refused."),
              dependents: res.dependents ?? d.dependents,
              error: null,
              hasEngineDependents: (res.dependents ?? d.dependents).some(
                (x) => x.mechanism === "fk"
              ),
              loading: false,
              totalRows: res.totalRows ?? d.totalRows,
            }
          : d
      );
    });
  }, [del, logical, unlockMachinery, refresh]);

  const menu: (CtxItem | "sep")[] = [
    { icon: "Eye", id: "open", label: "Open the record" },
    { icon: "Copy", id: "copy", label: "Copy the id" },
    ...(writesLocked
      ? []
      : [
          "sep" as const,
          { danger: true, icon: "Trash", id: "delete", label: "Delete" },
        ]),
  ];

  const onMenuPick = useCallback(
    (rowId: string, itemId: string) => {
      if (!cols) return;
      const row = rows.find((r) => rowIdOf(r, cols.columns) === rowId);
      if (!row) return;
      if (itemId === "open") {
        setEditor({ id: rowId, mode: "edit", row });
        return;
      }
      if (itemId === "copy") {
        void navigator.clipboard?.writeText(rowId);
        postStatus(`Copied the id · ${rowId}`);
        return;
      }
      if (itemId === "delete") askDelete(row);
    },
    [askDelete, cols, rows]
  );

  const columns = useMemo(() => (cols ? gridColumnsFrom(cols) : []), [cols]);
  const gridRows = useMemo(
    () => (cols ? gridRowsFrom(cols, rows) : []),
    [cols, rows]
  );

  const orderWords =
    order && cols ? sortLabel(order, defaultSortKey(cols)) : "";

  return (
    <>
      <SectionBlock
        label={label}
        meta={`${records.toLocaleString()} records`}
        {...(order
          ? {
              action: {
                hint: "Turn the order round",
                label: orderWords,
                onClick: () =>
                  reorder({
                    dir: order.dir === "desc" ? "asc" : "desc",
                    key: order.key,
                  }),
              },
            }
          : {})}
      />
      {isMachinery ? (
        <MachineryBar
          unlocked={unlockMachinery}
          onToggle={() => setUnlockMachinery((u) => !u)}
        />
      ) : null}

      {readError ? (
        <PanelBlock
          action={{ label: "Try again", onClick: refresh }}
          body={readError}
          className={styles.kindError}
          eyebrow="Data"
          title="Cannot read this kind"
          tone="net"
        />
      ) : null}

      {loading && !cols ? (
        <PageSkeleton label={`Reading ${label} records`} rows={6} />
      ) : null}

      {cols && gridRows.length > 0 ? (
        <GridBlock
          ariaLabel={`${label} records`}
          caption={tableCaption(
            gridRows.length,
            Math.max(records, gridRows.length),
            orderWords
          )}
          columns={columns}
          menu={menu}
          menuLabel="More for"
          onMenuPick={onMenuPick}
          onSort={reorder}
          rows={gridRows}
          sort={order}
        />
      ) : null}

      {cols && gridRows.length === 0 && !loading ? (
        <NoteBlock>This kind has no records yet.</NoteBlock>
      ) : null}

      {cols ? (
        <div className={styles.controls}>
          {cursor && order ? (
            <Button
              commit={false}
              disabled={moreLoading}
              label={moreLoading ? "Reading…" : "Show more records"}
              onClick={() => void fetchRows(logical, order, cursor)}
              size="sm"
              variant="secondary"
            />
          ) : null}
          <Button
            commit={false}
            disabled={writesLocked}
            label="Insert a record"
            onClick={() => setEditor({ mode: "insert" })}
            size="sm"
            variant="secondary"
          />
        </div>
      ) : null}

      {editor && cols ? (
        <RowEditor
          key={editor.mode === "edit" ? editor.id : "insert"}
          table={logical}
          cols={cols}
          editor={editor}
          unlockMachinery={unlockMachinery}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            refresh();
          }}
          onDelete={
            editor.mode === "edit"
              ? () => {
                  if (editor.mode === "edit") askDelete(editor.row);
                }
              : undefined
          }
        />
      ) : null}

      {del ? (
        <DeleteDialog
          state={del}
          onCancel={() => setDel(null)}
          onConfirm={confirmDelete}
        />
      ) : null}
    </>
  );
}
