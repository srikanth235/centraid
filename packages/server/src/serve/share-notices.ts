import type { VaultDb } from "@centraid/vault";

import { NoticeStore } from "./notices.js";
import type { Notice, PutNotice } from "./notices.js";

export const SHARE_RECEIVED_NOTICE_KIND = "share-received";

const SUBJECT_WORDS: Readonly<Record<string, string>> = {
  "core.collection": "an album",
  "core.content_item": "a file",
  "core.document": "a document",
  "docs.folder": "a folder",
  "media.asset": "a photo",
  "tally.group": "a shared expense group",
};

export function shareReceivedNotice(input: {
  grantId: string;
  granterName: string;
  subjectType: string;
  subjectLabel?: string;
  originVaultId: string;
}): PutNotice {
  const what =
    input.subjectLabel ?? SUBJECT_WORDS[input.subjectType] ?? "something";
  return {
    kind: SHARE_RECEIVED_NOTICE_KIND,
    sourceRef: input.grantId,
    headline: `${input.granterName} shared ${what} with you`,
    detail: {
      grantId: input.grantId,
      granterName: input.granterName,
      originVaultId: input.originVaultId,
      sourceType: "share",
      subjectType: input.subjectType,
      ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
    },
    severity: "info",
  };
}

function granterName(origin: VaultDb, granterPartyId: string): string {
  const row = origin.vault
    .prepare("SELECT display_name FROM core_party WHERE party_id = ?")
    .get(granterPartyId) as { display_name: string } | undefined;
  if (row?.display_name) return row.display_name;
  const vault = origin.vault
    .prepare("SELECT display_name FROM core_vault LIMIT 1")
    .get() as { display_name: string } | undefined;
  return vault?.display_name ?? "A vault you are linked with";
}

export function raiseShareReceivedNotice(input: {
  origin: VaultDb;
  originVaultId: string;
  seat: VaultDb;
  grantId: string;
  granterPartyId: string;
  subjectType: string;
  subjectLabel?: string;
  now?: string;
}): Notice | undefined {
  try {
    const store = new NoticeStore(input.seat.vault);
    const standing = store.getBySource(
      SHARE_RECEIVED_NOTICE_KIND,
      input.grantId
    );
    if (standing) return undefined;
    return store.put({
      ...shareReceivedNotice({
        grantId: input.grantId,
        granterName: granterName(input.origin, input.granterPartyId),
        subjectType: input.subjectType,
        ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
        originVaultId: input.originVaultId,
      }),
      ...(input.now ? { at: input.now } : {}),
    });
  } catch {
    return undefined;
  }
}
