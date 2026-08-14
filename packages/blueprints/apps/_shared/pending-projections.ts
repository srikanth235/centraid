import agenda from "../agenda/pending-projection.js";
import docs from "../docs/pending-projection.js";
import locker from "../locker/pending-projection.js";
import notes from "../notes/pending-projection.js";
import people from "../people/pending-projection.js";
import photos from "../photos/pending-projection.js";
import tally from "../tally/pending-projection.js";
import tasks from "../tasks/pending-projection.js";
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
