// The command sibling of the placement registry (issue #731 B4). Commons
// writes are refused at the steward unless the shared container declares the
// exact command. UI filtering is never the security boundary.

import type { ShareableItemType } from "./closure.js";

const ACTABLE = new Map<ShareableItemType, ReadonlySet<string>>([
  [
    "tally.group",
    new Set([
      "tally.add_expense",
      "tally.edit_expense",
      "tally.delete_expense",
      "tally.restore_expense",
      "tally.settle_up",
      "tally.add_group_member",
      "tally.remove_group_member",
      "tally.rename_group",
    ]),
  ],
  [
    "core.document",
    new Set([
      "core.rename_document",
      "core.edit_document",
      "core.replace_document_content",
      "core.trash_document",
      "core.restore_document",
    ]),
  ],
  [
    "docs.folder",
    new Set([
      "core.add_document",
      "core.rename_document",
      "core.edit_document",
      "core.replace_document_content",
      "core.trash_document",
      "core.restore_document",
      "core.delete_document",
      "core.move_document",
      "core.create_folder",
      "core.rename_folder",
    ]),
  ],
  [
    "core.collection",
    new Set([
      "core.add_collection_entry",
      "core.remove_collection_entry",
      "core.rename_collection",
    ]),
  ],
]);

export function isCommonsCommandActable(
  containerType: ShareableItemType,
  command: string
): boolean {
  return ACTABLE.get(containerType)?.has(command) === true;
}

/** App-owned declarations reach one structural registry, never render-only
 * filtering. Passing an empty list deliberately closes the write surface. */
export function declareCommonsCommands(
  containerType: ShareableItemType,
  commands: readonly string[]
): void {
  ACTABLE.set(containerType, new Set(commands));
}

export function commonsCommandsFor(
  containerType: ShareableItemType
): readonly string[] {
  return [...(ACTABLE.get(containerType) ?? [])].toSorted();
}
