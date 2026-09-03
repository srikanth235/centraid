import type { StagedBlob } from "@centraid/design/elements";
import { sha256File } from "@centraid/design/elements";

import { auth, authHeaders, doFetch } from "../../gateway-client-core.js";
import { blobAuthHeaders, BLOB_PREFIX } from "./blob-auth.js";

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
      declaredSha = null;
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
      // Intentionally empty.
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
