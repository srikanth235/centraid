import { applyInOrder } from "./dom.js";
import { armConfirm } from "./feedback.js";
import type { VaultOutcome } from "./feedback.js";
import { fmtBytes } from "./formatters.js";
import type { StagedBlob } from "./host.js";
import { host } from "./host.js";

export type { StagedBlob } from "./host.js";

export interface Attachment {
  attachment_id: string;
  content_id?: string;
  media_type?: string;
  title?: string | null;
  content_uri?: string;
  byte_size?: number;
  [key: string]: unknown;
}

export const INLINE_ATTACH_BYTES = 256 * 1024;

export function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.addEventListener("load", () => resolve(String(r.result)), {
      once: true,
    });
    r.addEventListener(
      "error",
      () => reject(r.error ?? new Error("Unable to read file")),
      { once: true }
    );
    r.readAsDataURL(file);
  });
}

export function isPendingOffsite(
  staged: StagedBlob | null | undefined
): boolean {
  return (
    staged?.casAck === "replicated" &&
    staged?.custody !== "replicated" &&
    staged?.custody !== "remote-only"
  );
}

export async function stageFileBytes(
  file: File,
  extra = "",
  options: { hash?: boolean; scope?: string } = {}
): Promise<StagedBlob> {
  const stage = host()?.stageBlob;
  if (!stage) throw new Error("This host cannot stage vault bytes.");
  return stage(file, extra, options);
}

export async function stageDerivative(
  parentSha: string,
  variant: string,
  body: BodyInit,
  mediaType = "application/octet-stream"
): Promise<StagedBlob> {
  const stage = host()?.stageDerivative;
  if (!stage) throw new Error("This host cannot stage vault bytes.");
  return stage(parentSha, variant, body, mediaType);
}

const stripObjectUrls = new WeakMap<HTMLElement, string[]>();
const stripGeneration = new WeakMap<HTMLElement, number>();

function revokeObjectUrl(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Intentionally empty.
  }
}

function authorizeStrip(stripEl: HTMLElement, generation: number): void {
  const blobUrl = host()?.blobUrl;
  if (!blobUrl) return;
  const created: string[] = [];
  stripObjectUrls.set(stripEl, created);
  const targets: Element[] = [
    ...stripEl.querySelectorAll("img"),
    ...stripEl.querySelectorAll("a"),
  ];
  for (const target of targets) {
    const attr = target instanceof HTMLImageElement ? "src" : "href";
    const raw = target.getAttribute(attr);
    if (!raw?.startsWith("/")) continue;
    void blobUrl(raw).then((objectUrl) => {
      if (!objectUrl) return;
      if (stripGeneration.get(stripEl) !== generation || !target.isConnected) {
        revokeObjectUrl(objectUrl);
        return;
      }
      target.setAttribute(attr, objectUrl);
      created.push(objectUrl);
    });
  }
}

export function renderAttachments(
  stripEl: HTMLElement,
  list: Attachment[] | null | undefined,
  onRemove:
    | ((attachmentId: string) => Promise<VaultOutcome | undefined>)
    | null,
  { onZoom }: { onZoom?: (attachment: Attachment) => void } = {}
): void {
  for (const url of stripObjectUrls.get(stripEl) ?? []) revokeObjectUrl(url);
  stripObjectUrls.delete(stripEl);
  const generation = (stripGeneration.get(stripEl) ?? 0) + 1;
  stripGeneration.set(stripEl, generation);

  const armed = new Set(
    [
      ...stripEl.querySelectorAll<HTMLElement>(
        '.kit-attach-remove[data-kit-armed="true"]'
      ),
    ].map((b) => b.dataset.kitAttachmentId)
  );
  stripEl.innerHTML = "";
  for (const a of list ?? []) {
    const tile = document.createElement("div");
    tile.className = "kit-attach-tile";
    if (String(a.media_type).startsWith("image/")) {
      const img = document.createElement("img");
      img.src = a.content_uri ?? "";
      img.alt = a.title ?? "attachment";
      if (onZoom) {
        img.className = "kit-attach-zoom";
        img.addEventListener("click", () => onZoom(a));
      }
      tile.appendChild(img);
    } else {
      const link = document.createElement("a");
      link.className = "kit-attach-file";
      link.href = a.content_uri ?? "";
      link.download = a.title ?? "file";
      link.textContent = (a.title ?? a.media_type ?? "file").slice(0, 24);
      tile.appendChild(link);
    }
    const meta = document.createElement("span");
    meta.className = "kit-attach-meta";
    meta.textContent = fmtBytes(a.byte_size);
    tile.appendChild(meta);
    if (onRemove) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "kit-attach-remove";
      rm.textContent = "×";
      rm.title = "Remove";
      rm.setAttribute("aria-label", "Remove attachment");
      rm.dataset.kitAttachmentId = String(a.attachment_id);
      rm.addEventListener("click", () => {
        void (async () => {
          if (!armConfirm(rm, { armedLabel: "Sure?" })) return;
          const outcome = await onRemove(a.attachment_id);
          if (outcome?.status === "executed") tile.remove();
        })();
      });
      if (armed.has(String(a.attachment_id)))
        armConfirm(rm, { armedLabel: "Sure?" });
      tile.appendChild(rm);
    }
    stripEl.appendChild(tile);
  }
  authorizeStrip(stripEl, generation);
}

export function wireAttachInput(
  inputEl: HTMLInputElement,
  getSubjectId: () => string | null | undefined,
  {
    act,
    narrate,
    notice,
    refresh,
  }: {
    act: (
      action: string,
      input: Record<string, unknown>
    ) => Promise<VaultOutcome | undefined>;
    narrate: (outcome: VaultOutcome | undefined) => boolean;
    notice?: (text: string) => void;
    refresh?: () => void | Promise<void>;
  }
): void {
  inputEl.addEventListener("change", () => {
    void (async () => {
      const subjectId = getSubjectId();
      if (!subjectId) return;
      let narrating = true;
      await applyInOrder([...(inputEl.files ?? [])], async (file) => {
        if (!narrating) return;
        let input: Record<string, unknown>;
        let custodyReceipt: StagedBlob | undefined;
        try {
          if (file.size > INLINE_ATTACH_BYTES) {
            const staged = await stageFileBytes(file);
            custodyReceipt = staged;
            input = {
              subject_id: subjectId,
              staged_sha: staged.sha256,
              title: file.name,
            };
          } else {
            const dataUri = await fileToDataUri(file);
            input = {
              subject_id: subjectId,
              data_uri: dataUri,
              title: file.name,
            };
          }
        } catch {
          notice?.("Could not read that file.");
          return;
        }
        const outcome = await act("attach", input);
        if (
          outcome?.status === "executed" &&
          isPendingOffsite(custodyReceipt)
        ) {
          notice?.("Attached locally · waiting for offsite custody.");
        }
        narrating = narrate(outcome);
      });
      inputEl.value = "";
      await refresh?.();
    })();
  });
}
