import { statusLine } from "@centraid/design/elements";

import type { ActivityEvent, DriveDoc } from "./types.ts";

interface ActivityResult {
  events?: ActivityEvent[];
  vaultDenied?: unknown;
}

interface MetadataDeps {
  refresh: () => Promise<void> | void;
  act: (
    action: string,
    input: Record<string, unknown>
  ) => Promise<VaultOutcome | undefined>;
  narrate: (outcome: VaultOutcome | undefined) => boolean;
}

export function createMetadata({ refresh, act, narrate }: MetadataDeps) {
  async function addTag(doc: DriveDoc, label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    const outcome = await act("tag", {
      document_id: doc.document_id,
      label: trimmed,
    });
    if (narrate(outcome)) {
      statusLine(`Tagged “${trimmed}” · receipted.`);
      await refresh();
    }
  }

  async function removeTag(_doc: DriveDoc, tagId: string) {
    const outcome = await act("untag", { tag_id: tagId });
    if (narrate(outcome)) {
      statusLine("Tag removed · receipted.");
      await refresh();
    }
  }

  async function loadActivity(documentId: string): Promise<ActivityResult> {
    try {
      return await window.centraid.read<ActivityResult>({
        query: "activity",
        input: { document_id: documentId },
      });
    } catch {
      return { events: [] };
    }
  }

  return { addTag, removeTag, loadActivity };
}
