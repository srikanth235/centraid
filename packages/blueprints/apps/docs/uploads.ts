// The upload RUN: what happens to a batch of files between the picker and the
// drive. `upload.ts` beside this one owns the per-file staging primitive
// (SHA preflight + the PDF text layer); this owns the sequence over it — the
// size refusal, the drawn queue, the serial stage-then-commit, and the account
// of what did not land.
//
// Split out of logic.ts on the exact seam versions.ts / metadata.ts /
// popovers.ts use: a factory closing over the caller's own `state`/`act`/
// `notice`/`render`/`refresh` rather than re-implementing any of them, so
// every outcome still narrates in this app's voice. File-size hygiene is the
// occasion; the reason it is a clean cut is that a batch upload is the one
// write in this app with a lifecycle of its own.

import { isPendingOffsite, statusLine } from "@centraid/design/elements";

import { fmtBytes } from "./format.ts";
import { folderIdFrom } from "./shelves.ts";
import type { AppState, UploadItem } from "./types.ts";
import { stageDocumentFile } from "./upload.ts";

/** Files above this never reach the vault; the queue says so per file. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

interface UploadsDeps {
  state: AppState;
  render: () => void;
  refresh: () => Promise<void> | void;
  act: (
    action: string,
    input: Record<string, unknown>
  ) => Promise<VaultOutcome | undefined>;
  /** logic.ts's own outcome phrasing — never a second copy of it. */
  friendlyOutcome: (outcome: VaultOutcome | undefined) => string | null;
  notice: (text?: string) => void;
}

export function createUploads({
  state,
  render,
  refresh,
  act,
  friendlyOutcome,
  notice,
}: UploadsDeps) {
  // Each file's bytes stage into the vault's CAS via kit stageFileBytes
  // (issue #296); the upload action claims the returned sha — that claim is
  // the receipt.
  async function uploadFiles(fileList: FileList | File[]) {
    if (state.uploading) return;
    const files = [...fileList];
    if (files.length === 0) return;
    const folderId = folderIdFrom(state.shelf);
    const skipped = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
    const accepted = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    const failures: string[] = [];
    if (skipped.length === 1)
      failures.push(
        `“${skipped[0]!.name}” is ${fmtBytes(skipped[0]!.size)} — files up to 512 MB travel well.`
      );
    else if (skipped.length > 1)
      failures.push(`Skipped ${skipped.length} files over 512 MB.`);

    state.uploading = true;
    // THE QUEUE IS DRAWN, not narrated. It used to exist only as the string
    // "Uploading 3 of 12…" replacing itself in a notice bar: a member with one
    // refusal in twelve files learned that three failed and never which three.
    // Seeded with every file this call accepted plus every one it refused
    // outright for size, so the panel accounts for what was handed to it.
    state.uploadQueue = [
      ...accepted.map(
        (f): UploadItem => ({ name: f.name, state: "waiting" as const })
      ),
      ...skipped.map(
        (f): UploadItem => ({
          name: f.name,
          state: "failed" as const,
          reason: `${fmtBytes(f.size)} — over the 512 MB ceiling`,
        })
      ),
    ];
    const mark = (name: string, next: Partial<UploadItem>): void => {
      const item = state.uploadQueue.find(
        (q) => q.name === name && q.state !== "landed" && q.state !== "failed"
      );
      if (item) Object.assign(item, next);
      render();
    };
    let ok = 0;
    let parked = 0;
    let pendingOffsite = 0;
    // The visible progress and consent outcomes are a user-selected sequence;
    // stage and commit each file before moving to the next.
    const uploadNext = async (i: number): Promise<void> => {
      if (i >= accepted.length) return;
      const file = accepted[i]!;
      mark(file.name, { state: "running" });
      let staged;
      try {
        staged = await stageDocumentFile(file);
      } catch {
        failures.push(`Could not read “${file.name}”.`);
        mark(file.name, {
          state: "failed",
          reason: "could not be read from this device",
        });
        return uploadNext(i + 1);
      }
      const outcome = await act("upload", {
        staged_sha: staged.sha256,
        title: file.name,
        ...(folderId == null ? {} : { folder_id: folderId }),
      });
      if (outcome?.status === "executed") {
        if (isPendingOffsite(staged)) pendingOffsite += 1;
        else ok += 1;
        mark(file.name, { state: "landed" });
      } else if (outcome?.status === "parked") {
        parked += 1;
        mark(file.name, { state: "parked" });
      } else {
        const why = friendlyOutcome(outcome) ?? "the upload failed";
        failures.push(`“${file.name}”: ${why}`);
        mark(file.name, { state: "failed", reason: why });
      }
      return uploadNext(i + 1);
    };
    await uploadNext(0);
    state.uploading = false;
    // A CLEAN RUN CLEARS ITSELF; a run with a refusal in it does not. The
    // panel is the only place that says WHICH file did not land and why, so it
    // stays until the member has read it and dismissed it.
    if (!state.uploadQueue.some((q) => q.state === "failed"))
      state.uploadQueue = [];
    render();
    notice(failures.join(" "));
    if (accepted.length > 0) {
      const parts = [`Uploaded ${ok} of ${accepted.length} · receipted.`];
      if (parked > 0) parts.push(`${parked} waiting for approval.`);
      if (pendingOffsite > 0)
        parts.push(`${pendingOffsite} attached locally · pending offsite.`);
      statusLine(parts.join(" "));
    }
    await refresh();
  }

  return { uploadFiles };
}
