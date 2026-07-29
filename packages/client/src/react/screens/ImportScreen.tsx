import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { relativeTime } from "../format.js";
import type {
  ImportBatchDTO,
  ImportBridgeProps,
  ImportConnectionDTO,
  ImportData,
  ImportRowDTO,
} from "../screen-contracts.js";

import appSettingsCss from "../styles/appSettings.module.css";
import vault from "../styles/vault.module.css";
import styles from "./ImportScreen.module.css";

const TEXT_KINDS = new Set([
  "ics",
  "vcf",
  "vcard",
  "mbox",
  "csv",
  "md",
  "markdown",
]);

interface DirectoryHandle {
  name: string;
  entries: () => AsyncIterableIterator<[string, DirectoryHandle | FileHandle]>;
  kind: "directory";
}

interface FileHandle {
  getFile: () => Promise<File>;
  kind: "file";
}

async function markdownFilesFromHandle(
  root: DirectoryHandle
): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  const visit = async (
    directory: DirectoryHandle,
    prefix: string
  ): Promise<void> => {
    for await (const [name, handle] of directory.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") await visit(handle, path);
      else if (/\.md(?:own)?$/iu.test(name))
        files.push({ path, text: await (await handle.getFile()).text() });
    }
  };
  await visit(root, "");
  return files;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function summaryLine(summary: Record<string, number>): string {
  const parts: string[] = [];
  for (const key of [
    "create",
    "created",
    "update",
    "updated",
    "skip",
    "skipped",
  ] as const) {
    const n = summary[key];
    if (typeof n === "number" && n > 0) parts.push(`${n} ${key}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "empty";
}

function Note({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className={appSettingsCss.appSettingsNote}>{children}</div>;
}

function ConnectionRow({
  c,
  onToggle,
}: {
  c: ImportConnectionDTO;
  onToggle: (id: string, next: "active" | "paused") => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.connection} data-status={c.status}>
      <span className={styles.connectionLabel}>{`${c.label} · ${c.kind}`}</span>
      <span className={styles.historySub}>
        {`${c.status}${c.principal ? ` · ${c.principal}` : ""}${
          c.lastRunAt ? ` · last run ${relativeTime(c.lastRunAt)}` : ""
        }${c.lastRunError ? ` · ${c.lastRunError}` : ""}`}
      </span>
      <button
        type="button"
        className={vault.denyBtn}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          onToggle(c.connectionId, c.status === "paused" ? "active" : "paused");
        }}
      >
        {c.status === "paused" ? "Resume" : "Pause"}
      </button>
    </div>
  );
}

function DraftSection({
  batch,
  loadRows,
  onPublish,
  onDiscard,
}: {
  batch: ImportBatchDTO;
  loadRows: (batchId: string) => Promise<ImportRowDTO[]>;
  onPublish: (batchId: string) => void;
  onDiscard: (batchId: string) => void;
}): JSX.Element {
  const [rows, setRows] = useState<ImportRowDTO[] | "error" | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    loadRows(batch.batchId)
      .then((r) => live && setRows(r))
      .catch(() => live && setRows("error"));
    return () => {
      live = false;
    };
  }, [batch.batchId, loadRows]);
  return (
    <div className={appSettingsCss.appSettingsSection}>
      <div
        className={vault.label}
      >{`Draft · ${batch.label ?? batch.kind ?? "import"}`}</div>
      <div className={appSettingsCss.appSettingsNote}>
        {`${summaryLine(batch.summary)} · staged ${relativeTime(batch.createdAt)}`}
      </div>
      {rows === "error" ? (
        <Note>Could not load the rows.</Note>
      ) : rows ? (
        <div className={styles.rows}>
          {rows.slice(0, 12).map((row) => (
            <div
              key={`${row.entityType}:${row.externalId}`}
              className={styles.row}
              data-disposition={row.disposition}
            >
              <span className={styles.rowDisposition}>{row.disposition}</span>
              <span
                className={styles.rowId}
              >{`${row.entityType} · ${row.externalId}`}</span>
              {row.note ? (
                <span className={styles.rowNote}>{row.note}</span>
              ) : null}
              <span className={styles.mapping}>{row.mapping}</span>
            </div>
          ))}
          {rows.length > 12 ? (
            <Note>{`…and ${rows.length - 12} more`}</Note>
          ) : null}
        </div>
      ) : null}
      <div className={vault.parkedActions}>
        <button
          type="button"
          className={vault.approveBtn}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onPublish(batch.batchId);
          }}
        >
          Publish
        </button>
        <button
          type="button"
          className={vault.denyBtn}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onDiscard(batch.batchId);
          }}
        >
          Discard
        </button>
      </div>
    </div>
  );
}

/**
 * Import settings pane — the owner file-drop surface over the staging spine,
 * ported to React (issue #325, Phase 3). Drop a file → it stages as a
 * reviewable draft; the owner publishes or discards. File reading happens in
 * React; the gateway I/O (stage/list/rows/publish/discard/connections) is
 * threaded through the vanilla-supplied callbacks. Same `cd-import-*` /
 * `cd-vault-*` classes.
 */
export default function ImportScreen({
  loadData,
  stage,
  loadRows,
  publish,
  discard,
  setConnectionStatus,
  exportPortable,
  showToast,
}: ImportBridgeProps): JSX.Element {
  const [state, setState] = useState<
    ImportData | "loading" | "no-vault" | "error"
  >("loading");
  const [picking, setPicking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const directoryRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(
    (): Promise<void> =>
      loadData()
        .then((data) => setState(data ?? "no-vault"))
        .catch(() => setState("error")),
    [loadData]
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPicking(true);
    const ext = file.name.split(".").at(-1)?.toLowerCase() ?? "";
    void (async () => {
      try {
        const payload = TEXT_KINDS.has(ext)
          ? { filename: file.name, text: await file.text() }
          : {
              filename: file.name,
              base64: btoa(
                Array.from(new Uint8Array(await file.arrayBuffer()), (b) =>
                  String.fromCharCode(b)
                ).join("")
              ),
            };
        const total = await stage(payload);
        showToast?.(
          `Staged ${total} row${total === 1 ? "" : "s"} — review below`
        );
        await reload();
      } catch (error) {
        showToast?.(error instanceof Error ? error.message : "Import failed");
      } finally {
        setPicking(false);
      }
    })();
  };

  const stageDirectory = (
    directoryName: string,
    files: { path: string; text: string }[]
  ): void => {
    setPicking(true);
    void stage({ directoryName, files })
      .then(async (total) => {
        showToast?.(
          `Staged ${total} note${total === 1 ? "" : "s"} — review mappings below`
        );
        await reload();
      })
      .catch((error: unknown) =>
        showToast?.(
          error instanceof Error ? error.message : "Directory import failed"
        )
      )
      .finally(() => setPicking(false));
  };

  const chooseDirectory = (): void => {
    const picker = (
      window as Window & {
        showDirectoryPicker?: () => Promise<DirectoryHandle>;
      }
    ).showDirectoryPicker;
    if (!picker) {
      directoryRef.current?.click();
      return;
    }
    setPicking(true);
    void picker()
      .then(async (handle) => {
        const files = await markdownFilesFromHandle(handle);
        setPicking(false);
        stageDirectory(handle.name, files);
      })
      .catch((error: unknown) => {
        setPicking(false);
        if (!(error instanceof DOMException && error.name === "AbortError"))
          showToast?.(
            error instanceof Error ? error.message : "Directory import failed"
          );
      });
  };

  const act = (
    run: () => Promise<void>,
    okMsg: string,
    failMsg: string
  ): void => {
    run()
      .then(() => {
        showToast?.(okMsg);
        return reload();
      })
      .catch((error: unknown) => {
        showToast?.(error instanceof Error ? error.message : failMsg);
        void reload();
      });
  };

  if (state === "loading") {
    return <Note>Loading…</Note>;
  }
  if (state === "no-vault") {
    return (
      <Note>No vault is mounted on this gateway — nothing to import into.</Note>
    );
  }
  if (state === "error") {
    return <Note>Could not read the import surface.</Note>;
  }

  const live = state.connections.filter((c) => !c.kind.startsWith("file."));
  const drafts = state.batches.filter((b) => b.status === "draft");
  const settled = state.batches.filter((b) => b.status !== "draft").slice(0, 8);

  return (
    <>
      <div className={appSettingsCss.appSettingsSection}>
        <div className={vault.label}>{`Import into · ${state.vaultName}`}</div>
        <Note>
          Calendar (.ics), contacts (.vcf), mail (.mbox), bank statements
          (.csv), Markdown notes (.md), or a Google Takeout (.zip). Files stage
          with mapping and conflict previews — validation never changes the
          vault, and nothing lands until you publish.
        </Note>
        <div className={vault.demoActions}>
          <button
            type="button"
            className={vault.grantBtn}
            disabled={picking}
            onClick={() => fileRef.current?.click()}
          >
            Choose a file…
          </button>
          <input
            ref={fileRef}
            type="file"
            className={styles.file}
            accept=".ics,.vcf,.vcard,.mbox,.csv,.md,.markdown,.zip"
            onChange={onFile}
          />
          <button
            type="button"
            className={vault.grantBtn}
            disabled={picking}
            onClick={chooseDirectory}
          >
            Choose a Markdown folder…
          </button>
          <input
            ref={(node) => {
              directoryRef.current = node;
              node?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            className={styles.file}
            accept=".md,.markdown"
            onChange={(event) => {
              const selected = Array.from(event.target.files ?? []);
              if (selected.length === 0) return;
              const files = selected
                .filter((file) => /\.md(?:own)?$/iu.test(file.name))
                .map(async (file) => ({
                  path:
                    (file as File & { webkitRelativePath?: string })
                      .webkitRelativePath || file.name,
                  text: await file.text(),
                }));
              void Promise.all(files).then((ready) =>
                stageDirectory(
                  ready[0]?.path.split("/")[0] ?? "Markdown notes",
                  ready
                )
              );
            }}
          />
        </div>
      </div>

      <div className={appSettingsCss.appSettingsSection}>
        <div className={vault.label}>Take everything with you</div>
        <Note>
          Download a verified bundle with every canonical row, document version,
          folder, tag, content byte, and readable ICS, vCard, CSV, and Markdown
          adapters. The manifest hashes every file.
        </Note>
        <button
          type="button"
          className={vault.grantBtn}
          disabled={picking}
          onClick={() => {
            setPicking(true);
            void exportPortable()
              .then((result) => {
                download(result.blob, result.filename);
                showToast?.("Portable vault export verified and ready");
              })
              .catch((error: unknown) =>
                showToast?.(
                  error instanceof Error ? error.message : "Export failed"
                )
              )
              .finally(() => setPicking(false));
          }}
        >
          Export portable vault…
        </button>
      </div>

      {live.length > 0 ? (
        <div className={appSettingsCss.appSettingsSection}>
          <div className={vault.label}>Connections</div>
          <Note>
            Live sources syncing into this vault. A paused connection never
            runs; needs-auth means the harness is signed into the wrong account.
          </Note>
          {live.map((c) => (
            <ConnectionRow
              key={c.connectionId}
              c={c}
              onToggle={(id, next) => {
                setConnectionStatus(id, next).catch((error: unknown) => {
                  showToast?.(
                    error instanceof Error
                      ? error.message
                      : "Could not update connection"
                  );
                });
              }}
            />
          ))}
        </div>
      ) : null}

      {drafts.map((batch) => (
        <DraftSection
          key={batch.batchId}
          batch={batch}
          loadRows={loadRows}
          onPublish={(id) =>
            act(() => publish(id), "Import published", "Publish failed")
          }
          onDiscard={(id) =>
            act(() => discard(id), "Draft discarded", "Discard failed")
          }
        />
      ))}

      {settled.length > 0 ? (
        <div className={appSettingsCss.appSettingsSection}>
          <div className={vault.label}>History</div>
          {settled.map((batch) => (
            <div key={batch.batchId} className={styles.historyRow}>
              <span>{batch.label ?? batch.kind ?? "?"}</span>
              <span className={styles.historySub}>
                {`${batch.status} · ${summaryLine(batch.summary)} · ${relativeTime(batch.createdAt)}`}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
