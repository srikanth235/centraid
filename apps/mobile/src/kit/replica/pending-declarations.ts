// appId → pending-projection declaration, for retrying a durable attention
// row (issue #738) from the device-global sync-status sheet.
//
// `ReplicaStatusBar` renders one row per unsettled/attention write across
// EVERY mounted app, but a projection declaration is per-app config
// (`PendingProjectionDeclaration`, `_shared/pending-overlay`). Each screen
// already imports its own declaration to build the optimistic mutations for
// its writes (`pendingProjector`, ./pending-rows); this is the same map, kept
// once so the sheet's Retry affordance can rebuild the right pending row for
// whichever app's write is being retried, without importing every app's
// screen module.
//
// Apps with no declaration (assistant, automations, insights, locker) simply
// retry with no optimistic projection: the write still re-issues, it just
// does not get a pending row back until the next read.

import type { PendingProjectionDeclaration } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { agendaPendingProjection } from "@centraid/blueprints/apps/agenda/pending-projection";
import { docsPendingProjection } from "@centraid/blueprints/apps/docs/pending-projection";
import { notesPendingProjection } from "@centraid/blueprints/apps/notes/pending-projection";
import { peoplePendingProjection } from "@centraid/blueprints/apps/people/pending-projection";
import { photosPendingProjection } from "@centraid/blueprints/apps/photos/pending-projection";
import { tallyPendingProjection } from "@centraid/blueprints/apps/tally/pending-projection";
import { tasksPendingProjection } from "@centraid/blueprints/apps/tasks/pending-projection";

export const PENDING_DECLARATIONS: Readonly<
  Record<string, PendingProjectionDeclaration>
> = {
  agenda: agendaPendingProjection,
  docs: docsPendingProjection,
  notes: notesPendingProjection,
  people: peoplePendingProjection,
  photos: photosPendingProjection,
  tally: tallyPendingProjection,
  tasks: tasksPendingProjection,
};
