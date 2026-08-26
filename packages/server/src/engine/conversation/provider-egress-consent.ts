/*
 * Conversation-scoped provider egress consent (#567). Revocation is
 * retained as evidence, not deleted.
 */

import type { DatabaseProvider } from "../stores/gateway-db.js";
import type { ModelSubsystem } from "../stores/prefs-store.js";
import type { HarnessKind } from "./turn.js";

export type ProviderConsentSource = "direct" | "ladder";

export interface ProviderEgressConsentController {
  has: (
    conversationId: string,
    harnessKind: HarnessKind,
    subsystem?: ModelSubsystem
  ) => boolean;
  /** Attended: the user answered an egress prompt; clears a prior revocation. */
  grant: (
    conversationId: string,
    harnessKind: HarnessKind,
    source: ProviderConsentSource,
    subsystem?: ModelSubsystem,
    now?: number
  ) => void;
  /**
   * Unattended, derived from authoring; never resurrects a revoked row.
   * Absent ⇒ unattended egress is denied, never assumed.
   */
  recordDerived?: (
    conversationId: string,
    harnessKind: HarnessKind,
    source: ProviderConsentSource,
    subsystem?: ModelSubsystem,
    now?: number
  ) => boolean;
  revoke: (
    conversationId: string,
    harnessKind: HarnessKind,
    now?: number
  ) => void;
  /** Revoke grants created by one subsystem's ladder membership. */
  revokeLadderProvider?: (
    harnessKind: HarnessKind,
    subsystem: ModelSubsystem,
    now?: number
  ) => void;
}

function consentSubsystemFor(
  source: ProviderConsentSource,
  subsystem: ModelSubsystem | undefined
): string {
  if (source === "direct") return "";
  if (subsystem === undefined)
    throw new Error("ladder provider consent requires a subsystem");
  return subsystem;
}

export class ProviderEgressConsentStore implements ProviderEgressConsentController {
  constructor(
    private readonly dbProvider: DatabaseProvider,
    private readonly isCurrentLadderMember: (
      harnessKind: HarnessKind,
      subsystem: ModelSubsystem
    ) => boolean = () => true
  ) {}

  has(
    conversationId: string,
    harnessKind: HarnessKind,
    subsystem?: ModelSubsystem
  ): boolean {
    const db = this.dbProvider();
    const direct =
      db
        .prepare(
          `SELECT 1
             FROM conversation_provider_consent
            WHERE conversation_id = ? AND harness_kind = ?
              AND source = 'direct' AND subsystem = '' AND revoked_at IS NULL`
        )
        .get(conversationId, harnessKind) !== undefined;
    if (direct) return true;
    if (!subsystem || !this.isCurrentLadderMember(harnessKind, subsystem))
      return false;
    return (
      db
        .prepare(
          `SELECT 1
             FROM conversation_provider_consent
            WHERE conversation_id = ? AND harness_kind = ?
              AND source = 'ladder' AND subsystem = ? AND revoked_at IS NULL`
        )
        .get(conversationId, harnessKind, subsystem) !== undefined
    );
  }

  grant(
    conversationId: string,
    harnessKind: HarnessKind,
    source: ProviderConsentSource,
    subsystem?: ModelSubsystem,
    now = Date.now()
  ): void {
    const consentSubsystem = consentSubsystemFor(source, subsystem);
    this.dbProvider()
      .prepare(
        `INSERT INTO conversation_provider_consent (
           conversation_id, harness_kind, source, subsystem, granted_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(conversation_id, harness_kind, source, subsystem) DO UPDATE SET
           granted_at = excluded.granted_at,
           revoked_at = NULL`
      )
      .run(conversationId, harnessKind, source, consentSubsystem, now);
  }

  recordDerived(
    conversationId: string,
    harnessKind: HarnessKind,
    source: ProviderConsentSource,
    subsystem?: ModelSubsystem,
    now = Date.now()
  ): boolean {
    const consentSubsystem = consentSubsystemFor(source, subsystem);
    const db = this.dbProvider();
    // An explicit `revoke()` tombstone: only an attended grant re-opens.
    const revokedDirectly =
      db
        .prepare(
          `SELECT 1
             FROM conversation_provider_consent
            WHERE conversation_id = ? AND harness_kind = ?
              AND source = 'direct' AND subsystem = '' AND revoked_at IS NOT NULL`
        )
        .get(conversationId, harnessKind) !== undefined;
    if (revokedDirectly) return false;
    if (source === "ladder" && subsystem !== undefined) {
      // Ladder membership IS the authorization (D13); re-add clears a
      // membership-removal revocation, absence is denial.
      if (!this.isCurrentLadderMember(harnessKind, subsystem)) return false;
      this.grant(conversationId, harnessKind, source, subsystem, now);
      return true;
    }
    // `DO UPDATE … WHERE revoked_at IS NULL` never resurrects a revoked row.
    db.prepare(
      `INSERT INTO conversation_provider_consent (
         conversation_id, harness_kind, source, subsystem, granted_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(conversation_id, harness_kind, source, subsystem) DO UPDATE SET
         granted_at = excluded.granted_at
       WHERE conversation_provider_consent.revoked_at IS NULL`
    ).run(conversationId, harnessKind, source, consentSubsystem, now);
    return (
      db
        .prepare(
          `SELECT 1
             FROM conversation_provider_consent
            WHERE conversation_id = ? AND harness_kind = ? AND source = ? AND subsystem = ?
              AND revoked_at IS NULL`
        )
        .get(conversationId, harnessKind, source, consentSubsystem) !==
      undefined
    );
  }

  revoke(
    conversationId: string,
    harnessKind: HarnessKind,
    now = Date.now()
  ): void {
    const db = this.dbProvider();
    // Direct row is the durable tombstone; membership removal writes none —
    // re-adding a harness re-authorizes (D13).
    db.prepare(
      `INSERT INTO conversation_provider_consent (
         conversation_id, harness_kind, source, subsystem, granted_at, revoked_at
       ) VALUES (?, ?, 'direct', '', ?, ?)
       ON CONFLICT(conversation_id, harness_kind, source, subsystem) DO NOTHING`
    ).run(conversationId, harnessKind, now, now);
    db.prepare(
      `UPDATE conversation_provider_consent
          SET revoked_at = ?
        WHERE conversation_id = ? AND harness_kind = ? AND revoked_at IS NULL`
    ).run(now, conversationId, harnessKind);
  }

  revokeLadderProvider(
    harnessKind: HarnessKind,
    subsystem: ModelSubsystem,
    now = Date.now()
  ): void {
    this.dbProvider()
      .prepare(
        `UPDATE conversation_provider_consent
            SET revoked_at = ?
          WHERE harness_kind = ? AND source = 'ladder' AND subsystem = ?
            AND revoked_at IS NULL`
      )
      .run(now, harnessKind, subsystem);
  }
}
