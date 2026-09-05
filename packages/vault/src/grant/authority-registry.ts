// The AUTHORITY REGISTRY (#883 V-registry): the closed declaration of which
// (principal_kind × subject_type × verb) triples this vault writes into
// `share_authority`, and what keeps each true. `share_authority.verb` is a free
// string at the schema because the vocabulary is PER TRIPLE — so this file is
// where it closes, and a verb outside it is refused at `commands/share.ts`.
//
// A structural exclusion is a type-level ABSENCE, never a row that says no. The
// subject half composes `subject-registry.ts` rather than restating it.

import type { ShareableItemType } from "../share/closure.js";
import { SHARE_SUBJECT_REGISTRY } from "./subject-registry.js";
import type { ShareFulfillmentStrategy } from "./subject-registry.js";

// `app` is absent BY TYPE, not by an empty row: first-party apps are the
// owner's own screens and are not principals (#928 A1), and the reserved
// third-party door would be a new answer rather than a new value here.
export type AuthorityPrincipalKind =
  | "person"
  | "circle"
  | "harness"
  | "device"
  | "automation";

export type AuthorityStrategy =
  | ShareFulfillmentStrategy
  | "device-attenuation"
  | "enrichment-gate"
  | "execution-clamp";

export type EnforcementLocus = "local" | "boundary" | "remote";

export function enforcementLocus(
  principalKind: AuthorityPrincipalKind
): EnforcementLocus {
  // An automation runs inside this vault's own engine, so the only thing that
  // ever called it is the thing that stops calling it — the same argument that
  // puts a harness here (V-locus).
  if (principalKind === "harness" || principalKind === "automation")
    return "local";
  if (principalKind === "device") return "boundary";
  return "remote";
}

// `contract` names the authority that closes the list (#807) instead of
// copying it: a second copy inside the vault is a second place to drift.
export type AuthorityVerbs =
  | { kind: "closed"; verbs: readonly string[] }
  | { kind: "contract"; closedBy: string };

export interface AuthorityTriple {
  principalKind: AuthorityPrincipalKind;
  subjectType: string;
  verbs: AuthorityVerbs;
  strategyFor: Readonly<Record<string, AuthorityStrategy>>;
  citation: string;
  // A generous superset by design: a missing type is a share that silently
  // stops following its subject; a surplus costs one skipped delivery pass.
  wakesOn?: readonly string[];
  subjectRow?: { table: string; pk: string };
}

// A container's family includes every member type's: the doorbell names
// committed ENTITY TYPES, and a photo added to an album commits the entry row.
const CONTENT_FAMILY = [
  "core.content_item",
  "core.content_derivative",
] as const;
const DOCUMENT_FAMILY = ["core.document", ...CONTENT_FAMILY] as const;
const MEDIA_FAMILY = ["media.asset", ...CONTENT_FAMILY] as const;
const FOLDER_FAMILY = ["core.concept", "core.tag", ...DOCUMENT_FAMILY] as const;
const COLLECTION_FAMILY = [
  "core.collection",
  "core.collection_entry",
  ...DOCUMENT_FAMILY,
  ...MEDIA_FAMILY,
] as const;
const TALLY_FAMILY = [
  "tally.group",
  "tally.expense",
  "tally.expense_line_item",
  "tally.settlement",
  "tally.recurring_expense",
  "tally.obligation",
  "core.attachment",
  "social.circle",
  "social.circle_member",
  "core.party",
  ...CONTENT_FAMILY,
] as const;

const SHARE_SUBJECT_FAMILY: Readonly<
  Record<ShareableItemType, readonly string[] | undefined>
> = {
  "core.collection": COLLECTION_FAMILY,
  "core.content_item": CONTENT_FAMILY,
  "core.document": DOCUMENT_FAMILY,
  "docs.folder": FOLDER_FAMILY,
  "media.asset": MEDIA_FAMILY,
  "tally.group": TALLY_FAMILY,
  "locker.item": undefined,
};

const SHARE_SUBJECT_ROW: Readonly<
  Record<ShareableItemType, { table: string; pk: string } | undefined>
> = {
  "core.collection": { table: "core_collection", pk: "collection_id" },
  "core.content_item": { table: "core_content_item", pk: "content_id" },
  "core.document": { table: "core_document", pk: "document_id" },
  "docs.folder": { table: "core_concept", pk: "concept_id" },
  "media.asset": { table: "media_asset", pk: "asset_id" },
  "tally.group": { table: "tally_group", pk: "group_id" },
  "locker.item": undefined,
};

function shareTriples(): AuthorityTriple[] {
  const triples: AuthorityTriple[] = [];
  for (const kind of ["person", "circle"] as const) {
    for (const subject of SHARE_SUBJECT_REGISTRY) {
      const strategyFor: Record<string, AuthorityStrategy> = {
        view: subject.fulfillment.view,
      };
      if (subject.fulfillment.edit) strategyFor.edit = subject.fulfillment.edit;
      const family = SHARE_SUBJECT_FAMILY[subject.subjectType];
      const row = SHARE_SUBJECT_ROW[subject.subjectType];
      triples.push({
        principalKind: kind,
        subjectType: subject.subjectType,
        verbs: { kind: "closed", verbs: Object.keys(strategyFor) },
        strategyFor,
        citation: "#883 V-registry over #825 G-view/G-edit and #750",
        ...(family ? { wakesOn: family } : {}),
        ...(row ? { subjectRow: row } : {}),
      });
    }
  }
  return triples;
}

export const AUTHORITY_REGISTRY: readonly AuthorityTriple[] = [
  ...shareTriples(),
  {
    principalKind: "device",
    subjectType: "core.vault",
    verbs: { kind: "closed", verbs: ["view", "edit"] },
    strategyFor: { view: "device-attenuation", edit: "device-attenuation" },
    citation: "#883 V-split and V-locus",
  },
  // A COMPANION DEVICE'S ATTENUATION (#928 A6). The device row above answers
  // "may this device act on this vault at all"; this one answers "over which
  // of the owner's surfaces", one row per surface. It is fulfilled at the
  // gateway boundary, ahead of any vault open, from a projection of these
  // rows — so the strategy is the same `device-attenuation` the vault-wide
  // device answer uses, and the locus is the same one.
  {
    principalKind: "device",
    subjectType: "app.surface",
    verbs: { kind: "closed", verbs: ["use"] },
    strategyFor: { use: "device-attenuation" },
    citation: "#928 A6 over #883 V-split",
  },
  {
    principalKind: "harness",
    subjectType: "enrich.scope",
    verbs: { kind: "contract", closedBy: "#807 capability contract registry" },
    strategyFor: {},
    citation: "#883 V-split over #807",
  },
  // AN EGRESS ANSWER (#928 A6): the standing "always allow" for an external
  // write, minted from a concrete outbox item rather than configured up front
  // (#306 decision 3). The subject is the destination, the verb the semantic
  // capability (`gmail.send`) — a capability plus an egress class, which is
  // what the enrichment gate decides on, so the verb vocabulary is closed by
  // the connector contract rather than restated here. Two principals, because
  // the outbox has two kinds of actor: an automation, and the owner's own
  // surfaces, which reach it on the device credential.
  {
    principalKind: "device",
    subjectType: "egress",
    verbs: { kind: "contract", closedBy: "#304 connection verb contract" },
    strategyFor: {},
    citation: "#928 A6 over #306 decision 3",
  },
  {
    principalKind: "automation",
    subjectType: "egress",
    verbs: { kind: "contract", closedBy: "#304 connection verb contract" },
    strategyFor: {},
    citation: "#928 A6 over #306 decision 3",
  },
  // AN AUTOMATION'S STANDING ANSWER (#928 A3), accepted before its writer
  // exists: wave 3 mints these rows from the compiled manifest. Its manifest
  // asks for either a whole schema — which is one command pack, `agent.pack`
  // with the schema name as `subject_id` — or one entity of it, `core.entity`
  // with the dotted entity type as `subject_id`; an automation is answered
  // about a CLASS of rows, never about one row, which is why the subject id is
  // a type name. `reveal` is absent by type: a sealed reveal is Locker's
  // permit, never a standing grant (#873, and #750 for the same reason
  // `locker.item` has no share triple).
  //
  // Both fulfil the same way — the per-run execution clamp cuts the identity
  // down to what the row says before the automation's first `ctx.vault` call —
  // which is also why the locus is local.
  {
    principalKind: "automation",
    subjectType: "agent.pack",
    verbs: { kind: "closed", verbs: ["read", "act"] },
    strategyFor: { read: "execution-clamp", act: "execution-clamp" },
    citation: "#928 A3 over #883 V-registry",
  },
  {
    principalKind: "automation",
    subjectType: "core.entity",
    verbs: { kind: "closed", verbs: ["read", "act"] },
    strategyFor: { read: "execution-clamp", act: "execution-clamp" },
    citation: "#928 A3 over #883 V-registry",
  },
];

const BY_KEY = new Map<string, AuthorityTriple>(
  AUTHORITY_REGISTRY.map((triple) => [
    `${triple.principalKind}\0${triple.subjectType}`,
    triple,
  ])
);

export function authorityTriple(
  principalKind: string,
  subjectType: string
): AuthorityTriple | undefined {
  return BY_KEY.get(`${principalKind}\0${subjectType}`);
}

export function authorityStrategyFor(
  principalKind: string,
  subjectType: string,
  verb: string
): AuthorityStrategy | undefined {
  const triple = authorityTriple(principalKind, subjectType);
  if (!triple) return undefined;
  if (triple.verbs.kind === "contract") return "enrichment-gate";
  if (!triple.verbs.verbs.includes(verb)) return undefined;
  return triple.strategyFor[verb];
}

export function isRegisteredAuthority(
  principalKind: string,
  subjectType: string,
  verb: string
): boolean {
  return authorityStrategyFor(principalKind, subjectType, verb) !== undefined;
}

export function registeredVerbs(
  principalKind: string,
  subjectType: string
): readonly string[] {
  const triple = authorityTriple(principalKind, subjectType);
  if (!triple || triple.verbs.kind === "contract") return [];
  return triple.verbs.verbs;
}

export function wakeTypesForSubjectTypes(
  subjectTypes: Iterable<string>
): Set<string> {
  const wake = new Set<string>();
  for (const subjectType of subjectTypes) {
    for (const kind of ["person", "circle"] as const) {
      const triple = authorityTriple(kind, subjectType);
      for (const entity of triple?.wakesOn ?? []) wake.add(entity);
    }
  }
  return wake;
}

export function subjectWokenBy(
  subjectType: string,
  committed: ReadonlySet<string>
): boolean {
  const family = wakeTypesForSubjectTypes([subjectType]);
  for (const entity of committed) if (family.has(entity)) return true;
  return false;
}
