/*
 * EDIT fulfillment (#825). NOTHING HERE AUTHORIZES ANYTHING: routing only, over
 * the DECLARED table (commons-routing.ts) and never the command's name. Two v1
 * REFUSALS, never silent successes — co-contribution ships for `tally.group`
 * alone, and an edit grant with no commons rail is refused, because a write off
 * the rail is a local mutation the next compile reverts.
 */

import type { DatabaseSync } from "node:sqlite";

import type { ShareableItemType } from "../share/closure.js";
import {
  commonsRoutesForCommand,
  isCommonsCommandActable,
} from "../share/commons-routing.js";
import type { CommonsCommandRoute } from "../share/commons-routing.js";
import { commonsGrantForCommand } from "../share/commons.js";
import type { ShareGrantRecord } from "./grant-store.js";
import { listShareGrantsForSubject } from "./grant-store.js";
import { SHARE_SUBJECT_REGISTRY } from "./subject-registry.js";

/** Commands that INTRODUCE an item. Declared, never inferred (#750). */
export const SHARE_GRANT_CO_CONTRIBUTION_COMMANDS: readonly string[] = [
  "core.add_document",
  "core.create_folder",
  "media.add_to_album",
  "tally.add_expense",
];

/**
 * Container types whose audience may co-contribute, DERIVED from the registry
 * rather than listed again (#883): a hand-kept second list can disagree with
 * the subject registry's `edit` declaration, a derivation cannot.
 */
export const SHARE_GRANT_CO_CONTRIBUTION_TYPES: readonly ShareableItemType[] =
  SHARE_SUBJECT_REGISTRY.filter(
    (subject) => subject.fulfillment.edit === "commons-routing"
  ).map((subject) => subject.subjectType);

export interface ShareGrantEditRoute {
  command: string;
  containerType: ShareableItemType;
  /** ORIGIN ids. */
  containerId: string;
  /** Every live grant over it, view and edit alike. */
  grants: readonly ShareGrantRecord[];
  commonsGrantId?: string;
  actable: boolean;
  /** Absent when the write will be accepted. */
  refusal?: string;
}

/** NEAREST FIRST: the closest folder keeps a subtree one share. */
function candidateContainers(
  db: DatabaseSync,
  route: CommonsCommandRoute,
  value: string
): string[] {
  if (route.resolution === "container") return [value];
  if (route.resolution === "tally-expense") {
    const row = db
      .prepare("SELECT group_id FROM tally_expense WHERE expense_id = ?")
      .get(value) as { group_id: string | null } | undefined;
    // A group-less 1:1 expense names no container, so there is nothing to
    // route it to and nothing to refuse it against.
    return row?.group_id ? [row.group_id] : [];
  }
  if (route.resolution === "folder-descendant")
    return ancestorFolders(db, value);
  return (
    db
      .prepare(
        `SELECT concept_id FROM core_tag
          WHERE target_type = 'core.document' AND target_id = ?
          ORDER BY tag_id`
      )
      .all(value) as { concept_id: string }[]
  ).flatMap((tag) => ancestorFolders(db, tag.concept_id));
}

function ancestorFolders(db: DatabaseSync, folderId: string): string[] {
  return (
    db
      .prepare(
        `WITH RECURSIVE ancestors(concept_id, depth) AS (
           SELECT ?, 0
           UNION ALL
           SELECT c.broader_concept_id, a.depth + 1
             FROM core_concept c
             JOIN ancestors a ON c.concept_id = a.concept_id
            WHERE c.broader_concept_id IS NOT NULL
         )
         SELECT concept_id FROM ancestors ORDER BY depth`
      )
      .all(folderId) as { concept_id: string }[]
  ).map((row) => row.concept_id);
}

function refusalFor(input: {
  command: string;
  containerType: ShareableItemType;
  containerId: string;
  grants: readonly ShareGrantRecord[];
  actable: boolean;
  commonsGrantId?: string;
}): string | undefined {
  if (!input.grants.some((grant) => grant.capability === "edit"))
    return `${input.command} writes into ${input.containerType} ${input.containerId}, which is shared for view only`;
  if (!input.actable)
    return `command ${input.command} is not declared for ${input.containerType}`;
  if (
    SHARE_GRANT_CO_CONTRIBUTION_COMMANDS.includes(input.command) &&
    !SHARE_GRANT_CO_CONTRIBUTION_TYPES.includes(input.containerType)
  )
    return `co-contribution to ${input.containerType} is not offered in v1`;
  if (input.commonsGrantId === undefined)
    return `${input.containerType} ${input.containerId} has no commons rail to route ${input.command} to`;
  return undefined;
}

/** Against only the grants reaching the WRITER: the route's `refusal` folds
 *  the whole container, so one edit grant would silence "view only" for
 *  everyone. Per audience, never per container. */
export function shareGrantEditRefusal(
  route: ShareGrantEditRoute,
  grants: readonly ShareGrantRecord[]
): string | undefined {
  return refusalFor({
    command: route.command,
    containerType: route.containerType,
    containerId: route.containerId,
    grants,
    actable: route.actable,
    ...(route.commonsGrantId === undefined
      ? {}
      : { commonsGrantId: route.commonsGrantId }),
  });
}

/** `undefined` when nothing shared is addressed. */
export function routeShareGrantEdit(
  db: DatabaseSync,
  input: { command: string; commandInput: Record<string, unknown> }
): ShareGrantEditRoute | undefined {
  for (const route of commonsRoutesForCommand(input.command)) {
    const value = input.commandInput[route.inputKey];
    if (typeof value !== "string" || !value) continue;
    for (const containerId of candidateContainers(db, route, value)) {
      const grants = listShareGrantsForSubject(
        db,
        route.containerType,
        containerId
      );
      if (grants.length === 0) continue;
      const actable = isCommonsCommandActable(
        route.containerType,
        input.command
      );
      // The rail's own decision, never a copy of it.
      const commonsGrantId = commonsGrantForCommand(
        db,
        input.command,
        input.commandInput
      )?.grantId;
      const refusal = refusalFor({
        command: input.command,
        containerType: route.containerType,
        containerId,
        grants,
        actable,
        ...(commonsGrantId === undefined ? {} : { commonsGrantId }),
      });
      return {
        command: input.command,
        containerType: route.containerType,
        containerId,
        grants,
        ...(commonsGrantId === undefined ? {} : { commonsGrantId }),
        actable,
        ...(refusal === undefined ? {} : { refusal }),
      };
    }
  }
  return undefined;
}
