/*
 * Conversation-scoped provider egress consent (#567).
 *
 * Direct rows are keyed by conversation × HarnessKind. Ladder rows add the
 * subsystem whose Settings membership authorized unattended egress, so
 * removing a harness from one ladder revokes that lane without touching a
 * direct grant or another subsystem's ladder grant. Revocation is retained as
 * evidence rather than deleting the row.
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
  /**
   * Attended consent: the user answered an egress prompt for this
   * conversation, so a prior revocation is deliberately cleared.
   */
  grant: (
    conversationId: string,
    harnessKind: HarnessKind,
    source: ProviderConsentSource,
    subsystem?: ModelSubsystem,
    now?: number
  ) => void;
  /**
   * Unattended consent derived from user authoring (a prefs-primary harness or
   * current ladder membership). No owner is present to answer a prompt, so
   * this must never resurrect a revoked row — a revocation outlives every
   * later derivation. Returns whether egress is now consented.
   *
   * Optional so a host may inject a narrower controller; an absent
   * implementation means unattended egress is denied, never assumed.
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
  /** Revoke grants created by one subsystem's automatic ladder membership. */
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
    // An explicit `revoke()` leaves a direct tombstone. Unattended derivation
    // must not step over it: only an attended `grant()` re-opens the lane.
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
      // Ladder membership IS the authorization (D13); the row is only its
      // receipt. A harness the user has (re-)placed in the live ladder is
      // consented, so a membership-removal revocation clears on re-add — but a
      // harness absent from the ladder is denied outright, never auto-added.
      if (!this.isCurrentLadderMember(harnessKind, subsystem)) return false;
      this.grant(conversationId, harnessKind, source, subsystem, now);
      return true;
    }
    // `DO UPDATE … WHERE revoked_at IS NULL` refreshes a live row and leaves a
    // revoked one untouched — the insert half only ever creates a fresh grant.
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
    // The direct row doubles as the durable tombstone: it is what tells a
    // later unattended derivation that the user withdrew this provider from
    // this conversation. Membership removal (`revokeLadderProvider`) writes no
    // tombstone, so re-adding a harness to a ladder re-authorizes it (D13).
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
