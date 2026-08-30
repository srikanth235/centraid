// One document's PROSE as this device can have it (#821 §6/§9): inline `data:`
// bodies decode locally, PINNED bodies come off this phone's disk (#883 C6),
// everything else is one authenticated fetch. Where none works the hook says
// WHY, so the screen states the absence instead of spinning.
//
// ONE effect keyed by one resolved location: a second effect for the local
// case would be a second place for the precedence to be wrong. Synchronous
// answers are DERIVED at render; only the fetch lives in the effect.

import { File } from "expo-file-system";
import { useEffect, useMemo, useState } from "react";

import { isTextKind } from "@centraid/blueprints/apps/docs/format";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import { authHeader } from "../../lib/gateway";
import type { MobileDriveDoc } from "./docs-projection";
import { decodeTextDataUri, docBytesUrl } from "./document-read-model";
import { pinnedDocUri } from "./offline-pin";

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

async function readGatewayText(url: string): Promise<string> {
  const response = await fetch(url, { headers: authHeader() });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
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

  /**
   * A PINNED document reads from disk and never asks the gateway (#883 C6);
   * checking `online` first would spend the "available offline" promise.
   */
  const localUri = useMemo(() => pinnedDocUri(doc, vaultId), [doc, vaultId]);

  const fetchUrl = useMemo(() => {
    if (!contentId || !textKind || isInline) return null;
    if (localUri) return localUri;
    if (!online) return null;
    return docBytesUrl(
      { content_id: contentId, content_uri: contentUri },
      gatewayBase,
      vaultId
    );
  }, [
    contentId,
    textKind,
    isInline,
    localUri,
    online,
    contentUri,
    gatewayBase,
    vaultId,
  ]);

  const [fetched, setFetched] = useState<FetchedBody | null>(null);

  useEffect(() => {
    if (!fetchUrl) return undefined;
    let active = true;
    void (async () => {
      try {
        const body = fetchUrl.startsWith("file://")
          ? await new File(fetchUrl).text()
          : await readGatewayText(fetchUrl);
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
