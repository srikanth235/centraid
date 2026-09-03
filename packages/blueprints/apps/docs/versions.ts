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
