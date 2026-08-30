// Upload pipeline: hash + client thumb staging, then the typed `upload`
// command per file.
import {
  isPendingOffsite,
  stageDerivative,
  stageFileBytes,
} from "@centraid/design/elements";

import {
  captureVideoFrames,
  VIDEO_POSTER_EDGE,
  VIDEO_THUMB_EDGE,
} from "../_shared/video-frame.ts";
import { tallyDedupes } from "./components/Import.tsx";
import type { ImportResult } from "./components/Import.tsx";
import { $ } from "./dom.ts";
import { filesFromDataTransfer } from "./import-drop.ts";
import { act, narrate, notice, writeTarget } from "./outcomes.ts";
import { thumbHashFromImage } from "./thumbhash.ts";

const CLIENT_TINY_EDGE = VIDEO_THUMB_EDGE;
const CLIENT_MEDIUM_EDGE = VIDEO_POSTER_EDGE;

// Matches the blob staging route's own cap; bytes stream there (#296).
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

interface MediaMeta {
  width?: number;
  height?: number;
  duration_s?: number;
  phash?: string;
  thumbhash?: string;
}

// 64-bit dHash (#299 Tier 0): 9×8 grayscale.
export function dHashFromImage(
  img: HTMLImageElement | ImageBitmap
): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 9;
    canvas.height = 8;
    const g = canvas.getContext("2d")!;
    g.drawImage(img, 0, 0, 9, 8);
    const data = g.getImageData(0, 0, 9, 8).data;
    const lum: number[] = [];
    for (let i = 0; i < 72; i += 1) {
      const o = i * 4;
      lum.push(
        0.299 * (data[o] ?? 0) +
          0.587 * (data[o + 1] ?? 0) +
          0.114 * (data[o + 2] ?? 0)
      );
    }
    let hex = "";
    for (let row = 0; row < 8; row += 1) {
      let byte = 0;
      for (let col = 0; col < 8; col += 1) {
        byte =
          (byte << 1) |
          ((lum[row * 9 + col] ?? 0) > (lum[row * 9 + col + 1] ?? 0) ? 1 : 0);
      }
      hex += byte.toString(16).padStart(2, "0");
    }
    return hex;
  } catch {
    return null; // no phash is fewer duplicate hints, never a failed upload
  }
}

// Never upscales; q0.82 matches the gateway codec's ~0.8 band (#405 §2).
async function stageRung(
  bitmap: ImageBitmap,
  parentSha: string,
  edge: number,
  variant: string
): Promise<void> {
  const long = Math.max(bitmap.width, bitmap.height);
  if (long <= edge) return;
  const scale = edge / long;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", 0.82);
  });
  if (!blob) return;
  await stageDerivative(parentSha, variant, blob, "image/jpeg");
}

// Both preview-ladder rungs (#405) off one decode; the backstop fills the rest.
//
// SCOPE NOTE (#599): `stageDerivative` is not scope-addressed, so these rungs
// land in the mount's primary scope even for an audience upload — a missing
// variant, never a leaked image.
//
// Decode via `createImageBitmap(file)`, NEVER `img.src = createObjectURL()`:
// apps run under `img-src 'self' data:`, so a blob-URL <img> is CSP-refused.
async function stageClientPreviews(
  file: File,
  parentSha: string
): Promise<MediaMeta | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const dims =
      bitmap.width > 0 ? { width: bitmap.width, height: bitmap.height } : null;
    const phash = dHashFromImage(bitmap);
    const thumbhash = thumbHashFromImage(bitmap);
    await Promise.allSettled([
      stageRung(bitmap, parentSha, CLIENT_TINY_EDGE, "thumb"),
      stageRung(bitmap, parentSha, CLIENT_MEDIUM_EDGE, "preview"),
      ...(phash
        ? [
            stageDerivative(
              parentSha,
              "phash",
              new Blob([phash]),
              "text/x-perceptual-hash"
            ),
          ]
        : []),
      ...(thumbhash
        ? [
            stageDerivative(
              parentSha,
              "thumbhash",
              new Blob([thumbhash]),
              "application/x-thumbhash"
            ),
          ]
        : []),
    ]);
    bitmap.close();
    const extra: { phash?: string; thumbhash?: string } = {
      ...(phash ? { phash } : {}),
      ...(thumbhash ? { thumbhash } : {}),
    };
    return dims
      ? { ...dims, ...extra }
      : Object.keys(extra).length > 0
        ? extra
        : null;
  } catch {
    return null; // no previews is a slower grid, never a failed upload
  }
}

// Hardware-decode one frame on this device: there is no gateway video decoder.
export async function stageVideoPoster(
  file: File,
  parentSha: string
): Promise<MediaMeta | null> {
  try {
    const captured = await captureVideoFrames(file);
    if (!captured) return null;
    const { width, height, duration, poster, thumb } = captured;
    await Promise.allSettled([
      ...(poster
        ? [stageDerivative(parentSha, "poster", poster, "image/jpeg")]
        : []),
      ...(thumb
        ? [stageDerivative(parentSha, "thumb", thumb, "image/jpeg")]
        : []),
    ]);
    return {
      width,
      height,
      ...(duration === null ? {} : { duration_s: duration }),
    };
  } catch {
    return null;
  }
}

function waitForMedia(
  element: HTMLMediaElement,
  event: string,
  timeoutMs = 12_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeEventListener(event, ready);
      element.removeEventListener("error", failed);
      if (error) reject(error);
      else resolve();
    };
    const ready = () => done();
    const failed = () => done(new Error("media decode failed"));
    const timer = setTimeout(
      () => done(new Error("media metadata timed out")),
      timeoutMs
    );
    element.addEventListener(event, ready, { once: true });
    element.addEventListener("error", failed, { once: true });
  });
}

export async function probeAudio(file: File): Promise<MediaMeta | null> {
  if (!URL?.createObjectURL) return null;
  const audio = document.createElement("audio");
  const url = URL.createObjectURL(file);
  audio.preload = "metadata";
  try {
    audio.src = url;
    audio.load();
    await waitForMedia(audio, "loadedmetadata");
    const duration = Number(audio.duration);
    return Number.isFinite(duration) && duration >= 0
      ? { duration_s: duration }
      : null;
  } catch {
    return null;
  } finally {
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  }
}

const NOTHING_IMPORTED: ImportResult = {
  added: 0,
  deduped: 0,
  restored: 0,
};

export async function runUpload(
  files: File[],
  {
    refresh,
    setUploading,
    wasTrashed,
  }: {
    refresh: () => Promise<void>;
    setUploading: (v: boolean) => void;
    /** Must answer from before the run began — see `tallyDedupes`. */
    wasTrashed: (assetId: string) => boolean;
  }
): Promise<ImportResult> {
  // WHERE the new photos land (#599). Re-checked even though the entry points
  // are disabled: a drop or paste can race the shell revoking write access.
  const target = writeTarget("new");
  if (target.disabled) {
    notice(target.reason);
    return NOTHING_IMPORTED;
  }
  const scope = target.scopeId;
  const oversized = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
  const accepted = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);
  if (accepted.length === 0) {
    notice(
      oversized.length === 1
        ? `Skipped “${oversized[0]!.name}” — each import tops out at 512 MB.`
        : `Skipped ${oversized.length} files — each import tops out at 512 MB.`
    );
    return NOTHING_IMPORTED;
  }

  setUploading(true);
  // Inert, never a progress bar (v4 §14): progress lives on the status line.
  setImportEnabled(false);

  let added = 0;
  // Ids, not a count: "already here" and "restored" share one output and only
  // the id separates them.
  const dedupedIds: string[] = [];
  let parked = 0;
  let pendingOffsite = 0;
  let queued = 0;
  let failed = 0;
  let unreadable = 0;
  let retryable = 0;
  let lastBad: VaultOutcome | undefined = undefined;
  const uploadNext = async (i: number): Promise<void> => {
    const file = accepted[i];
    if (file === undefined) return;
    notice(`Importing ${i + 1} of ${accepted.length}…`);
    let staged;
    try {
      // Bytes go into the SAME scope as the command that claims them.
      staged = await stageFileBytes(file, "", {
        hash: true,
        ...(scope ? { scope } : {}),
      });
    } catch (error) {
      const e = error as { resumable?: boolean };
      if (e?.resumable) retryable += 1;
      else unreadable += 1;
      return uploadNext(i + 1);
    }
    const effectiveType = String(
      file.type || staged.mediaType || ""
    ).toLowerCase();
    const kind = effectiveType.startsWith("video/")
      ? "video"
      : effectiveType.startsWith("audio/")
        ? "audio"
        : "photo";
    const mediaMeta =
      kind === "photo"
        ? await stageClientPreviews(file, staged.sha256)
        : kind === "video"
          ? await stageVideoPoster(file, staged.sha256)
          : await probeAudio(file);
    const outcome = await act(
      "upload",
      {
        staged_sha: staged.sha256,
        kind,
        captured_at: new Date(file.lastModified || Date.now()).toISOString(),
        ...(file.name ? { title: file.name } : {}),
        ...(mediaMeta?.width
          ? { width: mediaMeta.width, height: mediaMeta.height }
          : {}),
        ...(mediaMeta?.duration_s == null
          ? {}
          : { duration_s: mediaMeta.duration_s }),
        ...(mediaMeta?.phash ? { phash: mediaMeta.phash } : {}),
        ...(mediaMeta?.thumbhash ? { thumbhash: mediaMeta.thumbhash } : {}),
      },
      scope
    );
    if (outcome?.status === "executed") {
      // A DEDUPE IS NOT AN ADDITION. These branches stay exclusive, or a run of
      // four already-present files reports four added AND four deduped.
      if (outcome.output?.deduped) {
        dedupedIds.push(String(outcome.output.asset_id ?? ""));
      } else if (isPendingOffsite(staged)) pendingOffsite += 1;
      else added += 1;
    } else if (outcome?.status === "parked") {
      parked += 1;
    } else if (
      outcome?.status === "queued" ||
      outcome?.status === "in-flight"
    ) {
      queued += 1;
    } else {
      failed += 1;
      lastBad = outcome;
    }
    return uploadNext(i + 1);
  };
  await uploadNext(0);

  setUploading(false);
  // Through the target: the selection may have moved to a read-only audience.
  applyUploadTarget();

  const { deduped, restored } = tallyDedupes(dedupedIds, wasTrashed);
  const parts: string[] = [];
  if (added > 0) {
    parts.push(`Added ${added} ${added === 1 ? "photograph" : "photographs"}`);
  }
  if (restored > 0) parts.push(`${restored} restored from the trash`);
  if (deduped > 0) parts.push(`${deduped} already in your library`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (pendingOffsite > 0)
    parts.push(`${pendingOffsite} attached locally · pending offsite`);
  if (queued > 0) parts.push(`${queued} saved offline`);
  if (failed > 0) parts.push(`${failed} refused`);
  if (unreadable > 0) parts.push(`${unreadable} unreadable`);
  if (retryable > 0)
    parts.push(`${retryable} interrupted — add again to resume`);
  if (oversized.length > 0)
    parts.push(`${oversized.length} over the 512 MB cap`);
  notice(parts.join(" · ") || "Nothing added");
  if (lastBad) narrate(lastBad);
  await refresh();
  return { added, deduped, restored };
}

function dragHasFiles(e: DragEvent): boolean {
  return [...(e.dataTransfer?.types ?? [])].includes("Files");
}

// Either can be absent on a render, unlike the static ids `$` asserts non-null.
const IMPORT_CONTROL_IDS = ["uploadBtn", "emptyUpload"] as const;

function importControls(): HTMLButtonElement[] {
  const found: HTMLButtonElement[] = [];
  for (const id of IMPORT_CONTROL_IDS) {
    const btn = $<HTMLButtonElement>(id) as HTMLButtonElement | null;
    if (btn) found.push(btn);
  }
  return found;
}

function setImportEnabled(enabled: boolean): void {
  for (const btn of importControls()) btn.disabled = !enabled;
}

// Called on every toolbar render (#599): a read-only audience refuses up front.
export function applyUploadTarget(): void {
  const target = writeTarget("new");
  const reason = target.disabled ? target.reason : "";
  for (const btn of importControls()) {
    btn.disabled = target.disabled;
    btn.title = reason;
  }
}

/**
 * Wires the import doors and RETURNS ITS OWN TEARDOWN (#883): the `window`
 * listeners below close over the app root's store, its assets and its React
 * roots, so one left registered keeps a closed app's whole detached subtree
 * reachable. The contract is a disposer, not a void.
 */
export function wireUpload({
  uploadFiles,
  isAlbumSelected,
  openPicker,
}: {
  uploadFiles: (files: File[]) => Promise<void> | void;
  isAlbumSelected: () => boolean;
  openPicker: () => void;
}): () => void {
  const onImportClick = (): void => {
    // Inside a real album the natural "add" is from the library, not disk.
    if (isAlbumSelected()) openPicker();
    else $("fileInput").click();
  };
  const onFilesChosen = async (): Promise<void> => {
    const input = $<HTMLInputElement>("fileInput");
    const files = [...input.files!];
    input.value = "";
    await uploadFiles(files);
  };
  const emptyUpload = $("emptyUpload");
  const fileInput = $("fileInput");
  emptyUpload.addEventListener("click", onImportClick);
  fileInput.addEventListener("change", onFilesChosen);

  let dragDepth = 0;

  const onDragEnter = (e: DragEvent): void => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    $("dropOverlay").hidden = false;
  };

  const onDragOver = (e: DragEvent): void => {
    if (dragHasFiles(e)) e.preventDefault();
  };

  const onDragLeave = (e: DragEvent): void => {
    if (!dragHasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $("dropOverlay").hidden = true;
  };

  const onDrop = (e: DragEvent): void => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $("dropOverlay").hidden = true;
    void filesFromDataTransfer(e.dataTransfer).then((files) => {
      if (files.length > 0) void uploadFiles(files);
    });
  };

  const onPaste = (e: ClipboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return; // never hijack a text field
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length > 0) void uploadFiles(files);
  };

  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);
  window.addEventListener("paste", onPaste);

  return () => {
    emptyUpload.removeEventListener("click", onImportClick);
    fileInput.removeEventListener("change", onFilesChosen);
    window.removeEventListener("dragenter", onDragEnter);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("dragleave", onDragLeave);
    window.removeEventListener("drop", onDrop);
    window.removeEventListener("paste", onPaste);
  };
}
