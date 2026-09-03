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
}

export type AccessPrincipalKind = "person" | "circle" | "harness" | "device";

const PRINCIPAL_KINDS: readonly AccessPrincipalKind[] = [
  "person",
  "circle",
  "harness",
  "device",
];

export interface AccessGroup {
  id: "audiences" | "harnesses" | "devices";
  title: string;
  locus: GrantLocus;
  answers: AccessAnswer[];
}

export type AccessLocusCopy = Partial<Record<GrantLocus, string>>;

export type AccessLens =
  | { status: "ready"; groups: AccessGroup[]; loci: AccessLocusCopy }
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
const ACCESS_LIMIT = 2_000;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseAnswer(
  values: Record<string, unknown>
): AccessAnswer | undefined {
  const principalKind = PRINCIPAL_KINDS.find(
    (kind) => kind === values.principal_kind
  );
  const authorityId = text(values.authority_id);
  const verb = text(values.verb);
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
  };
}

export function parseAccessAnswers(
  rows: readonly Record<string, unknown>[]
): AccessAnswer[] {
  return rows.flatMap((row) => {
    const answer = parseAnswer(row);
    return answer ? [answer] : [];
  });
}

export const DEVICE_SUBJECT_TYPE = "core.vault";

export function deviceStandings(
  answers: readonly AccessAnswer[]
): Map<string, AccessAnswer> {
  const byDevice = new Map<string, AccessAnswer>();
  for (const answer of answers) {
    if (answer.principalKind !== "device" || !isStanding(answer)) continue;
    if (answer.subjectType !== DEVICE_SUBJECT_TYPE) continue;
    const held = byDevice.get(answer.principalId);
    if (held && held.decision === "declined") continue;
    byDevice.set(answer.principalId, answer);
  }
  return byDevice;
}

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
  let loci: AccessLocusCopy = {};
  try {
    loci = parseLociBody(await registry.subjects());
  } catch {
    loci = {};
  }
  const answers = parseAccessAnswers(rows.map((row) => row.values));
  return { status: "ready", groups: groupAnswers(answers), loci };
}
