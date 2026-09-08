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

/**
 * Has the owner EVER answered about this automation — yes, no, or since
 * withdrawn? "Never asked" and "asked and answered, then withdrawn" are
 * different facts (#308 A4): the first is what makes installing the answer,
 * the second is what makes a re-published manifest PARK instead of quietly
 * re-minting what the owner just took away.
 */
export function hasAnsweredEver(
  db: DatabaseSync,
  principalId: string
): boolean {
  // An answer ended by UNINSTALL is not memory of this automation: the
  // principal was removed, and #306's "a reinstall is a fresh consent" says
  // the next install answers itself again. The row stays as evidence.
  return (
    db
      .prepare(
        `SELECT 1 AS x FROM share_authority
          WHERE principal_kind = 'automation' AND principal_id = ?
            AND (revoked_reason IS NULL OR revoked_reason <> 'principal-removed')
          LIMIT 1`
      )
      .get(principalId) !== undefined
  );
}

/**
 * A subject back to the manifest scope that asks for it — exactly what
 * `automationSubjectsOf` maps forward, so an ask can be PARKED as the scopes
 * the owner is shown and answered as the subjects they answered.
 */
export function scopeForSubject(subject: AutomationSubject): AutomationScope {
  const dot = subject.subjectId.indexOf(".");
  return subject.subjectType === AUTOMATION_ENTITY_SUBJECT && dot > 0
    ? {
        schema: subject.subjectId.slice(0, dot),
        table: subject.subjectId.slice(dot + 1),
        verbs: subject.verb,
      }
    : { schema: subject.subjectId, verbs: subject.verb };
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

/**
 * The automation is gone; its answers end with it (#306: standing answers die
 * with the actor). Answers already withdrawn in this same act are RE-STAMPED
 * with the reason, so uninstalling and revoking stay distinguishable: the
 * first wipes the memory, the second is remembered and re-parks.
 */
export function revokeAutomationAnswers(
  db: DatabaseSync,
  principalId: string,
  now: string
): number {
  const ended = Number(
    db
      .prepare(
        `UPDATE share_authority
            SET revoked_at = ?, revoked_reason = 'principal-removed'
          WHERE principal_kind = 'automation' AND principal_id = ?
            AND revoked_at IS NULL`
      )
      .run(now, principalId).changes
  );
  db.prepare(
    `UPDATE share_authority SET revoked_reason = 'principal-removed'
      WHERE principal_kind = 'automation' AND principal_id = ?
        AND revoked_at IS NOT NULL AND revoked_reason IS NULL`
  ).run(principalId);
  return ended;
}
