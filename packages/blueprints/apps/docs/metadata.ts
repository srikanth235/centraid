// Document metadata (issue #352 phase 4): free-form labels through
// core.tag_item/untag_item (the shared "Tags" concept scheme,
// packages/vault/src/commands/tags.ts — additive and idempotent, mirroring
// the photos app's tag-asset/untag-asset actions) and the real activity read
// over consent.provenance that replaces Details.tsx's old synthesized
// created_at/updated_at timeline. Split out of logic.ts purely for file-size
// hygiene — versions.ts/popovers.ts's exact factory pattern: closes over
// app.tsx's own `data`/`refresh` plus logic.ts's own `act`/`narrate`
// (passed in, never re-implemented).
import { toast } from './kit.js';
import type { ActivityEvent, DriveDoc } from './types.ts';

interface ActivityResult {
  events?: ActivityEvent[];
  vaultDenied?: unknown;
}

interface MetadataDeps {
  refresh: () => Promise<void> | void;
  act: (action: string, input: Record<string, unknown>) => Promise<VaultOutcome | undefined>;
  narrate: (outcome: VaultOutcome | undefined) => boolean;
}

export function createMetadata({ refresh, act, narrate }: MetadataDeps) {
  async function addTag(doc: DriveDoc, label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    const outcome = await act('tag', { document_id: doc.document_id, label: trimmed });
    if (narrate(outcome)) {
      toast(`Tagged “${trimmed}” · receipted.`);
      await refresh();
    }
  }

  async function removeTag(_doc: DriveDoc, tagId: string) {
    const outcome = await act('untag', { tag_id: tagId });
    if (narrate(outcome)) {
      toast('Tag removed · receipted.');
      await refresh();
    }
  }

  // A plain read (no command fabricates history) — a denial or a network
  // hiccup both render as an honest "no activity" empty state rather than
  // throwing through the caller, exactly like versions.ts's loadHistory.
  async function loadActivity(documentId: string): Promise<ActivityResult> {
    try {
      return await window.centraid.read<ActivityResult>({
        query: 'activity',
        input: { document_id: documentId },
      });
    } catch {
      return { events: [] };
    }
  }

  return { addTag, removeTag, loadActivity };
}
