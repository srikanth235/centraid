/*
 * EDIT fulfillment (#825, ruling G-edit): where an audience's write
 * goes. The grant plane does not grow a second write rail — the commons
 * machinery IS the edit strategy — so this module only answers the routing
 * question and hands the write to `commonsGrantForCommand`. Steward
 * authorization, quota, recovery and refusal behave exactly as they did
 * before the grant plane existed; nothing here authorizes anything.
 *
 * The container a command addresses is decided by the DECLARED routing table
 * (commons-routing.ts, #750) and never by the command's name. What this
 * module adds is the same resolution read against `share_grant` instead of
 * `share_circle_grant`, so a standing grant can answer "does this write land
 * inside something I shared, and may the writer make it".
 *
 * Two v1 lines are drawn here, both refusals rather than silent successes:
 *
 *   - CO-CONTRIBUTION — an audience ADDING an item to a granted container —
 *     ships for `tally.group` only. Albums and folders are shared for their
 *     items' content in v1; an audience adding a photo to someone's album is
 *     a product decision that has not been made, and accepting the write
 *     would make it by accident.
 *   - A container with a standing EDIT grant but NO commons rail is refused,
 *     not applied. That is the #750 failure mode exactly: a write that does
 *     not reach the rail lands as a private local mutation and the next
 *     compile reverts it — silent member data loss.
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

/**
 * Commands that INTRODUCE an item into the container they address, as opposed
 * to editing the content of one already inside it. Declared, not inferred: a
 * name-shaped guess ("starts with add_") is forbidden (#750).
 */
export const SHARE_GRANT_CO_CONTRIBUTION_COMMANDS: readonly string[] = [
  "core.add_document",
  "core.create_folder",
  "media.add_to_album",
  "tally.add_expense",
];

/** The container types whose audience may co-contribute in v1. */
export const SHARE_GRANT_CO_CONTRIBUTION_TYPES: readonly ShareableItemType[] = [
  "tally.group",
];

export interface ShareGrantEditRoute {
  /** The command that was routed — carried so a caller can re-derive the
   * refusal against a narrower set of grants (see `shareGrantEditRefusal`). */
  command: string;
  containerType: ShareableItemType;
  /** The container in ORIGIN ids — the subject of the grants below. */
  containerId: string;
  /** Live standing grants over that container, view and edit alike. */
  grants: readonly ShareGrantRecord[];
  /** The commons grant the write delegates to, when the rail carries one. */
  commonsGrantId?: string;
  /** Is the command part of the container type's declared write surface? */
  actable: boolean;
  /** Why the grant plane will not accept this write. Absent when it will. */
  refusal?: string;
}

/**
 * Container ids one declared route could be addressing, NEAREST FIRST. A
 * document inside a shared subtree resolves to the folder that encloses it
 * most closely, which is what keeps a shared subtree one share.
 */
function candidateContainers(
  db: DatabaseSync,
  route: CommonsCommandRoute,
  value: string
): string[] {
  if (route.resolution === "container") return [value];
  if (route.resolution === "tally-expense") {
    const row = db
      .prepare("SELECT group_id FROM tally_expense WHERE expense_id = ?")
      .get(value) as { group_id: string } | undefined;
    return row ? [row.group_id] : [];
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

/** A folder and every folder above it, nearest first. */
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

/**
 * The same refusal, re-derived against a NARROWER set of grants than the
 * container's — the ones that actually reach the party making the write.
 *
 * `routeShareGrantEdit` answers about a container, so its `refusal` is the
 * container's whole grant set folded together: one party's edit grant silences
 * "shared for view only" for everyone the container is shared with. That is
 * the right answer to the container question and the WRONG answer to the actor
 * question — a view-only audience member is not permitted by someone else's
 * edit grant. A caller that knows who is writing (the gateway seam) passes
 * that actor's own grants here and gets the capability line drawn where the
 * grants drew it: per audience, never per container.
 */
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

/**
 * Where an ordinary command lands in the grant plane, or `undefined` when it
 * addresses nothing anyone has shared — which is the overwhelming majority of
 * writes, and must stay indistinguishable from the world before grants.
 */
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
      // The delegation target, read through the commons resolver itself so
      // the rail's own routing decision — not a copy of it — is what a caller
      // hands the write to.
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
