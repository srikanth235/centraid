// Document content lifecycle (issue #352): in-place text edits, whole-file
// replacement, and version-history reads/restores. Split out of logic.js
// purely to keep both files under the file-size cap — same factory pattern,
// closing over app.jsx's own `data`/`refresh` plus logic.js's own
// `act`/`narrate`/`notice` (passed in, never re-implemented).
import { stageFileBytes, toast } from './kit.js';
import { fmtBytes } from './format.js';

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

export function createVersions({ data, refresh, act, narrate, notice }) {
  function docById(documentId) {
    return data.documents.find((d) => d.document_id === documentId);
  }

  // The editor's continuous autosave (debounced while typing) is the one
  // high-frequency write path here: on success, patch the already-loaded
  // row's byte_size/updated_at in place rather than a full drive refetch
  // every ~700 keystrokes (the same optimization notes/logic.js's
  // editNoteAutosave makes) — but content_id/content_uri are deliberately
  // left stale until the editor actually closes (app.jsx's
  // closeEditorSafely does one real refresh then): the vault may keep the
  // new version inline (a data: URI) or move it behind the blob route
  // depending on size, and guessing the wrong scheme here would point
  // Download/Quick Look at bytes that don't exist. The caller (Editor.jsx)
  // narrates its own save-state label, so this never touches the notice
  // banner on a routine save.
  async function editDocument(documentId, bodyText) {
    let outcome;
    try {
      outcome = await window.centraid.write({
        action: 'edit',
        input: { document_id: documentId, body_text: bodyText },
      });
    } catch (err) {
      notice(String(err?.message ?? err));
      return undefined;
    }
    if (outcome?.status === 'executed') {
      const doc = docById(documentId);
      if (doc) {
        doc.byte_size = new TextEncoder().encode(bodyText).length;
        doc.updated_at = new Date().toISOString();
      }
    }
    return outcome;
  }

  // "Replace file…" — any media type, through the same staged-bytes door
  // uploadFiles() uses (issue #296): no base64 through command JSON, so a
  // 200 MB scan replaces just as well as a 20 KB one.
  async function replaceDocument(doc, file) {
    if (file.size > MAX_UPLOAD_BYTES) {
      notice(`“${file.name}” is ${fmtBytes(file.size)} — files up to 512 MB travel well.`);
      return;
    }
    let staged;
    try {
      staged = await stageFileBytes(file);
    } catch {
      notice(`Could not read “${file.name}”.`);
      return;
    }
    const outcome = await act('replace', {
      document_id: doc.document_id,
      staged_sha: staged.sha256,
    });
    if (narrate(outcome)) {
      toast('Replaced · new version recorded · receipted.');
      await refresh();
    }
  }

  // Restore is itself a new version (rule R3: history only ever grows
  // forward) — a full refresh both updates this doc's current content AND
  // gives the details drawer's history panel a fresh doc.content_id to key
  // its own remount+refetch off of (the same trick QuickLook's stage
  // element uses for the identical reason).
  async function restoreVersion(doc, contentId) {
    const outcome = await act('restore-version', {
      document_id: doc.document_id,
      content_id: contentId,
    });
    if (narrate(outcome)) {
      toast('Restored that version · receipted.');
      await refresh();
    }
  }

  // A plain read, never a command (core.link is already the durable
  // history) — a denial or a network hiccup both just render as "no history
  // available" rather than throwing through the caller.
  async function loadHistory(documentId) {
    try {
      return await window.centraid.read({ query: 'history', input: { document_id: documentId } });
    } catch {
      return { versions: [] };
    }
  }

  return { editDocument, replaceDocument, restoreVersion, loadHistory };
}
