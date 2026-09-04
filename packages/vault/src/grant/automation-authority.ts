/*
 * An automation's standing answer, as `share_authority` rows (#928 A3,
 * AP-automation-principal). An automation IS a principal: the owner approves
 * its compiled manifest, and that approval is an auditable row rather than an
 * app-plane grant. One row per (pack or entity x read|act) — `agent.pack` with
 * the schema name where the manifest scope names no table, `core.entity` with
 * the dotted entity type where it does, exactly the two triples
 * `authority-registry.ts` admits. A `reveal` scope mints nothing: a sealed
 * reveal is Locker's permit, never a standing answer (#873).
 *
 * The principal id is the automation's own id — the id its agent enrolment
 * carries as `enrollment_key` — so one automation is one principal however
 * many packs its manifest names (#928, open question 4).
 *
 * The per-run execution clamp is unchanged and still cuts the identity down to
 * the manifest before the first `ctx.vault` call; these rows are what the owner
 * SAID, not the thing that stops a run.
 */

import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";

export const AUTOMATION_PACK_SUBJECT = "agent.pack";
export const AUTOMATION_ENTITY_SUBJECT = "core.entity";

export type AutomationVerb = "read" | "act";
export type AutomationDecision = "granted" | "declined";

export interface AutomationScope {
  schema: string;
  table?: string;
  verbs: "read" | "read+act" | "act" | "reveal";
}

export interface AutomationSubject {
  subjectType: string;
  subjectId: string;
  verb: AutomationVerb;
}

export interface AutomationAnswer extends AutomationSubject {
  authorityId: string;
  principalId: string;
  decision: AutomationDecision;
  grantedAt: string;
}

const VERBS_OF: Readonly<Record<string, readonly AutomationVerb[]>> = {
  read: ["read"],
  act: ["act"],
  "read+act": ["read", "act"],
  reveal: [],
};

function subjectKey(subject: AutomationSubject): string {
  return [subject.subjectType, subject.subjectId, subject.verb].join(" ");
}

/** Manifest scopes to the answers they ask for, de-duplicated, in declared order. */
export function automationSubjectsOf(
  scopes: readonly AutomationScope[]
): AutomationSubject[] {
  const seen = new Map<string, AutomationSubject>();
  for (const scope of scopes) {
    const subject = {
      subjectType: scope.table
        ? AUTOMATION_ENTITY_SUBJECT
        : AUTOMATION_PACK_SUBJECT,
      subjectId: scope.table ? `${scope.schema}.${scope.table}` : scope.schema,
    };
    for (const verb of VERBS_OF[scope.verbs] ?? []) {
      const answer = { ...subject, verb };
      const key = subjectKey(answer);
      if (!seen.has(key)) seen.set(key, answer);
    }
  }
  return [...seen.values()];
}

export function automationAnswers(
  db: DatabaseSync,
  principalId?: string
): AutomationAnswer[] {
  const restriction = principalId === undefined ? "" : " AND principal_id = ?";
  return db
    .prepare(
      `SELECT authority_id AS authorityId, principal_id AS principalId,
              subject_type AS subjectType, subject_id AS subjectId,
              verb, decision, granted_at AS grantedAt
         FROM share_authority
        WHERE principal_kind = 'automation' AND revoked_at IS NULL${restriction}
        ORDER BY principal_id, subject_type, subject_id, verb`
    )
    .all(
      ...(principalId === undefined ? [] : [principalId])
    ) as unknown as AutomationAnswer[];
}

/**
 * Answer the manifest. Rows are immutable but for `revoked_at` (#883 V-table):
 * an answer that already stands is left alone, and an answer that CHANGES side
 * revokes the standing row before inserting, so "asked and told no" is never
 * indistinguishable from "never asked".
 */
export function recordAutomationAnswers(
  db: DatabaseSync,
  input: {
    principalId: string;
    ownerPartyId: string;
    subjects: readonly AutomationSubject[];
    decision: AutomationDecision;
    now: string;
  }
): number {
  const live = new Map(
    automationAnswers(db, input.principalId).map((row) => [
      subjectKey(row),
      row,
    ])
  );
  const revoke = db.prepare(
    `UPDATE share_authority SET revoked_at = ? WHERE authority_id = ?`
  );
  const insert = db.prepare(
    `INSERT INTO share_authority
       (authority_id, principal_kind, principal_id, subject_type, subject_id,
        verb, duration, expires_at, decision, granted_at, granted_by,
        revoked_at, revoked_reason, receipt_id)
     VALUES (?, 'automation', ?, ?, ?, ?, 'standing', NULL, ?, ?, ?, NULL, NULL, NULL)`
  );
  let written = 0;
  for (const subject of input.subjects) {
    const standing = live.get(subjectKey(subject));
    if (standing?.decision === input.decision) continue;
    if (standing) revoke.run(input.now, standing.authorityId);
    insert.run(
      uuidv7(),
      input.principalId,
      subject.subjectType,
      subject.subjectId,
      subject.verb,
      input.decision,
      input.now,
      input.ownerPartyId
    );
    written += 1;
  }
  return written;
}

/** The automation is gone; its answers end with it (#306: standing answers die with the actor). */
export function revokeAutomationAnswers(
  db: DatabaseSync,
  principalId: string,
  now: string
): number {
  return Number(
    db
      .prepare(
        `UPDATE share_authority
            SET revoked_at = ?, revoked_reason = 'principal-removed'
          WHERE principal_kind = 'automation' AND principal_id = ?
            AND revoked_at IS NULL`
      )
      .run(now, principalId).changes
  );
}

interface LegacyScopeRow {
  principalId: string;
  entity: string;
  verbs: string;
}

function scopesByPrincipal(
  rows: readonly LegacyScopeRow[]
): Map<string, AutomationScope[]> {
  const byPrincipal = new Map<string, AutomationScope[]>();
  for (const row of rows) {
    const dot = row.entity.indexOf(".");
    const verbs = row.verbs as AutomationScope["verbs"];
    const scope: AutomationScope =
      dot > 0
        ? {
            schema: row.entity.slice(0, dot),
            table: row.entity.slice(dot + 1),
            verbs,
          }
        : { schema: row.entity, verbs };
    byPrincipal.set(row.principalId, [
      ...(byPrincipal.get(row.principalId) ?? []),
      scope,
    ]);
  }
  return byPrincipal;
}

/**
 * ONE-SHOT BACKFILL (#928 wave 3). Every live automation grant the app plane
 * holds becomes a `granted` answer and every scope tombstone a `declined` one,
 * so an owner's prior refusal survives the plane it was recorded in. Lossless
 * and idempotent: it reads the legacy rows and never deletes them (wave 4
 * does), and a vault that already carries automation answers is left alone.
 * Open scope requests are untouched, because the owner's pending decision is
 * what depends on them: a parked ask is not an answer, and answering it here
 * would settle a question the owner has not been shown.
 *
 * `_assistant` is excluded by name: the assistant holds no standing answer at
 * all (#928 A3), so minting one here would recreate the grant #928 deletes.
 */
export function backfillAutomationAnswers(
  db: DatabaseSync,
  ownerPartyId: string,
  now: string
): { granted: number; declined: number } {
  if (automationAnswers(db).length > 0) return { granted: 0, declined: 0 };
  const granted = db
    .prepare(
      `SELECT a.enrollment_key AS principalId, s.entity, s.verbs
         FROM access_agent a
         JOIN access_grant g ON g.grantee_party_id = a.party_id
         JOIN access_grant_scope s ON s.grant_id = g.grant_id
        WHERE a.enrollment_key <> '_assistant'
          AND g.status = 'active' AND g.revoked_at IS NULL
        ORDER BY a.enrollment_key, s.rowid`
    )
    .all() as unknown as LegacyScopeRow[];
  const declined = db
    .prepare(
      `SELECT a.enrollment_key AS principalId, t.entity, t.verbs
         FROM access_agent a
         JOIN access_scope_tombstone t ON t.grantee_party_id = a.party_id
        WHERE a.enrollment_key <> '_assistant'
        ORDER BY a.enrollment_key, t.rowid`
    )
    .all() as unknown as LegacyScopeRow[];
  const counted = { granted: 0, declined: 0 };
  for (const [rows, decision] of [
    [granted, "granted"],
    [declined, "declined"],
  ] as const) {
    for (const [principalId, scopes] of scopesByPrincipal(rows)) {
      counted[decision] += recordAutomationAnswers(db, {
        principalId,
        ownerPartyId,
        subjects: automationSubjectsOf(scopes),
        decision,
        now,
      });
    }
  }
  return counted;
}
