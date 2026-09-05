/**
 * THE ACCESS LENS (#883, ruling V-dashboard): one row per standing answer.
 *
 * ABSENT IS NEVER EMPTY — a refused or storeless read is `unreadable`, never
 * an empty list; "nobody has access" and "we could not ask" are opposite facts.
 *
 * Revoke sentences are the vault's (`grant/phrases.ts`); this file composes
 * none.
 */

import { GRANT_LOCI } from "@centraid/blueprints/apps/_shared/grant-transport";
import type { GrantLocus } from "@centraid/blueprints/apps/_shared/grant-transport";

export interface AccessAnswer {
  authorityId: string;
  principalKind: AccessPrincipalKind;
  principalId: string;
  subjectType: string;
  subjectId: string;
  verb: string;
  decision: "granted" | "declined";
  duration: string;
  expiresAt: string | null;
  grantedAt: string;
  revokedAt: string | null;
  /** ISO stamp of the last act this answer permitted; `null` = never used. */
  lastUsedAt: string | null;
}

/**
 * AN ASK IS NOT AN ANSWER (#928 A4). An automation whose published manifest
 * reaches past what the member ever answered PARKS here — it is drawn beside
 * the answers because a question waiting on the member is exactly what a
 * dashboard of "what did I say" must not hide.
 */
export interface AccessRequest {
  requestId: string;
  principalId: string;
  scopes: string[];
  requestedAt: string;
}

export type AccessPrincipalKind =
  | "person"
  | "circle"
  | "harness"
  | "device"
  | "automation";

const PRINCIPAL_KINDS: readonly AccessPrincipalKind[] = [
  "person",
  "circle",
  "harness",
  "device",
  "automation",
];

/** Ruling V-dashboard: `person` and `circle` are ONE group — one question. */
export interface AccessGroup {
  id: "audiences" | "harnesses" | "devices" | "automations";
  title: string;
  locus: GrantLocus;
  answers: AccessAnswer[];
}

export type AccessLocusCopy = Partial<Record<GrantLocus, string>>;

export type AccessLens =
  | {
      status: "ready";
      groups: AccessGroup[];
      loci: AccessLocusCopy;
      requests: AccessRequest[];
    }
  | { status: "unreadable"; reason: string };

const GROUPS: readonly {
  id: AccessGroup["id"];
  title: string;
  locus: GrantLocus;
  kinds: readonly AccessPrincipalKind[];
}[] = [
  {
    id: "audiences",
    title: "People and circles",
    locus: "remote",
    kinds: ["person", "circle"],
  },
  { id: "harnesses", title: "Harnesses", locus: "local", kinds: ["harness"] },
  // An automation is a principal like any other since #928: its standing
  // answer is a `share_authority` row, so it is a group here rather than a
  // separate screen with its own vocabulary.
  {
    id: "automations",
    title: "Automations",
    locus: "local",
    kinds: ["automation"],
  },
  {
    id: "devices",
    title: "Your devices",
    locus: "boundary",
    kinds: ["device"],
  },
];

export interface AccessReader {
  read: (
    appId: string,
    request: { entity: string; limit?: number }
  ) => Promise<{ rows: readonly { values: Record<string, unknown> }[] }>;
}

/** RAW: `grant-door.ts` is not importable here, so the body is parsed
 *  against the wire's own `GRANT_LOCI`. */
export interface AccessRegistryReader {
  subjects: () => Promise<unknown>;
}

export function parseLociBody(value: unknown): AccessLocusCopy {
  const body =
    value !== null && typeof value === "object"
      ? (value as { loci?: unknown }).loci
      : undefined;
  if (body === null || typeof body !== "object") return {};
  const row = body as Record<string, unknown>;
  const loci: Partial<Record<GrantLocus, string>> = {};
  for (const locus of GRANT_LOCI) {
    const copy = row[locus];
    if (typeof copy === "string" && copy.length > 0) loci[locus] = copy;
  }
  return loci;
}

export const ACCESS_SCOPE = "people";
export const ACCESS_ENTITY = "share.authority";
/** WHEN each answer was last exercised — one row per authority, never history. */
export const ACCESS_USE_ENTITY = "share.authority_use";
/** What an automation has asked for and the member has not decided (#928 A4). */
export const ACCESS_REQUEST_ENTITY = "share.authority_request";
const ACCESS_LIMIT = 2_000;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `authority_id` → last-used stamp. A missing key is "never used". */
export function parseAccessUse(
  rows: readonly Record<string, unknown>[]
): Map<string, string> {
  const used = new Map<string, string>();
  for (const row of rows) {
    const id = text(row.authority_id);
    const at = text(row.last_used_at);
    if (id && at) used.set(id, at);
  }
  return used;
}

/** An OPEN ask only: a decided one is an answer next door, not a question. */
export function parseAccessRequests(
  rows: readonly Record<string, unknown>[]
): AccessRequest[] {
  return rows.flatMap((row) => {
    const requestId = text(row.request_id);
    const principalId = text(row.principal_id);
    if (!requestId || !principalId) return [];
    if (nullableText(row.decided_at) !== null) return [];
    return [
      {
        requestId,
        principalId,
        scopes: scopeLabels(row.scopes_json),
        requestedAt: text(row.requested_at),
      },
    ];
  });
}

/** The stored ask verbatim: this file words no scope of its own. */
function scopeLabels(value: unknown): string[] {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((scope) => {
    if (scope === null || typeof scope !== "object") return [];
    const row = scope as Record<string, unknown>;
    const schema = text(row.schema);
    if (!schema) return [];
    const table = text(row.table);
    const verbs = text(row.verbs);
    const target = table ? `${schema}.${table}` : schema;
    return [verbs ? `${target} · ${verbs}` : target];
  });
}

function parseAnswer(
  values: Record<string, unknown>
): AccessAnswer | undefined {
  const principalKind = PRINCIPAL_KINDS.find(
    (kind) => kind === values.principal_kind
  );
  const authorityId = text(values.authority_id);
  const verb = text(values.verb);
  // A drifted row is DROPPED, never half-drawn.
  if (!principalKind || !authorityId || !verb) return undefined;
  return {
    authorityId,
    principalKind,
    principalId: text(values.principal_id),
    subjectType: text(values.subject_type),
    subjectId: text(values.subject_id),
    verb,
    decision: values.decision === "declined" ? "declined" : "granted",
    duration: text(values.duration),
    expiresAt: nullableText(values.expires_at),
    grantedAt: text(values.granted_at),
    revokedAt: nullableText(values.revoked_at),
    lastUsedAt: null,
  };
}

/** FLAT rows — what the phone's replica hook hands back. */
export function parseAccessAnswers(
  rows: readonly Record<string, unknown>[],
  used?: ReadonlyMap<string, string>
): AccessAnswer[] {
  return rows.flatMap((row) => {
    const answer = parseAnswer(row);
    if (!answer) return [];
    const at = used?.get(answer.authorityId);
    return [at === undefined ? answer : { ...answer, lastUsedAt: at }];
  });
}

/** A device's subject is the whole vault, so `subject_id` is empty. */
export const DEVICE_SUBJECT_TYPE = "core.vault";

export function deviceStandings(
  answers: readonly AccessAnswer[]
): Map<string, AccessAnswer> {
  const byDevice = new Map<string, AccessAnswer>();
  for (const answer of answers) {
    if (answer.principalKind !== "device" || !isStanding(answer)) continue;
    if (answer.subjectType !== DEVICE_SUBJECT_TYPE) continue;
    // A refusal outranks a grant: a device the member cut off must never read
    // back as one that can reach in.
    const held = byDevice.get(answer.principalId);
    if (held && held.decision === "declined") continue;
    byDevice.set(answer.principalId, answer);
  }
  return byDevice;
}

/** `undefined` is "no answer here" — never drawn as a refusal. */
export function deviceReachLabel(
  answer: AccessAnswer | undefined
): string | undefined {
  if (!answer) return undefined;
  if (answer.decision === "declined") return "Refused at the door";
  return answer.verb === "edit" ? "Can read and write" : "Can read";
}

function isStanding(answer: AccessAnswer): boolean {
  return answer.revokedAt === null;
}

export function groupAnswers(answers: readonly AccessAnswer[]): AccessGroup[] {
  return GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    locus: group.locus,
    answers: answers
      .filter(
        (answer) =>
          isStanding(answer) && group.kinds.includes(answer.principalKind)
      )
      .sort((left, right) => right.grantedAt.localeCompare(left.grantedAt)),
  }));
}

export async function loadAccessLens(
  reader: AccessReader,
  registry: AccessRegistryReader
): Promise<AccessLens> {
  let rows: readonly { values: Record<string, unknown> }[];
  try {
    const result = await reader.read(ACCESS_SCOPE, {
      entity: ACCESS_ENTITY,
      limit: ACCESS_LIMIT,
    });
    rows = result.rows;
  } catch (error) {
    return {
      status: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  // May fail on its own: the rows the member can SEE still show.
  let loci: AccessLocusCopy = {};
  try {
    loci = parseLociBody(await registry.subjects());
  } catch {
    loci = {};
  }
  // Beside the answers, never instead of them: a failed use or ask read leaves
  // "never used" and no pending question rather than blanking the dashboard.
  const used = parseAccessUse(await sideRows(reader, ACCESS_USE_ENTITY));
  const requests = parseAccessRequests(
    await sideRows(reader, ACCESS_REQUEST_ENTITY)
  );
  const answers = parseAccessAnswers(
    rows.map((row) => row.values),
    used
  );
  return { status: "ready", groups: groupAnswers(answers), loci, requests };
}

async function sideRows(
  reader: AccessReader,
  entity: string
): Promise<Record<string, unknown>[]> {
  try {
    const result = await reader.read(ACCESS_SCOPE, {
      entity,
      limit: ACCESS_LIMIT,
    });
    return result.rows.map((row) => row.values);
  } catch {
    return [];
  }
}
