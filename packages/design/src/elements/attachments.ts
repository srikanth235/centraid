// Attachments — the "shared pattern across apps", actually shared.
//
// Small files travel inline as data: URIs through the command JSON; larger
// ones stream to the vault's blob CAS and attach by sha (#296). The
// BYTES leave through the host (`stageBlob`/`stageDerivative`): the app
// document is not the gateway origin — the installable web PWA rides the iroh
// tunnel and desktop runs from `file://` — so a relative `fetch` would resolve
// nowhere and carry no credential. This layer therefore owns the shape of the
// flow (thresholds, hashing, tiles, the attach batch) and none of its
// transport; `packages/client`'s `blob-staging.ts` owns the transport.

import { applyInOrder } from "./dom.js";
import { armConfirm } from "./feedback.js";
import type { VaultOutcome } from "./feedback.js";
import { fmtBytes } from "./formatters.js";
import type { StagedBlob } from "./host.js";
import { host } from "./host.js";

export type { StagedBlob } from "./host.js";

/** One attachment row as the vault's queries return it. */
export interface Attachment {
  attachment_id: string;
  content_id?: string;
  media_type?: string;
  title?: string | null;
  content_uri?: string;
  byte_size?: number;
  [key: string]: unknown;
}

/** Files at or under this size ride inline as a data: URI, with no upload. */
export const INLINE_ATTACH_BYTES = 256 * 1024;

/** Read a File into a data: URI (the inline path for small attachments). */
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

/** Strict policy acknowledges success only after provider custody. */
export function isPendingOffsite(
  staged: StagedBlob | null | undefined
): boolean {
  return (
    staged?.casAck === "replicated" &&
    staged?.custody !== "replicated" &&
    staged?.custody !== "remote-only"
  );
}

/**
 * Stream a File into the vault's blob CAS; resolves the staging receipt
 * (`{sha256, …}`). `extra` appends pre-encoded query params (e.g. `&kind=…`).
 * With `{hash: true}` (the default) the sha is declared up front so the host
 * can preflight it and ship zero bytes when another device already
 * established custody; the gateway still hashes and verifies authoritatively.
 *
 * `scope` (#599) names WHICH mounted scope the bytes land in — a
 * multi-scope app adding to a shared audience must not stage into the
 * member's own CAS.
 */
export async function stageFileBytes(
  file: File,
  extra = "",
  options: { hash?: boolean; scope?: string } = {}
): Promise<StagedBlob> {
  const stage = host()?.stageBlob;
  if (!stage) throw new Error("This host cannot stage vault bytes.");
  return stage(file, extra, options);
}

/** Submit a typed derivative contribution (#299 enrichers). */
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

// The strip's own blob authorization. `inline-blob-images.ts` in the shell
// covers `<img>`/`background-image` generically, but an attachment tile for a
// non-image also renders a download `<a href>`, which that observer does not
// watch — so the strip authorizes its own references after each rebuild.
const stripObjectUrls = new WeakMap<HTMLElement, string[]>();
// The generation is what makes the bookkeeping correct under re-render: a
// strip re-rendered while an authorization is still in flight would otherwise
// let the STALE render's `.then` push into (and re-publish) its own array,
// clobbering the live render's list so those URLs were never revoked. A late
// URL from a superseded render is revoked on arrival instead of recorded.
const stripGeneration = new WeakMap<HTMLElement, number>();

function revokeObjectUrl(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* already revoked */
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
    // Any ROOT-RELATIVE ref, rather than a match on the vault's blob prefix:
    // this layer holds no route vocabulary, and it does not need to — the host
    // answers `null` for a path it does not own, which leaves the tile exactly
    // as rendered. A ref that is already `blob:`, `data:` or absolute is
    // resolvable as-is and is skipped by the same test.
    if (!raw?.startsWith("/")) continue;
    void blobUrl(raw).then((objectUrl) => {
      if (!objectUrl) return;
      // A URL that arrives for a superseded render, or for a tile that has
      // left the document, has no owner to revoke it later — revoke it now.
      if (stripGeneration.get(stripEl) !== generation || !target.isConnected) {
        revokeObjectUrl(objectUrl);
        return;
      }
      target.setAttribute(attr, objectUrl);
      created.push(objectUrl);
    });
  }
}

/**
 * Fill `stripEl` with attachment tiles (image thumb or file link + size
 * badge), then authorise any `/_vault/blobs/…` bytes they point at. The
 * remove control arms on first click (`armConfirm`) and calls
 * `onRemove(attachment_id)`; when that resolves to an executed outcome the
 * tile drops immediately. Pass `onRemove: null` for a read-only strip (no
 * remove control at all). `onZoom(attachment)`, when given, makes image
 * thumbs zoomable.
 */
export function renderAttachments(
  stripEl: HTMLElement,
  list: Attachment[] | null | undefined,
  onRemove:
    | ((attachmentId: string) => Promise<VaultOutcome | undefined>)
    | null,
  { onZoom }: { onZoom?: (attachment: Attachment) => void } = {}
): void {
  // The rebuild below discards the previous render's tiles — and the object
  // URLs they point at — so revoking them here is safe precisely because
  // nothing survives it; this path re-reads every blob ref from `list`, so a
  // re-render always re-authorizes.
  for (const url of stripObjectUrls.get(stripEl) ?? []) revokeObjectUrl(url);
  stripObjectUrls.delete(stripEl);
  const generation = (stripGeneration.get(stripEl) ?? 0) + 1;
  stripGeneration.set(stripEl, generation);

  // An imperative rebuild (any refresh — e.g. the window-focus one) would
  // otherwise wipe an armed remove button mid-confirm: the owner's second
  // click lands on a fresh, disarmed button and merely re-arms it. Carry
  // the armed state across the rebuild (the old node's disarm timer fires
  // on the detached button — a no-op).
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
      // Click listeners must be void: an `async` listener returns a Promise
      // where DOM expects void (`typescript(no-misused-promises)`). Same
      // fire-and-forget shape as `wireAttachInput`.
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

/**
 * Wire a hidden `<input type=file>` to the attach flow: stage-or-inline each
 * picked file, run the app's `attach` action, narrate each outcome. The app
 * supplies its own consent voice: `act(action, input) → outcome`,
 * `narrate(outcome) → bool` (false stops the batch), `notice(text)` for read
 * errors, `refresh()` after the batch.
 */
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
      // Keep attachment requests and consent narration in the chosen-file
      // order; a declined/failed outcome must stop the same batch as before.
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
