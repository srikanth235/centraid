// Document metadata (issue #352 phase 4): free-form labels through
// core.tag_entity/untag_entity (an owner "Labels" concept scheme,
// packages/vault/src/commands/tags.ts — additive and idempotent, mirroring
// the photos app's tag-asset/untag-asset actions) and the real activity read
// over consent.provenance that replaces Details.jsx's old synthesized
// created_at/updated_at timeline. Split out of logic.js purely for file-size
// hygiene — versions.js/popovers.js's exact factory pattern: closes over
// app.jsx's own `data`/`refresh` plus logic.js's own `act`/`narrate`
// (passed in, never re-implemented).
import { toast } from './kit.js';

export function createMetadata({ refresh, act, narrate }) {
  async function addTag(doc, label) {
    const trimmed = label.trim();
    if (!trimmed) return;
    const outcome = await act('tag', { document_id: doc.document_id, label: trimmed });
    if (narrate(outcome)) {
      toast(`Tagged “${trimmed}” · receipted.`);
      await refresh();
    }
  }

  async function removeTag(doc, label) {
    const outcome = await act('untag', { document_id: doc.document_id, label });
    if (narrate(outcome)) {
      toast('Tag removed · receipted.');
      await refresh();
    }
  }

  // A plain read (no command fabricates history) — a denial or a network
  // hiccup both render as an honest "no activity" empty state rather than
  // throwing through the caller, exactly like versions.js's loadHistory.
  async function loadActivity(documentId) {
    try {
      return await window.centraid.read({ query: 'activity', input: { document_id: documentId } });
    } catch {
      return { events: [] };
    }
  }

  return { addTag, removeTag, loadActivity };
}
