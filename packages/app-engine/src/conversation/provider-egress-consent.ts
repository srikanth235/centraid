/*
 * Conversation-scoped provider egress consent (#567).
 *
 * Direct rows are keyed by conversation × RunnerKind. Ladder rows add the
 * subsystem whose Settings membership authorized unattended egress, so
 * removing a runner from one ladder revokes that lane without touching a
 * direct grant or another subsystem's ladder grant. Revocation is retained as
 * evidence rather than deleting the row.
 */

import type { ModelSubsystem } from '../stores/prefs-store.js';
import type { DatabaseProvider } from '../stores/gateway-db.js';
import type { RunnerKind } from './turn.js';

export type ProviderConsentSource = 'direct' | 'ladder';

export interface ProviderEgressConsentController {
  has(conversationId: string, runnerKind: RunnerKind, subsystem?: ModelSubsystem): boolean;
  grant(
    conversationId: string,
    runnerKind: RunnerKind,
    source: ProviderConsentSource,
    subsystem?: ModelSubsystem,
    now?: number,
  ): void;
  revoke(conversationId: string, runnerKind: RunnerKind, now?: number): void;
  /** Revoke grants created by one subsystem's automatic ladder membership. */
  revokeLadderProvider?(runnerKind: RunnerKind, subsystem: ModelSubsystem, now?: number): void;
}

export class ProviderEgressConsentStore implements ProviderEgressConsentController {
  constructor(
    private readonly dbProvider: DatabaseProvider,
    private readonly isCurrentLadderMember: (
      runnerKind: RunnerKind,
      subsystem: ModelSubsystem,
    ) => boolean = () => true,
  ) {}

  has(conversationId: string, runnerKind: RunnerKind, subsystem?: ModelSubsystem): boolean {
    const db = this.dbProvider();
    const direct =
      db
        .prepare(
          `SELECT 1
             FROM conversation_provider_consent
            WHERE conversation_id = ? AND runner_kind = ?
              AND source = 'direct' AND subsystem = '' AND revoked_at IS NULL`,
        )
        .get(conversationId, runnerKind) !== undefined;
    if (direct) return true;
    if (!subsystem || !this.isCurrentLadderMember(runnerKind, subsystem)) return false;
    return (
      db
        .prepare(
          `SELECT 1
             FROM conversation_provider_consent
            WHERE conversation_id = ? AND runner_kind = ?
              AND source = 'ladder' AND subsystem = ? AND revoked_at IS NULL`,
        )
        .get(conversationId, runnerKind, subsystem) !== undefined
    );
  }

  grant(
    conversationId: string,
    runnerKind: RunnerKind,
    source: ProviderConsentSource,
    subsystem?: ModelSubsystem,
    now = Date.now(),
  ): void {
    const consentSubsystem = source === 'direct' ? '' : subsystem;
    if (consentSubsystem === undefined) {
      throw new Error('ladder provider consent requires a subsystem');
    }
    this.dbProvider()
      .prepare(
        `INSERT INTO conversation_provider_consent (
           conversation_id, runner_kind, source, subsystem, granted_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(conversation_id, runner_kind, source, subsystem) DO UPDATE SET
           granted_at = excluded.granted_at,
           revoked_at = NULL`,
      )
      .run(conversationId, runnerKind, source, consentSubsystem, now);
  }

  revoke(conversationId: string, runnerKind: RunnerKind, now = Date.now()): void {
    this.dbProvider()
      .prepare(
        `UPDATE conversation_provider_consent
            SET revoked_at = ?
          WHERE conversation_id = ? AND runner_kind = ? AND revoked_at IS NULL`,
      )
      .run(now, conversationId, runnerKind);
  }

  revokeLadderProvider(runnerKind: RunnerKind, subsystem: ModelSubsystem, now = Date.now()): void {
    this.dbProvider()
      .prepare(
        `UPDATE conversation_provider_consent
            SET revoked_at = ?
          WHERE runner_kind = ? AND source = 'ladder' AND subsystem = ?
            AND revoked_at IS NULL`,
      )
      .run(now, runnerKind, subsystem);
  }
}
