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
// blob route (issue #296) loads through the host-aware blob primitive; an inline data: URI (small bodies never
// rewrite to a blob route) decodes directly via format.ts's decodeDataUri —
// `fetch()`-ing a data: URI is blocked by the app's own CSP (`connect-src`
// inherits `default-src 'self'`, and data: isn't 'self'), so that branch is
// load-bearing, not an optimization.
import { useEffect, useMemo, useRef, useState } from "react";

import { loadBlobText } from "../blob-text.ts";
import { DSAVE, refusedStatus, savedStatus } from "../document-copy.ts";
import type { SaveOutcomeId } from "../document-copy.ts";
import { decodeDataUri } from "../format.ts";
import { I } from "../icons.ts";
import type { DriveDoc } from "../types.ts";
import { Icon } from "./Shared.tsx";

import styles from "./Editor.module.css";

type LoadState = "loading" | "ready" | "error";

/**
 * WHICH OF THE SEVEN OUTCOMES A VAULT ANSWER IS (spec §6.3).
 *
 * The vault settles a write into one of six terminal statuses; §6.3 names
 * seven member-facing outcomes. The mapping is one table, here, because the
 * two that are easiest to blur are exactly the two §6.3 insists are different:
 * `parked` is HELD FOR A PERSON ("waiting for approval — it commits the moment
 * she does") and `queued` is HELD FOR A GATEWAY ("it goes the moment the
 * gateway is back"). "This is not the same state as queued", says the spec, of
 * the first — so they get separate rows and separate sentences.
 *
 * The seventh, `nochange`, has no status of its own: it is what a save means
 * when the body is byte-identical to the last one committed, and only the
 * editor can know that.
 */
const OUTCOME_BY_STATUS: Readonly<Record<string, SaveOutcomeId>> = {
  executed: "saved",
  parked: "approval",
  queued: "queued",
  "in-flight": "saving",
  failed: "refused",
  denied: "refused",
};

export function Editor({
  doc,
  narrow,
  registerFlush,
  onClose,
  onSave,
}: {
  doc: DriveDoc;
  /** The compact form factor — the editor goes full-bleed. Carried as a prop
   *  and stamped on this component's own backdrop, never read off a global
   *  state class another module owns (trap #5). */
  narrow: boolean;
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
  // WHICH OF THE SEVEN THE EDITOR IS IN. `null` is the state before anything
  // has been typed or written — not an outcome, and therefore not a sentence:
  // the row says nothing rather than claiming a write that never happened.
  const [outcome, setOutcome] = useState<SaveOutcomeId | null>(null);
  /** The moment the last committed version landed, for §6.3's `saved` line. */
  const [savedAt, setSavedAt] = useState<string | null>(null);
  /** The vault's OWN reason on a refusal. §6.3's whole point about `refused`
   *  is that the rule can be named; naming the wrong rule would be worse. */
  const [refusedReason, setRefusedReason] = useState<string | null>(null);
  const bodyRef = useRef(inline?.text ?? "");
  const lastSavedRef = useRef(inline?.text ?? "");
  const saveTimerRef = useRef(0);
  const savingRef = useRef<Promise<void> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Only the async blob route is loaded here — an inline data: body was already
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
    loadBlobText(doc.content_uri!)
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
      // "A no-op is not a version: nothing was written, and the history is not
      // one entry longer." (§6.3 `nochange`, verbatim.) So an identical body
      // is a REPORTED outcome, not a silent return — the member pressed Save
      // and is owed the answer.
      if (snap === lastSavedRef.current) {
        setOutcome("nochange");
        return;
      }
      setOutcome("saving");
      const written = await onSave(doc.document_id, snap);
      lastSavedRef.current = snap;
      const stillDirty = bodyRef.current !== snap;
      const settled: SaveOutcomeId = written
        ? (OUTCOME_BY_STATUS[written.status] ?? "refused")
        : "refused";
      if (settled === "refused") {
        setRefusedReason(written?.reason ?? written?.message ?? null);
      }
      if (settled === "saved") {
        setSavedAt(new Date().toISOString());
        setOutcome(stillDirty ? "saving" : "saved");
        // Re-armed inline rather than through scheduleSave(): a forward
        // reference between the two trips the compiler's hoisted-context
        // analysis and bails out the whole component; self-recursion doesn't.
        if (stillDirty) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = window.setTimeout(performSave, 700);
        }
      } else {
        setOutcome(settled);
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
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });

  useEffect(() => {
    registerFlush?.(() => flushRef.current());
    return () => clearTimeout(saveTimerRef.current);
  }, [registerFlush]);

  const updateBody = (v: string): void => {
    bodyRef.current = v;
    setBody(v);
    // Typing over any settled outcome puts the editor back in the only state
    // that is true of it: there are changes here and nothing has been
    // committed. Leaving "Saved" on screen over a modified body is the one
    // lie an editor must never tell.
    setOutcome("unsaved");
    setRefusedReason(null);
    scheduleSave();
  };

  // §6.3's state row and commit button, from one record. `null` is "nothing
  // has happened yet", which is not one of the seven and says nothing.
  const state = outcome ? DSAVE[outcome] : null;
  const statusLine =
    outcome === "saved"
      ? savedStatus({
          at: savedAt
            ? new Date(savedAt).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })
            : null,
        })
      : outcome === "refused"
        ? refusedStatus(refusedReason)
        : (state?.status ?? "");

  return (
    <div className={styles.editorBackdrop} data-narrow={String(narrow)}>
      {/* The backdrop's dismiss-on-outside-click is a real button laid under the
          card (the card is `position: relative`), so it has a keyboard
          equivalent — this replaces the old `e.target === e.currentTarget`
          guard on the backdrop div. */}
      <button
        type="button"
        className="kit-modal-scrim"
        aria-label="Dismiss editor"
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
            aria-label="Close editor"
            onClick={onClose}
          >
            <Icon svg={I.close!} />
          </button>
          <span className={styles.editorTitle}>{doc.title ?? "Untitled"}</span>
          <span className={styles.editorSave}>{state?.label ?? ""}</span>
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
        {/* §6.3's foot: the state row, the note, and the one commit — in that
            order, because a member reads which outcome they are in BEFORE they
            decide whether to press anything. */}
        <div className={styles.editorFoot}>
          {state ? (
            <div className={styles.stateRow}>
              <span
                className={styles.stateDot}
                data-net={String(state.net)}
                aria-hidden="true"
              />
              <output className={styles.stateText} aria-live="polite">
                {statusLine}
              </output>
              {/* The inline action §6.3 gives three of the seven. It is drawn
                  only where it can go somewhere: the receipt viewer and the
                  Notifications route are the frame's, not this app's, so the
                  action names the destination and is not a control that would
                  refuse. */}
              {state.action ? (
                <span className={styles.stateAction}>{state.action}</span>
              ) : null}
            </div>
          ) : null}
          {state ? <p className={styles.stateNote}>{state.note}</p> : null}
          {/* "A filled control that cannot be pressed stops being filled."
              (§6.3, verbatim.) `commits` is the single source of both the
              disabled attribute and the fill. */}
          <button
            type="button"
            className={state && !state.commits ? "kit-btn" : "kit-btn primary"}
            disabled={Boolean(state && !state.commits)}
            onClick={() => void flush()}
          >
            {state?.commit ?? DSAVE.unsaved.commit}
          </button>
        </div>
      </dialog>
    </div>
  );
}
