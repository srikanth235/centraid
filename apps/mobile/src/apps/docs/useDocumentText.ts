// One document's PROSE, as this device can actually have it (issue #821,
// §6 and §9 share it): inline `data:` bodies decode locally (the vault mints
// small text inline — blob/mint.ts), everything else is one authenticated
// fetch off the gateway's blob route. Where neither works the hook says WHY,
// so the screen can state the absence instead of spinning.
//
// The synchronous answers (no text kind, inline body, offline) are DERIVED at
// render rather than mirrored into state — only the fetch, an external
// system, lives in the effect, keyed by the one URL it resolves.

import { useEffect, useMemo, useState } from "react";

import { isTextKind } from "@centraid/blueprints/apps/docs/format";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import { authHeader } from "../../lib/gateway";
import type { MobileDriveDoc } from "./docs-projection";
import { decodeTextDataUri, docBytesUrl } from "./document-read-model";

export interface UseDocumentTextResult {
  /** The document's own body. `""` is a real (blank) body; `null` is absent. */
  text: string | null;
  loading: boolean;
  /** Why the body could not be had — a sentence, present only on failure. */
  unavailableReason?: string;
}

const OFFLINE_REASON =
  "This document's bytes are not on this device and the gateway is out of reach";
const FETCH_FAILED_REASON =
  "The gateway did not hand this document's bytes over, so the text cannot be shown right now.";

interface FetchedBody {
  url: string;
  result: UseDocumentTextResult;
}

export function useDocumentText(
  doc: MobileDriveDoc | undefined
): UseDocumentTextResult {
  const { gatewayBase, vaultId, online } = useReplica();

  const contentUri = doc?.content_uri ?? null;
  const contentId = doc?.content_id ?? null;
  const textKind = doc ? isTextKind(doc) : false;
  const inlineBody =
    contentId && textKind ? decodeTextDataUri(contentUri) : null;
  const isInline =
    inlineBody !== null || String(contentUri ?? "").startsWith("data:");

  const fetchUrl = useMemo(() => {
    if (!contentId || !textKind || isInline || !online) return null;
    return docBytesUrl(
      { content_id: contentId, content_uri: contentUri },
      gatewayBase,
      vaultId
    );
  }, [contentId, textKind, isInline, online, contentUri, gatewayBase, vaultId]);

  const [fetched, setFetched] = useState<FetchedBody | null>(null);

  useEffect(() => {
    if (!fetchUrl) return undefined;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(fetchUrl, { headers: authHeader() });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        if (active)
          setFetched({ url: fetchUrl, result: { text: body, loading: false } });
      } catch {
        if (active)
          setFetched({
            url: fetchUrl,
            result: {
              text: null,
              loading: false,
              unavailableReason: FETCH_FAILED_REASON,
            },
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [fetchUrl]);

  if (!contentId || !textKind) return { text: null, loading: false };
  if (isInline) return { text: inlineBody ?? "", loading: false };
  if (!fetchUrl)
    return { text: null, loading: false, unavailableReason: OFFLINE_REASON };
  if (fetched && fetched.url === fetchUrl) return fetched.result;
  return { text: null, loading: true };
}
