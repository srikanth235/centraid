// The inline kit — the shell-side module blueprint apps' `./kit.ts` specifier
// resolves to when a bundled app runs INLINE (see inline-vite-aliases.ts).
//
// It mirrors kit.ts's named-export API exactly so app code is unchanged. The
// large pure surface (DOM helpers, formatters, skeletons, popovers, charts,
// mention UI, …) is re-exported verbatim from the real kit; only the handful of
// exports that reach the network or the served document are overridden to use
// the shell's authenticated gateway client and appearance plane:
//
//   - `renderAttachments`→ authorises `/_vault/blobs` bytes through the gateway
//   - `stageFileBytes` / `stageDerivative`
//                        → blob-CAS uploads through the authed gateway (relative
//                          `fetch` to `/_vault/blobs` does not resolve inline)
//   - `wireAttachInput`  → the attach flow's >256 KiB branch stages through the
//                          authed `stageFileBytes` above (small files still ride
//                          inline as data: URIs through `window.centraid.write`)
//   - `createReference` / `removeReference` / `reanchorReference`
//                        → owner-plane link writes through the authed gateway
//
// `onDataChange` is re-exported verbatim: it already routes through
// `window.centraid.onChange`, which the inline client (centraid-inline.ts) backs
// with a replica-invalidation subscription — so the kit's debounce + table
// filter semantics carry over with no override.
//
// The `./suppress-served-ask` import MUST stay first: kit.ts auto-mounts its Ask
// panel at module-eval time, and the sentinel it sets suppresses that before the
// kit module below is evaluated (see suppress-served-ask.ts).
import "./suppress-served-ask.js";
import {
  fileToDataUri,
  INLINE_ATTACH_BYTES,
  isPendingOffsite,
  renderAttachments as baseRenderAttachments,
  sha256File,
} from "@centraid/design/kit/kit.js";
import type { Attachment, VaultOutcome } from "@centraid/design/kit/kit.js";

import { auth, authHeaders, doFetch } from "../../gateway-client-core.js";
import { authorizeBlobUrl, blobAuthHeaders, BLOB_PREFIX } from "./blob-auth.js";

export * from "@centraid/design/kit/kit.js";
// `authorizeBlobUrl` moved to the leaf `blob-auth.js` module so importing it
// no longer pulls the full kit barrel into a caller's chunk (boot-size fix).
// Re-exported here so served-kit consumers that reach it through the `./kit.ts`
// → kit-inline alias are unchanged.

const LINKS_ROUTE = "/centraid/_vault/links";
type AttachmentLike = Attachment;

// Object URLs this strip owns, plus the render that created them. The
// generation is what makes the bookkeeping correct under re-render: a strip
// re-rendered while an authorization is still in flight would otherwise let the
// STALE render's `.then` push into (and re-publish) its own array, clobbering
// the live render's list so those URLs were never revoked. A late URL from a
// superseded render is revoked on arrival instead of being recorded.
const stripObjectUrls = new WeakMap<HTMLElement, string[]>();
const stripGeneration = new WeakMap<HTMLElement, number>();

function revokeObjectUrl(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* already revoked */
  }
}

/**
 * Render attachment tiles, then authorise any `/_vault/blobs/…` bytes. Inline,
 * those relative URLs do not resolve against the shell origin (and desktop runs
 * from `file://`), so each blob-backed `img`/`a` is refetched through the
 * authenticated gateway client and swapped to a `blob:` object URL.
 *
 * Consumed by blueprint apps through the `./kit.ts` → kit-inline Vite alias
 * (invisible to knip's client-only export graph).
 * @public
 */
export function renderAttachments(
  stripEl: HTMLElement,
  list: AttachmentLike[] | undefined,
  onRemove:
    | ((attachmentId: string) => Promise<VaultOutcome | undefined>)
    | null,
  options: { onZoom?: (attachment: unknown) => void } = {}
): void {
  // `baseRenderAttachments` rebuilds the strip's DOM below, so the previous
  // render's tiles — and the object URLs they point at — are about to be
  // discarded. Revoking them here is safe precisely because nothing survives
  // the rebuild; unlike inline-blob-images, this path re-reads every
  // `/_vault/blobs` ref from `list`, so a re-render always re-authorizes.
  for (const url of stripObjectUrls.get(stripEl) ?? []) revokeObjectUrl(url);
  stripObjectUrls.delete(stripEl);
  const generation = (stripGeneration.get(stripEl) ?? 0) + 1;
  stripGeneration.set(stripEl, generation);
  baseRenderAttachments(stripEl, list, onRemove, options);
  const created: string[] = [];
  stripObjectUrls.set(stripEl, created);
  const targets = [
    ...stripEl.querySelectorAll<HTMLImageElement>("img"),
    ...stripEl.querySelectorAll<HTMLAnchorElement>("a"),
  ];
  for (const el of targets) {
    const attr = el instanceof HTMLImageElement ? "src" : "href";
    const raw = el.getAttribute(attr);
    if (!raw || !raw.startsWith(BLOB_PREFIX)) continue;
    void authorizeBlobUrl(raw).then((objectUrl) => {
      if (!objectUrl) return;
      // A URL that arrives for a superseded render, or for a tile that has left
      // the document, has no owner to revoke it later — revoke it now.
      if (stripGeneration.get(stripEl) !== generation || !el.isConnected) {
        revokeObjectUrl(objectUrl);
        return;
      }
      el.setAttribute(attr, objectUrl);
      created.push(objectUrl);
    });
  }
}

// ---------- Blob CAS uploads (issue #505 Phase 4) ----------
// kit.ts's `stageFileBytes` / `stageDerivative` POST to `/_vault/blobs` with a
// relative `fetch`, which resolves against the served app origin — inline the
// app runs in the shell document (and desktop from `file://`), so those bytes
// must travel through the authed gateway client instead. The wire shape mirrors
// kit.ts exactly (query params, sha-preflight HEAD, `x-content-sha256` header,
// the returned staging receipt). The one deliberate simplification: kit.ts also
// probes optional `session`/`direct` edge-upload routes before the authoritative
// POST; inline we go straight to the authoritative POST (kit.ts documents it as
// "the permanent authoritative POST … the compatibility and backpressure
// fallback"), so dedupe + authoritative hashing semantics are preserved.

/** kit.ts `StagedBlob` — the staging receipt the blob door returns. */
interface StagedBlob {
  sha256: string;
  mediaType?: string | null;
  byteSize?: number;
  existingContentId?: string | null;
  casAck?: string | null;
  custody?: string | null;
  alreadyPresent?: boolean;
  [k: string]: unknown;
}

/**
 * Stream a File to the vault blob-staging route through the authed gateway.
 * Drop-in for kit.ts `stageFileBytes`: same signature, same `sha256`-preflight
 * dedupe (HEAD `…/_sha/<sha>`), same authoritative POST + returned receipt.
 *
 * Consumed by blueprint apps through the `./kit.ts` → kit-inline Vite alias
 * (invisible to knip's client-only export graph).
 * @public
 */
export async function stageFileBytes(
  file: File,
  extra = "",
  { hash = true, scope }: { hash?: boolean; scope?: string } = {}
): Promise<StagedBlob> {
  const { baseUrl, token } = await auth();
  // Bytes land in the scope the caller named, not the focused one (issue #599):
  // an upload aimed at an audience must be staged into THAT vault's CAS.
  const headers = blobAuthHeaders(token, scope);
  const q = new URLSearchParams();
  if (file.name) q.set("filename", file.name);
  if (file.type) q.set("media_type", file.type);
  let declaredSha: string | null = null;
  if (hash) {
    try {
      declaredSha = await sha256File(file);
    } catch {
      declaredSha = null; // hashing is an optimization, never an upload gate
    }
  }
  if (declaredSha) {
    q.set("sha256", declaredSha);
    try {
      const preflight = new URLSearchParams({ byte_size: String(file.size) });
      if (file.type) preflight.set("media_type", file.type);
      if (file.name) preflight.set("filename", file.name);
      const have = await doFetch(
        baseUrl,
        `${BLOB_PREFIX}/_sha/${declaredSha}?${preflight}`,
        {
          method: "HEAD",
          headers,
        }
      );
      if (have.ok) {
        return {
          sha256: declaredSha,
          mediaType:
            have.headers.get("x-centraid-media-type") ?? file.type ?? null,
          byteSize:
            Number(have.headers.get("content-length")) || file.size || 0,
          existingContentId: have.headers.get("x-centraid-content-id"),
          casAck: have.headers.get("x-centraid-cas-ack"),
          custody: have.headers.get("x-centraid-custody"),
          alreadyPresent: true,
        };
      }
    } catch {
      // Older/offline gateways simply take the authoritative POST below.
    }
  }
  const res = await doFetch(baseUrl, `${BLOB_PREFIX}?${q}${extra}`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": file.type || "application/octet-stream",
      ...(declaredSha ? { "x-content-sha256": declaredSha } : {}),
    },
    body: file,
  });
  if (!res.ok) throw new Error(`upload refused (${res.status})`);
  return (await res.json()) as StagedBlob;
}

/**
 * Submit a typed derivative contribution (issue #299 enrichers) through the
 * authed blob door. Drop-in for kit.ts `stageDerivative`.
 * @public
 */
export async function stageDerivative(
  parentSha: string,
  variant: string,
  body: BodyInit,
  mediaType = "application/octet-stream"
): Promise<StagedBlob> {
  const { baseUrl, token } = await auth();
  const q = new URLSearchParams({
    variant,
    variant_of: parentSha,
    media_type: mediaType,
  });
  const res = await doFetch(baseUrl, `${BLOB_PREFIX}?${q}`, {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": mediaType },
    body,
  });
  if (!res.ok)
    throw new Error(`${variant} contribution refused (${res.status})`);
  return (await res.json()) as StagedBlob;
}

interface AttachOutcome {
  status?: string;
  [k: string]: unknown;
}

interface AttachHandlers {
  act: (
    action: string,
    input: Record<string, unknown>
  ) => Promise<AttachOutcome | undefined>;
  narrate: (outcome: AttachOutcome | undefined) => boolean;
  notice?: (text: string) => void;
  refresh?: () => void | Promise<void>;
}

/**
 * Wire a hidden `<input type=file>` to the attach flow. Drop-in for kit.ts
 * `wireAttachInput`: files over `INLINE_ATTACH_BYTES` stage through the authed
 * `stageFileBytes` above (kit.ts's relative POST breaks inline); smaller files
 * still travel inline as data: URIs through the app's `attach` action (which
 * rides `window.centraid.write` — no network fetch, so it already worked).
 * @public
 */
export function wireAttachInput(
  inputEl: HTMLInputElement,
  getSubjectId: () => string | null | undefined,
  { act, narrate, notice, refresh }: AttachHandlers
): void {
  inputEl.addEventListener("change", () => {
    void (async () => {
      const subjectId = getSubjectId();
      if (!subjectId) return;
      const files = Array.from(inputEl.files ?? []);
      // Keep attachment requests and consent narration in the chosen-file
      // order; a declined/failed outcome must stop the same batch as before.
      const attachNext = async (index: number): Promise<void> => {
        const file = files[index];
        if (!file) return;
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
          return attachNext(index + 1);
        }
        const outcome = await act("attach", input);
        if (
          outcome?.status === "executed" &&
          isPendingOffsite(custodyReceipt)
        ) {
          notice?.("Attached locally · waiting for offsite custody.");
        }
        if (narrate(outcome)) return attachNext(index + 1);
      };
      await attachNext(0);
      inputEl.value = "";
      await refresh?.();
    })();
  });
}

// ---------- Owner-plane reference writes (issues #272 + #282) ----------
// kit.ts's createReference / removeReference / reanchorReference POST/DELETE/
// PATCH `/_vault/links` with a relative `fetch` at owner trust; inline they must
// carry the gateway bearer credential. Wire shape mirrors kit.ts exactly,
// including returning the parsed body verbatim (a `VaultOutcome`) without an
// `ok` gate — the vault answers link judgments as `{status}` JSON, so an app's
// narrate/consent path sees the same outcome it did served.

/**
 * Assert a cross-reference link as the owner. Drop-in for kit.ts
 * `createReference`.
 * @public
 */
export async function createReference(
  from: { type: string; id: string },
  to: { type: string; id: string },
  relation: string,
  selector?: unknown
): Promise<unknown> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, LINKS_ROUTE, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({
      from_type: from.type,
      from_id: from.id,
      to_type: to.type,
      to_id: to.id,
      relation: relation || "references",
      ...(selector ? { selector } : {}),
    }),
  });
  return res.json();
}

/** End a link (temporal — the row survives with valid_to set). Drop-in. @public */
export async function removeReference(linkId: string): Promise<unknown> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `${LINKS_ROUTE}/${encodeURIComponent(linkId)}`,
    {
      method: "DELETE",
      headers: authHeaders(token),
    }
  );
  return res.json();
}

/**
 * Move (selector object) or clear (selector null) a live link's standoff
 * anchor. Drop-in for kit.ts `reanchorReference`.
 * @public
 */
export async function reanchorReference(
  linkId: string,
  selector: unknown
): Promise<unknown> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `${LINKS_ROUTE}/${encodeURIComponent(linkId)}`,
    {
      method: "PATCH",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ selector: selector ?? null }),
    }
  );
  return res.json();
}

// RESIDUAL (issue #505 Phase 4): the @-mention picker READ — kit.ts's
// `attachMentionPopover` fetches `/_vault/picker` relatively, and
// `attachMentionField` calls that popover (and the reference writes above)
// through kit.ts's OWN module-local bindings, which the `export *` re-export
// cannot rebind. Overriding the picker therefore means re-implementing the whole
// popover/field UI here, not swapping one fetch. No converted app (tasks/notes/
// docs/locker/photos) wires inline mention AUTHORING today — they only read
// reference cards via their `library`/query modules — so this is deferred. When
// an app does wire inline `@`-mention authoring, port `attachMentionPopover`
// (authed `/_vault/picker` GET) and `attachMentionField` (calling the authed
// reference writes above) into a sibling module and re-export them here.
