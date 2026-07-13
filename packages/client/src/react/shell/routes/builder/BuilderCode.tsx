// governance: allow-repo-hygiene file-size-limit (#363) single cohesive builder-tab panel (code editor surface); splitting would fragment one visual unit
import { type JSX, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readAppFiles, writeAppFile } from '../../../../gateway-client.js';
import {
  type CodeLang,
  LANG_DISPLAY,
  type TokenClasses,
  formatBytes,
  languageHint,
  tokenize,
} from '../../../../format.js';
import { lineDiff } from '../../../../diff.js';
import { iconSvg } from '../../iconSvg.js';
import { showToast } from '../../toast.js';
import { cx } from '../../../ui/cx.js';
import buttonCss from '../../../ui/Button.module.css';
import atomsCss from '../../../styles/atoms.module.css';
import styles from './BuilderCode.module.css';

// File-tree glyphs copied verbatim from the vanilla builder (builder.ts
// ~110-113). Small enough to inline; emitted as HTML strings for the
// tree's chevron/folder spans.
const ChevronIcon = (size = 12): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
const FolderIcon = (size = 14): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;

// Module-scoped span classes for the syntax highlighter — keeps tokenize()'s
// emitted HTML inside this module's scope instead of global `tok-*` names.
const TOKEN_CLASSES: TokenClasses = {
  attr: styles.tokAttr ?? '',
  com: styles.tokCom ?? '',
  key: styles.tokKey ?? '',
  str: styles.tokStr ?? '',
  tag: styles.tokTag ?? '',
};

export interface BuilderCodeProps {
  appId: string;
  /** Bumps when the agent writes files (turn finished) — refetch the tree/file. */
  reloadNonce: number;
}

interface CodeBuffer {
  original: string;
  current: string;
  language: CodeLang;
}

type AppFile = { path: string; content: string };

type TreeNode = {
  name: string;
  path: string; // full path (matches files[].path for files)
  kind: 'file' | 'folder';
  children: TreeNode[];
};

// Walk each file's path segments, lazily creating folder nodes. Folder
// nodes are sorted before files at every level — Lovable does this.
function buildTree(files: AppFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const f of files) {
    const parts = f.path.split('/');
    let level = root;
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      acc = acc ? `${acc}/${part}` : part;
      const isFile = i === parts.length - 1;
      let node = level.find((n) => n.name === part);
      if (!node) {
        node = { name: part, path: acc, kind: isFile ? 'file' : 'folder', children: [] };
        level.push(node);
      }
      level = node.children;
    }
  }
  const sortLevel = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) sortLevel(n.children);
  };
  sortLevel(root);
  return root;
}

// Pure filter — returns a copy of the tree containing only nodes whose path
// matches the (lowercased) query, plus their ancestors. Folders along the
// way are collected into `expandOut` so matches stay visible.
function filterTree(nodes: TreeNode[], q: string, expandOut: Set<string>): TreeNode[] {
  if (!q) return nodes;
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'file') {
      if (n.path.toLowerCase().includes(q)) out.push(n);
    } else {
      const kids = filterTree(n.children, q, expandOut);
      if (kids.length > 0 || n.path.toLowerCase().includes(q)) {
        expandOut.add(n.path);
        out.push({ ...n, children: kids });
      }
    }
  }
  return out;
}

const basename = (p: string): string => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);

const BACKEND_DIRS = new Set(['actions', 'queries', 'migrations', 'automations']);

export default function BuilderCode({ appId, reloadNonce }: BuilderCodeProps): JSX.Element {
  const [files, setFiles] = useState<AppFile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Record<string, CodeBuffer>>({});
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | undefined>(undefined);
  const [diffMode, setDiffMode] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [caret, setCaret] = useState<{ line: number; col: number }>({ line: 1, col: 1 });
  const [menuOpen, setMenuOpen] = useState(false);

  // Refs mirror the latest state for use inside async/imperative callbacks
  // that must not close over stale values.
  const filesRef = useRef(files);
  filesRef.current = files;
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;

  // Editor DOM refs — the transparent textarea over a tokenized <pre> is
  // legitimately imperative (scroll-sync + caret restore live on refs).
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const gutterInnerRef = useRef<HTMLDivElement | null>(null);
  // Set after a Tab-insert so a layout effect can restore the caret once the
  // controlled value re-renders.
  const pendingCaret = useRef<number | null>(null);

  const openFile = useCallback((p: string): void => {
    setBuffers((prev) => {
      if (prev[p]) return prev;
      const f = filesRef.current.find((x) => x.path === p);
      if (!f) return prev;
      return {
        ...prev,
        [p]: { original: f.content, current: f.content, language: languageHint(p) },
      };
    });
    setOpenTabs((prev) => (prev.includes(p) ? prev : [...prev, p]));
    setActivePath(p);
  }, []);

  // Fetch the file list on mount, app switch, and each agent-write nonce bump.
  useEffect(() => {
    if (!appId) {
      setFiles([]);
      setLoaded(true);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const fs = await readAppFiles({ id: appId });
        if (cancelled) return;
        setFiles(fs);
        setLoadError(null);
        setLoaded(true);
      } catch (err) {
        if (cancelled) return;
        setLoadError(String(err));
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appId, reloadNonce]);

  // Reconcile buffers/tabs/active against the freshest on-disk bytes.
  useEffect(() => {
    if (files.length === 0) return;
    setBuffers((prev) => {
      const next = { ...prev };
      // Sync clean buffers to fresh bytes; leave dirty buffers untouched so
      // unsaved edits are never clobbered.
      for (const f of files) {
        const buf = next[f.path];
        if (buf && buf.current === buf.original) {
          next[f.path] = { ...buf, original: f.content, current: f.content };
        }
      }
      // Drop buffers whose file no longer exists on disk.
      for (const p of Object.keys(next)) {
        if (!files.some((f) => f.path === p)) delete next[p];
      }
      return next;
    });
    // Drop tabs whose file no longer exists.
    setOpenTabs((prev) => prev.filter((p) => files.some((f) => f.path === p)));

    let ap = activePathRef.current;
    if (!ap || !files.some((f) => f.path === ap)) {
      ap = files.find((f) => f.path === 'index.html')?.path ?? files[0]!.path;
    }
    openFile(ap);

    // Folders containing the active file start expanded.
    setExpanded((prev) => {
      const nextSet = new Set(prev);
      const parts = (ap ?? '').split('/');
      let acc = '';
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
        nextSet.add(acc);
      }
      return nextSet;
    });
  }, [files, openFile]);

  // Close the overflow menu on any outside click (capture, like the vanilla).
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (): void => setMenuOpen(false);
    document.addEventListener('click', onDoc, { capture: true });
    return () => document.removeEventListener('click', onDoc, { capture: true });
  }, [menuOpen]);

  // Restore the caret after a Tab-insert re-render.
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const ta = taRef.current;
    if (ta) {
      ta.selectionStart = pendingCaret.current;
      ta.selectionEnd = pendingCaret.current;
    }
    pendingCaret.current = null;
  });

  const activeBuf = activePath ? buffers[activePath] : undefined;

  const dirtyPaths = (): string[] =>
    Object.entries(buffers)
      .filter(([, b]) => b.current !== b.original)
      .map(([p]) => p);

  const saveFile = useCallback(
    async (p: string): Promise<void> => {
      const buf = buffersRef.current[p];
      if (!buf || buf.current === buf.original) return;
      try {
        await writeAppFile({ id: appId, path: p, content: buf.current });
        setBuffers((prev) => {
          const cur = prev[p];
          if (!cur) return prev;
          return { ...prev, [p]: { ...cur, original: cur.current } };
        });
        showToast(`Saved ${basename(p)}`);
      } catch (err) {
        showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [appId],
  );

  const saveAll = useCallback(async (): Promise<void> => {
    for (const p of Object.entries(buffersRef.current)
      .filter(([, b]) => b.current !== b.original)
      .map(([p]) => p)) {
      await saveFile(p);
    }
  }, [saveFile]);

  const revertActive = (): void => {
    const p = activePathRef.current;
    if (!p) return;
    setBuffers((prev) => {
      const cur = prev[p];
      if (!cur) return prev;
      return { ...prev, [p]: { ...cur, current: cur.original } };
    });
  };

  const closeTab = (p: string): void => {
    const idx = openTabsRef.current.indexOf(p);
    if (idx < 0) return;
    const nextTabs = openTabsRef.current.filter((x) => x !== p);
    setOpenTabs(nextTabs);
    setBuffers((prev) => {
      const next = { ...prev };
      delete next[p];
      return next;
    });
    if (activePathRef.current === p) {
      const na = nextTabs[Math.max(0, idx - 1)];
      setActivePath(na);
      if (na) openFile(na);
    }
  };

  const refreshCaret = (ta: HTMLTextAreaElement): void => {
    const upto = ta.value.slice(0, ta.selectionStart);
    const nl = upto.lastIndexOf('\n');
    setCaret({ line: upto.split('\n').length, col: ta.selectionStart - (nl + 1) + 1 });
  };

  const onEditorChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const p = activePathRef.current;
    if (!p) return;
    const value = e.target.value;
    setBuffers((prev) => {
      const cur = prev[p];
      if (!cur) return prev;
      return { ...prev, [p]: { ...cur, current: value } };
    });
    refreshCaret(e.target);
  };

  const onEditorScroll = (e: React.UIEvent<HTMLTextAreaElement>): void => {
    const ta = e.currentTarget;
    if (preRef.current) {
      preRef.current.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    }
    if (gutterInnerRef.current) {
      gutterInnerRef.current.style.transform = `translateY(${-ta.scrollTop}px)`;
    }
  };

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const p = activePathRef.current;
    if (!p) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const s = ta.selectionStart;
      const eEnd = ta.selectionEnd;
      const value = ta.value;
      const next = value.slice(0, s) + '  ' + value.slice(eEnd);
      pendingCaret.current = s + 2;
      setBuffers((prev) => {
        const cur = prev[p];
        if (!cur) return prev;
        return { ...prev, [p]: { ...cur, current: next } };
      });
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveFile(p);
    }
  };

  // ---- Empty / error states (workspace only; tree stays empty) ----
  let workspaceBody: JSX.Element;
  if (!appId) {
    workspaceBody = <div className={atomsCss.empty}>No app yet.</div>;
  } else if (loadError) {
    workspaceBody = <div className={atomsCss.empty}>Could not read files: {loadError}</div>;
  } else if (loaded && files.length === 0) {
    workspaceBody = <div className={atomsCss.empty}>Empty app.</div>;
  } else if (!activeBuf) {
    workspaceBody = <div className={atomsCss.empty}>No file open.</div>;
  } else {
    workspaceBody = renderWorkspace();
  }

  return (
    <div className={styles.pane}>
      <div className={styles.tree}>{files.length > 0 ? renderTree() : null}</div>
      <div className={styles.workspace}>{workspaceBody}</div>
    </div>
  );

  // ---------- Tree ----------
  function renderTree(): JSX.Element {
    const q = search;
    const expandOut = new Set<string>();
    const tree = buildTree(files);
    const visible = filterTree(tree, q, expandOut);
    const isExpanded = (path: string): boolean => expanded.has(path) || expandOut.has(path);

    const renderRow = (node: TreeNode, depth: number): JSX.Element => {
      if (node.kind === 'folder') {
        const isOpen = isExpanded(node.path);
        return (
          <button
            key={`f:${node.path}`}
            type="button"
            className={cx(styles.treeRow, 'code-tree-folder')}
            data-depth={String(depth)}
            style={{ '--depth': String(depth) } as React.CSSProperties}
            onClick={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                // expandOut may have force-opened it; toggle relative to the
                // effective open state.
                if (isExpanded(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
          >
            <span
              className={styles.treeChevron}
              data-open={String(isOpen)}
              dangerouslySetInnerHTML={{ __html: ChevronIcon(11) }}
            />
            <span
              className={styles.treeIcon}
              dangerouslySetInnerHTML={{ __html: FolderIcon(13) }}
            />
            <span className={styles.treeName}>{node.name}</span>
          </button>
        );
      }
      const lang = languageHint(node.path);
      const buf = buffers[node.path];
      const isDirty = !!buf && buf.current !== buf.original;
      return (
        <button
          key={`p:${node.path}`}
          type="button"
          className={cx(styles.treeRow, 'code-tree-file')}
          data-active={String(activePath === node.path)}
          data-dirty={String(isDirty)}
          data-depth={String(depth)}
          style={{ '--depth': String(depth) } as React.CSSProperties}
          onClick={() => {
            openFile(node.path);
            setDiffMode(false);
          }}
        >
          <span className={styles.treeChevronSpacer} />
          <span className={styles.treeLangDot} data-lang={lang} />
          <span className={styles.treeName}>{node.name}</span>
          {isDirty ? <span className={styles.treeDirty} /> : null}
        </button>
      );
    };

    const walk = (nodes: TreeNode[], depth: number): JSX.Element[] => {
      const out: JSX.Element[] = [];
      for (const n of nodes) {
        out.push(renderRow(n, depth));
        if (n.kind === 'folder' && isExpanded(n.path)) {
          out.push(...walk(n.children, depth + 1));
        }
      }
      return out;
    };

    // Split root-level entries into Frontend and Backend (reserved server-side
    // folders). Section headers appear only when both groups are populated and
    // no search is active.
    const backend = visible.filter((n) => n.kind === 'folder' && BACKEND_DIRS.has(n.name));
    const frontend = visible.filter((n) => !backend.includes(n));
    const showHeaders = !q && frontend.length > 0 && backend.length > 0;

    const groupHead = (label: string, count: number): JSX.Element => (
      <div className={styles.treeGroupHead} key={`h:${label}`}>
        <span>{label}</span>
        <span className={styles.treeGroupCount}>{String(count)}</span>
      </div>
    );

    return (
      <>
        <div className={styles.search}>
          <span
            className={styles.searchIcon}
            dangerouslySetInnerHTML={{ __html: iconSvg('Search', 13) }}
          />
          <input
            className={styles.searchInput}
            placeholder="Search code"
            value={search}
            onChange={(e) => setSearch(e.target.value.trim().toLowerCase())}
          />
          <span className={styles.searchKbd}>⌘P</span>
        </div>
        <div className={styles.treeList}>
          {showHeaders ? groupHead('Frontend', frontend.length) : null}
          {walk(frontend, 0)}
          {backend.length > 0 ? (showHeaders ? groupHead('Backend', backend.length) : null) : null}
          {backend.length > 0 ? walk(backend, 0) : null}
          {visible.length === 0 ? (
            <div className={cx(atomsCss.empty, styles.treeEmpty)}>No matches</div>
          ) : null}
        </div>
      </>
    );
  }

  // ---------- Workspace (tabs + editor + status) ----------
  function renderWorkspace(): JSX.Element {
    return (
      <>
        <div className={styles.tabs}>
          {renderTabStrip()}
          {renderTabActions()}
        </div>
        <div className={styles.editorHost}>
          {diffMode && activeBuf ? renderDiff(activeBuf) : renderEditor()}
        </div>
        <div className={styles.status}>{renderStatus()}</div>
      </>
    );
  }

  function renderTabStrip(): JSX.Element {
    return (
      <div className={styles.tabStrip}>
        {openTabs.map((p) => {
          const buf = buffers[p];
          const dirty = !!buf && buf.current !== buf.original;
          return (
            <div
              key={p}
              className={styles.tab}
              data-active={String(activePath === p)}
              data-dirty={String(dirty)}
            >
              <span className={styles.tabDot} data-lang={languageHint(p)} />
              <button
                type="button"
                className={styles.tabLabel}
                title={p}
                onClick={() => {
                  openFile(p);
                  setDiffMode(false);
                }}
              >
                {basename(p)}
              </button>
              <button
                type="button"
                aria-label={`Close ${basename(p)}`}
                className={styles.tabClose}
                title={dirty ? 'Unsaved changes' : 'Close'}
                onClick={() => closeTab(p)}
                dangerouslySetInnerHTML={dirty ? undefined : { __html: iconSvg('X', 11, 2.5) }}
              />
            </div>
          );
        })}
      </div>
    );
  }

  function renderTabActions(): JSX.Element | null {
    const p = activePath;
    const buf = activeBuf;
    if (!p || !buf) return <div className={styles.tabActions} />;
    const dirty = buf.current !== buf.original;
    const nDirty = dirtyPaths().length;
    const isRemote = window.Centraid?.getRuntimeMode() === 'remote';

    return (
      <div className={styles.tabActions}>
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.ghost, buttonCss.sm, styles.tabActionBtn)}
          data-active={String(diffMode)}
          disabled={!dirty}
          title={dirty ? 'Toggle diff against last save' : 'No changes to diff'}
          onClick={() => setDiffMode((v) => !v)}
        >
          Diff
        </button>
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
          disabled={!dirty}
          onClick={() => void saveFile(p)}
        >
          Save
        </button>
        <div className={styles.overflowWrap}>
          <button
            type="button"
            aria-label="More code actions"
            className={cx(buttonCss.btn, buttonCss.ghost, buttonCss.sm, styles.overflowBtn)}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="19" cy="12" r="1.7" />
            </svg>
          </button>
          <div className={styles.overflowMenu} hidden={!menuOpen}>
            <button
              type="button"
              className={styles.overflowItem}
              disabled={nDirty === 0}
              onClick={() => {
                setMenuOpen(false);
                void saveAll();
              }}
            >
              {nDirty > 0 ? `Save all (${nDirty})` : 'Save all'}
            </button>
            <button
              type="button"
              className={styles.overflowItem}
              disabled={!dirty}
              onClick={() => {
                setMenuOpen(false);
                revertActive();
              }}
            >
              Revert this file
            </button>
            {!isRemote ? (
              <button
                type="button"
                className={styles.overflowItem}
                onClick={() => {
                  setMenuOpen(false);
                  void window.CentraidApi.openAppFolder({ id: appId });
                }}
              >
                Open app folder
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  function renderEditor(): JSX.Element {
    const p = activePath;
    const buf = activeBuf;
    if (!p || !buf) return <div className={atomsCss.empty}>No file open.</div>;
    const lang = buf.language;
    const lineCount = buf.current.split('\n').length;
    const lineNums: JSX.Element[] = [];
    for (let i = 1; i <= lineCount; i++) lineNums.push(<div key={i}>{i}</div>);
    return (
      <div className={styles.editor}>
        <div className={styles.editGutter}>
          <div className={styles.editGutterInner} ref={gutterInnerRef}>
            {lineNums}
          </div>
        </div>
        <div className={styles.editSurface}>
          <div className={styles.editPreClip}>
            <pre
              className={styles.editPre}
              ref={preRef}
              dangerouslySetInnerHTML={{
                __html: tokenize(buf.current, lang, TOKEN_CLASSES) + '\n',
              }}
            />
          </div>
          <textarea
            className={styles.editTa}
            ref={taRef}
            spellCheck={false}
            wrap="off"
            value={buf.current}
            onChange={onEditorChange}
            onScroll={onEditorScroll}
            onKeyDown={onEditorKeyDown}
            onKeyUp={(e) => refreshCaret(e.currentTarget)}
            onClick={(e) => refreshCaret(e.currentTarget)}
            onFocus={(e) => refreshCaret(e.currentTarget)}
          />
        </div>
      </div>
    );
  }

  function renderDiff(buf: CodeBuffer): JSX.Element {
    const rows = lineDiff(buf.original, buf.current);
    return (
      <div className={styles.diff}>
        {rows.map((r, i) => {
          const sign = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
          return (
            <div className={styles.diffRow} data-type={r.type} key={i}>
              <span className={styles.diffNum}>{r.aNum ? String(r.aNum) : ''}</span>
              <span className={styles.diffNum}>{r.bNum ? String(r.bNum) : ''}</span>
              <span className={styles.diffSign}>{sign}</span>
              <span className={styles.diffText}>{r.text || ' '}</span>
            </div>
          );
        })}
      </div>
    );
  }

  function renderStatus(): JSX.Element | null {
    const p = activePath;
    const buf = activeBuf;
    if (!p || !buf) return null;
    const lineCount = buf.current.split('\n').length;
    const bytes = new TextEncoder().encode(buf.current).byteLength;
    const nDirty = dirtyPaths().length;
    const lang = languageHint(p);
    return (
      <>
        <span>
          {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {formatBytes(bytes)}
        </span>
        <span className={styles.statusSep}>·</span>
        <span className={styles.statusSave}>
          <span className={styles.statusDot} />
          {nDirty > 0
            ? `autosaving · ${nDirty} unsaved file${nDirty === 1 ? '' : 's'}`
            : 'all saved'}
        </span>
        <span className={styles.statusSpacer} />
        <span>
          line {caret.line} · col {caret.col}
        </span>
        <span className={styles.statusSep}>·</span>
        <span>{LANG_DISPLAY[lang] ?? 'TXT'}</span>
      </>
    );
  }
}
