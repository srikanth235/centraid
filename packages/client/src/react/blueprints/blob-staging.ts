// Vault blob staging for inline apps (#505).
//
// An app runs in the SHELL document, whose origin is not the gateway (the
// installable web PWA rides the iroh tunnel; desktop runs from `file://`), so
// a relative `fetch('/centraid/_vault/blobs')` resolves nowhere and carries no
// credential. These two functions are the transport half of the element
// layer's attach flow: `@centraid/design/elements`' `stageFileBytes` /
// `stageDerivative` call them through the host client (`centraid-inline.ts`
// installs them as `stageBlob` / `stageDerivative` on `window.centraid`),
// which is the only direction that works — `packages/design` sits UPSTREAM of
// this package and cannot import the gateway client.
//
// The wire shape is the vault's: query params, sha-preflight HEAD, the
// `x-content-sha256` header, and the returned staging receipt verbatim.
import type { StagedBlob } from "@centraid/design/elements";
import { sha256File } from "@centraid/design/elements";

import { auth, authHeaders, doFetch } from "../../gateway-client-core.js";
import { blobAuthHeaders, BLOB_PREFIX } from "./blob-auth.js";

/**
 * Stream a File to the vault blob-staging route through the authed gateway.
 * Same `sha256`-preflight dedupe (HEAD `…/_sha/<sha>`) the vault's own door
 * offers: when another device already established custody the bytes never
 * leave. The gateway still hashes and verifies every POST authoritatively, so
 * a declared sha is an optimization and never a gate.
 *
 * Bytes land in the scope the caller named, not the focused one (#599):
 * an upload aimed at an audience must be staged into THAT vault's CAS.
 */
export async function stageBlob(
  file: File,
  extra = "",
  { hash = true, scope }: { hash?: boolean; scope?: string } = {}
): Promise<StagedBlob> {
  const { baseUrl, token } = await auth();
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
 * Submit a typed derivative contribution (#299 enrichers) through the
 * authed blob door — a thumbnail, a poster frame, an extracted transcript —
 * addressed to the sha of the parent it was derived from.
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
