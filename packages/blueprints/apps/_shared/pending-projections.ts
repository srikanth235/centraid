import { agendaPendingProjection as agenda } from "../agenda/pending-projection.js";
import { docsPendingProjection as docs } from "../docs/pending-projection.js";
import { lockerPendingProjection as locker } from "../locker/pending-projection.js";
import { notesPendingProjection as notes } from "../notes/pending-projection.js";
import { peoplePendingProjection as people } from "../people/pending-projection.js";
import { photosPendingProjection as photos } from "../photos/pending-projection.js";
import { tallyPendingProjection as tally } from "../tally/pending-projection.js";
import { tasksPendingProjection as tasks } from "../tasks/pending-projection.js";
import type { PendingProjectionDeclaration } from "./pending-overlay.js";

const DECLARATIONS = new Map<string, PendingProjectionDeclaration>(
  [agenda, docs, locker, notes, people, photos, tally, tasks].map(
    (declaration) => [declaration.appId, declaration]
  )
);

export function pendingProjectionFor(
  appId: string
): PendingProjectionDeclaration | undefined {
  return DECLARATIONS.get(appId);
}

// Hermes on the native client does not provide the ES2023 non-mutating sort
// helpers. Keep the copy-before-sort semantics without requiring a polyfill.
export const PENDING_PROJECTION_APP_IDS = [...DECLARATIONS.keys()].sort();
