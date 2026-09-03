import type { VaultDb } from "@centraid/vault";
import {
  COMMONS_MEMBER_IDENTITY_CHANGED,
  commonsCurrentSize,
} from "@centraid/vault";

import {
  commonsObservabilityForVault,
  COMMONS_STEWARD_ABSENT_AFTER_MS,
} from "./commons-observability.js";
import { NoticeStore } from "./notices.js";
import type { Notice, PutNotice } from "./notices.js";

export const COMMONS_ABSENCE_NOTICE_KIND = "commons-steward";
export const COMMONS_GROWTH_NOTICE_KIND = "commons-size";
export const COMMONS_IDENTITY_NOTICE_KIND = "commons-identity";

const COMMONS_DEEP_LINK = "/household";

function days(ms: number): number {
  return Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)));
}

export function commonsAbsenceNotice(input: {
  grantId: string;
  containerType: string;
  presence: "absent" | "parked";
  silentForMs?: number;
  fault?: string;
  stewardVaultId?: string;
}): PutNotice {
  const headline =
    input.presence === "parked"
      ? "A shared space stopped syncing because its history could not be verified"
      : `A shared space's owner device hasn't been reachable for ${days(
          input.silentForMs ?? COMMONS_STEWARD_ABSENT_AFTER_MS
        )} days`;
  return {
    kind: COMMONS_ABSENCE_NOTICE_KIND,
    sourceRef: input.grantId,
    headline,
    detail: {
      deepLink: COMMONS_DEEP_LINK,
      grantId: input.grantId,
      containerType: input.containerType,
      presence: input.presence,
      sourceType: "commons",
      ...(input.fault ? { fault: input.fault } : {}),
      ...(input.silentForMs === undefined
        ? {}
        : { silentForMs: input.silentForMs }),
      ...(input.stewardVaultId ? { stewardVaultId: input.stewardVaultId } : {}),
      recoverable: input.presence === "absent",
    },
    severity: "high",
  };
}

export function shouldWriteCommonsAbsenceNotice(
  prior: Notice | undefined,
  presence: string
): boolean {
  return !prior || prior.detail["presence"] !== presence;
}

export function commonsGrowthNotice(input: {
  grantId: string;
  containerLabel?: string;
  acceptedSizeBytes: number;
  currentSizeBytes: number;
}): PutNotice {
  const name = input.containerLabel ?? "A shared space";
  return {
    kind: COMMONS_GROWTH_NOTICE_KIND,
    sourceRef: input.grantId,
    headline: `${name} has grown past the size you accepted`,
    detail: {
      deepLink: COMMONS_DEEP_LINK,
      grantId: input.grantId,
      acceptedSizeBytes: input.acceptedSizeBytes,
      currentSizeBytes: input.currentSizeBytes,
      sourceType: "commons",
      ...(input.containerLabel ? { containerLabel: input.containerLabel } : {}),
    },
    severity: "warning",
  };
}

interface AcceptedInvitation {
  grant_id: string;
  container_label: string | null;
  current_size_bytes: number;
}

export function raiseCommonsNotices(input: {
  db: VaultDb;
  vaultId: string;
  notices?: NoticeStore;
  now?: string;
}): Notice[] {
  const now = input.now ?? new Date().toISOString();
  const raised: Notice[] = [];
  let store: NoticeStore | undefined = input.notices;
  const notices = (): NoticeStore => {
    store ??= new NoticeStore(input.db.vault);
    return store;
  };
  const observability = commonsObservabilityForVault({
    db: input.db,
    vaultId: input.vaultId,
    now,
  });
  for (const grant of observability.grants) {
    const presence = grant.steward.presence;
    if (presence !== "absent" && presence !== "parked") continue;
    if (grant.supersededBy) continue;
    const prior = notices().getBySource(
      COMMONS_ABSENCE_NOTICE_KIND,
      grant.grantId
    );
    if (!shouldWriteCommonsAbsenceNotice(prior, presence)) continue;
    raised.push(
      notices().put({
        ...commonsAbsenceNotice({
          grantId: grant.grantId,
          containerType: grant.containerType,
          presence,
          ...(grant.steward.silentForMs === undefined
            ? {}
            : { silentForMs: grant.steward.silentForMs }),
          ...(grant.steward.fault ? { fault: grant.steward.fault } : {}),
          ...(grant.steward.stewardVaultId
            ? { stewardVaultId: grant.steward.stewardVaultId }
            : {}),
        }),
        at: now,
      })
    );
  }
  const accepted = input.db.vault
    .prepare(
      `SELECT i.grant_id, i.container_label, i.current_size_bytes
         FROM share_commons_invitation i
         JOIN share_circle_grant g ON g.grant_id = i.grant_id
        WHERE i.status = 'accepted' AND i.member_vault_id = ?
          AND g.revoked_at IS NULL`
    )
    .all(input.vaultId) as unknown as AcceptedInvitation[];
  for (const invitation of accepted) {
    let current: number;
    try {
      current = commonsCurrentSize(
        input.db.vault,
        input.vaultId,
        invitation.grant_id
      );
    } catch {
      continue;
    }
    if (current <= invitation.current_size_bytes) continue;
    const prior = notices().getBySource(
      COMMONS_GROWTH_NOTICE_KIND,
      invitation.grant_id
    );
    if (prior) continue;
    raised.push(
      notices().put({
        ...commonsGrowthNotice({
          grantId: invitation.grant_id,
          ...(invitation.container_label
            ? { containerLabel: invitation.container_label }
            : {}),
          acceptedSizeBytes: invitation.current_size_bytes,
          currentSizeBytes: current,
        }),
        at: now,
      })
    );
  }
  return raised;
}

export function commonsIdentityChangedNotice(input: {
  grantId: string;
  reason: string;
}): PutNotice {
  return {
    kind: COMMONS_IDENTITY_NOTICE_KIND,
    sourceRef: input.grantId,
    headline:
      "Your changes to a shared space are refused — this vault's identity is not the one it joined with",
    detail: {
      deepLink: COMMONS_DEEP_LINK,
      grantId: input.grantId,
      fault: COMMONS_MEMBER_IDENTITY_CHANGED,
      reason: input.reason,
      remedy: "re-invitation",
      sourceType: "commons",
    },
    severity: "high",
  };
}

export function isCommonsIdentityRefusal(reason: string | undefined): boolean {
  return reason?.startsWith(COMMONS_MEMBER_IDENTITY_CHANGED) === true;
}

export function raiseCommonsIdentityNotice(input: {
  db: VaultDb;
  grantId: string;
  reason: string;
  now?: string;
}): void {
  try {
    const store = new NoticeStore(input.db.vault);
    if (store.getBySource(COMMONS_IDENTITY_NOTICE_KIND, input.grantId)) return;
    store.put({
      ...commonsIdentityChangedNotice({
        grantId: input.grantId,
        reason: input.reason,
      }),
      ...(input.now ? { at: input.now } : {}),
    });
  } catch {
    // Intentionally empty.
  }
}
