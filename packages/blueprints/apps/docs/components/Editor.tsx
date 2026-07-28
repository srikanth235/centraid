// The in-place text editor overlay for text-editable documents (issue #352,
// media_type LIKE 'text/%' — format.ts's isTextEditable mirrors the vault's
// own precondition exactly, and Details.tsx only ever offers the Edit
// affordance that opens this for a doc that passes it). Mounted keyed by
// document_id at the call site (app.tsx), so opening a different document
// remounts this component fresh — same idiom notes/components/Editor uses
// for its own note_id key. The doc's content_id/content_uri changing
// underneath mid-edit (a save just minted a new version) never remounts
// this component since document_id — the key — never changes, so an
// in-flight draft is never lost to its own autosave.
//
// Body loads once from the CURRENT content_uri at open time, then lives on
// as local, continuously-autosaved state through core.edit_document, the
// same debounce/flush shape notes/components/Editor's performSave/
// scheduleSave/registerFlush established for note bodies. A same-origin
// blob: route (issue #296) fetches; an inline data: URI (small bodies never
// rewrite to a blob route) decodes directly via format.ts's decodeDataUri —
// `fetch()`-ing a data: URI is blocked by the app's own CSP (`connect-src`
// inherits `default-src 'self'`, and data: isn't 'self'), so that branch is
// load-bearing, not an optimization.
import { useEffect, useMemo, useRef, useState } from "react";

import { decodeDataUri, fmtFull } from "../format.ts";
import { I } from "../icons.ts";
import type { DriveDoc } from "../types.ts";
import { Icon } from "./Shared.tsx";

import styles from "./Editor.module.css";

type LoadState = "loading" | "ready" | "error";
type SaveState = "" | "saving" | "saved" | "pending" | "error";

export function Editor({
  doc,
  registerFlush,
  onClose,
  onSave,
}: {
  doc: DriveDoc;
  registerFlush: (fn: () => Promise<void>) => void;
  onClose: () => void;
  onSave: (
    documentId: string,
    body: string
  ) => Promise<VaultOutcome | undefined>;
}) {
  // The inline data: branch is synchronous, so it is decoded during the first
  // render instead of in an effect — the effect below then only owns the async
  // blob: fetch. This derived inline value follows the keyed document's URI;
  // the editor component itself is remounted for a different document.
  const inline = useMemo<{ state: LoadState; text: string } | null>(() => {
    const uri = doc.content_uri;
    if (typeof uri !== "string" || !uri.startsWith("data:")) return null;
    const text = decodeDataUri(uri);
    return text == null
      ? { state: "error", text: "" }
      : { state: "ready", text };
  }, [doc.content_uri]);
  const [body, setBody] = useState(inline?.text ?? "");
  const [loadState, setLoadState] = useState<LoadState>(
    inline?.state ?? "loading"
  );
  const [saveState, setSaveState] = useState<SaveState>("");
  const bodyRef = useRef(inline?.text ?? "");
  const lastSavedRef = useRef(inline?.text ?? "");
  const saveTimerRef = useRef(0);
  const savingRef = useRef<Promise<void> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Only the async blob: route is loaded here — an inline data: body was already
  // decoded above, during the first render.
  useEffect(() => {
    if (inline) return undefined;
    function loaded(text: string) {
      bodyRef.current = text;
      lastSavedRef.current = text;
      setBody(text);
      setLoadState("ready");
    }
    let cancelled = false;
    fetch(doc.content_uri!)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((text) => {
        if (!cancelled) loaded(text);
      })
      .catch(() => {
        if (!cancelled) setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
    // (#360) doc is read once at mount by design (see file header): app.tsx keys this component by document_id, so re-firing when doc's content_uri changes mid-edit would reload over an in-flight draft instead of leaving the autosave in control
  }, [inline, doc.content_uri]);

  useEffect(() => {
    if (loadState === "ready") textareaRef.current?.focus();
  }, [loadState]);

  // Declared as consts, in dependency order: `function` declarations that
  // reference each other are hoisted, and the React compiler bails out of the
  // whole component when it has to rewrite a hoisted reference (#573).
  const performSave = async (): Promise<void> => {
    if (savingRef.current) return savingRef.current;
    const p = (async () => {
      const snap = bodyRef.current;
      if (snap === lastSavedRef.current) return;
      setSaveState("saving");
      const outcome = await onSave(doc.document_id, snap);
      lastSavedRef.current = snap;
      const stillDirty = bodyRef.current !== snap;
      if (outcome?.status === "executed") {
        setSaveState(stillDirty ? "saving" : "saved");
        // Re-armed inline rather than through scheduleSave(): a forward
        // reference between the two trips the compiler's hoisted-context
        // analysis and bails out the whole component; self-recursion doesn't.
        if (stillDirty) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = window.setTimeout(performSave, 700);
        }
      } else if (outcome?.status === "parked") {
        setSaveState("pending");
      } else {
        setSaveState("error");
      }
    })();
    savingRef.current = p;
    try {
      await p;
    } finally {
      savingRef.current = null;
    }
  };

  const scheduleSave = (): void => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(performSave, 700);
  };

  const flush = async (): Promise<void> => {
    clearTimeout(saveTimerRef.current);
    await performSave();
  };

  // `flush` closes over this render's props and `registerFlush` is a fresh
  // inline arrow from the host, so neither may be an effect dependency: the
  // registration effect below would then re-run on every render and its
  // cleanup would clear the pending autosave timer on every keystroke, which
  // is exactly the debounce it is supposed to leave alone. Latest-value refs
  // keep the registered callback current without re-running the effect.
  const flushRef = useRef(flush);
  const registerFlushRef = useRef(registerFlush);
  useEffect(() => {
    flushRef.current = flush;
    registerFlushRef.current = registerFlush;
  });

  useEffect(() => {
    registerFlushRef.current?.(() => flushRef.current());
    return () => clearTimeout(saveTimerRef.current);
    // (#360) registered once; this component remounts on document_id change (see file header), so the closed-over doc/onSave props flush() reads can never go stale without a fresh registration
  }, []);

  const updateBody = (v: string): void => {
    bodyRef.current = v;
    setBody(v);
    scheduleSave();
  };

  const saveLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "saved"
        ? "Saved · receipt"
        : saveState === "pending"
          ? "Pending approval"
          : saveState === "error"
            ? "Not saved"
            : doc.updated_at
              ? `Edited ${fmtFull(doc.updated_at)}`
              : "";

  return (
    <div className={styles.editorBackdrop}>
      {/* The backdrop's dismiss-on-outside-click is a real button laid under the
          card (the card is `position: relative`), so it has a keyboard
          equivalent — this replaces the old `e.target === e.currentTarget`
          guard on the backdrop div. */}
      <button
        type="button"
        className="kit-modal-scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <dialog
        open
        className={styles.editor}
        aria-modal="true"
        aria-label={`Edit ${doc.title ?? "document"}`}
      >
        <div className={styles.editorTop}>
          <button
            type="button"
            className="kit-icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon svg={I.close!} />
          </button>
          <span className={styles.editorTitle}>{doc.title ?? "Untitled"}</span>
          <span className={styles.editorSave}>{saveLabel}</span>
        </div>
        <div className={styles.editorBody}>
          {loadState === "loading" ? (
            <div className={styles.editorStatus}>Loading…</div>
          ) : loadState === "error" ? (
            <div className={styles.editorStatus}>
              Could not load this document's text.
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              className={styles.editorTextarea}
              aria-label="Document body"
              spellCheck={true}
              value={body}
              onChange={(e) => updateBody(e.target.value)}
              onBlur={flush}
            />
          )}
        </div>
      </dialog>
    </div>
  );
}
