// Docs' "available offline": the engine is the frame's (`kit/fetch-gate`) and
// this file owns only the Docs nouns. A document whose body is an inline
// `data:` URI is already on this phone, so it gets a stated reason rather than
// a live toggle that would change nothing (#883).
import { useState } from "react";

import {
  ensureOfflineContent,
  isPinned,
  offlineContentUri,
  releaseOfflineContent,
} from "../../kit/fetch-gate";
import type { ContentRef } from "../../kit/fetch-gate";
import { currentNetworkType } from "../../kit/fetch-gate/network";
import { authHeader } from "../../lib/gateway";
import type { MobileDriveDoc } from "./docs-projection";
import { docBytesUrl } from "./document-read-model";

export const PIN_LABEL = "Available offline";
export const UNPIN_LABEL = "On this phone — tap to release";
export const INLINE_REASON =
  "This document's text travels in the replica, so it already opens offline.";
export const PIN_OFFLINE_REASON =
  "The bytes are not on this phone yet, and the gateway is out of reach to fetch them.";
export const PIN_METERED_REASON =
  "This connection is metered — tap again to spend the bytes and keep this document offline.";
export const PIN_STORED_STATUS = "Kept on this phone — it opens offline now.";
export const PIN_RELEASED_STATUS =
  "Released — this document needs the gateway again.";

export function docContentRef(
  doc: MobileDriveDoc | undefined,
  fallbackScopeId: string | undefined
): ContentRef | null {
  if (!doc?.content_id) return null;
  const scopeId =
    (typeof doc.raw["__centraidScopeId"] === "string"
      ? doc.raw["__centraidScopeId"]
      : undefined) ??
    fallbackScopeId ??
    "";
  return scopeId ? { contentId: doc.content_id, scopeId } : null;
}

export function pinnedDocUri(
  doc: MobileDriveDoc | undefined,
  scopeId: string | undefined
): string | undefined {
  const ref = docContentRef(doc, scopeId);
  return ref ? offlineContentUri(ref) : undefined;
}

export interface DocumentOfflinePin {
  available: boolean;
  pinned: boolean;
  busy: boolean;
  label: string;
  reason?: string;
  toggle: () => void;
}

export interface UseDocumentOfflinePinInput {
  doc: MobileDriveDoc | undefined;
  gatewayBase: string | undefined;
  vaultId: string | undefined;
  online: boolean;
  onStatus: (message: string) => void;
}

export function useDocumentOfflinePin({
  doc,
  gatewayBase,
  vaultId,
  online,
  onStatus,
}: UseDocumentOfflinePinInput): DocumentOfflinePin {
  const [busy, setBusy] = useState(false);
  const [, setRevision] = useState(0);
  const [reason, setReason] = useState<string | undefined>(undefined);

  const ref = docContentRef(doc, vaultId);
  const inline = String(doc?.content_uri ?? "").startsWith("data:");
  const url = doc ? docBytesUrl(doc, gatewayBase, vaultId) : null;
  const pinned = ref ? isPinned(ref) : false;

  const toggle = (): void => {
    if (!ref) return;
    if (pinned) {
      releaseOfflineContent(ref);
      setReason(undefined);
      setRevision((value) => value + 1);
      onStatus(PIN_RELEASED_STATUS);
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const outcome = await ensureOfflineContent({
          ref,
          url,
          headers: authHeader(),
          networkType: await currentNetworkType(),
          consented: reason === PIN_METERED_REASON,
          online,
          pin: true,
        });
        if (outcome.status === "stored") {
          setReason(undefined);
          onStatus(PIN_STORED_STATUS);
        } else if (outcome.status === "needs-choice") {
          setReason(PIN_METERED_REASON);
          onStatus(PIN_METERED_REASON);
        } else {
          setReason(outcome.reason);
          onStatus(outcome.reason);
        }
      } finally {
        setBusy(false);
        setRevision((value) => value + 1);
      }
    })();
  };

  if (inline)
    return {
      available: false,
      pinned: false,
      busy: false,
      label: PIN_LABEL,
      reason: INLINE_REASON,
      toggle: () => {},
    };
  if (!ref)
    return {
      available: false,
      pinned: false,
      busy: false,
      label: PIN_LABEL,
      reason: "This document has no stored bytes on the gateway to keep.",
      toggle: () => {},
    };
  if (!pinned && !online)
    return {
      available: false,
      pinned: false,
      busy: false,
      label: PIN_LABEL,
      reason: PIN_OFFLINE_REASON,
      toggle: () => {},
    };
  return {
    available: true,
    pinned,
    busy,
    label: pinned ? UNPIN_LABEL : PIN_LABEL,
    ...(reason ? { reason } : {}),
    toggle,
  };
}
