// Document content lifecycle (#352): in-place text edits, whole-file
// replacement, and version-history reads/restores. Split out of logic.ts
// purely to keep both files under the file-size cap — same factory pattern,
// closing over app.tsx's own `data`/`refresh` plus logic.ts's own
// `act`/`narrate`/`notice` (passed in, never re-implemented).
import {
  isPendingOffsite,
  stageFileBytes,
  statusLine,
} from "@centraid/design/elements";

import { fmtBytes } from "./format.ts";
import type { DriveDoc, VersionEntry } from "./types.ts";

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

interface HistoryResult {
  versions?: VersionEntry[];
  vaultDenied?: unknown;
}

interface VersionsDeps {
  refresh: () => Promise<void> | void;
  act: (
    action: string,
    input: Record<string, unknown>
  ) => Promise<VaultOutcome | undefined>;
  narrate: (outcome: VaultOutcome | undefined) => boolean;
  notice: (text?: string) => void;
}

export function createVersions({
  refresh,
  act,
  narrate,
  notice,
}: VersionsDeps) {
  // "Replace file…" — any media type, through the same staged-bytes door
  // uploadFiles() uses (#296): no base64 through command JSON, so a
  // 200 MB scan replaces just as well as a 20 KB one.
  async function replaceDocument(doc: DriveDoc, file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      notice(
        `“${file.name}” is ${fmtBytes(file.size)} — files up to 512 MB travel well.`
      );
      return;
    }
    let staged;
    try {
      staged = await stageFileBytes(file);
    } catch {
      notice(`Could not read “${file.name}”.`);
      return;
    }
    const outcome = await act("replace", {
      document_id: doc.document_id,
      staged_sha: staged.sha256,
    });
    if (narrate(outcome)) {
      statusLine(
        isPendingOffsite(staged)
          ? "Replaced locally · new version recorded · pending offsite."
          : "Replaced · new version recorded · receipted."
      );
      await refresh();
    }
  }

  // Restore is itself a new version (rule R3: history only ever grows
  // forward) — a full refresh both updates this doc's current content AND
  // gives the details drawer's history panel a fresh doc.content_id to key
  // its own remount+refetch off of (the same trick QuickLook's stage
  // element uses for the identical reason).
  async function restoreVersion(doc: DriveDoc, contentId: string) {
    const outcome = await act("restore-version", {
      document_id: doc.document_id,
      content_id: contentId,
    });
    if (narrate(outcome)) {
      statusLine("Restored that version · receipted.");
      await refresh();
    }
  }

  // A plain read, never a command (core.link is already the durable
  // history) — a denial or a network hiccup both just render as "no history
  // available" rather than throwing through the caller.
  async function loadHistory(documentId: string): Promise<HistoryResult> {
    try {
      return await window.centraid.read<HistoryResult>({
        query: "history",
        input: { document_id: documentId },
      });
    } catch {
      return { versions: [] };
    }
  }

  return { replaceDocument, restoreVersion, loadHistory };
}
