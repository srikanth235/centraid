// The command sibling of the placement registry (issue #731 B4). Commons
// writes are refused at the steward unless the shared container declares the
// exact command. UI filtering is never the security boundary.

import type { ShareableItemType } from "./closure.js";

export const COMMONS_COMMANDS: ReadonlyMap<
  ShareableItemType,
  ReadonlySet<string>
> = new Map([
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
      "core.move_document",
      "core.create_folder",
      "core.rename_folder",
    ]),
  ],
]);

export interface CommonsCommandRoute {
  containerType: ShareableItemType;
  /** Exact commands routed through this container before authorization. */
  commands: ReadonlySet<string>;
  /** Input fields which directly identify the shared container. */
  containerIdKeys: readonly string[];
  /** Optional child identifier resolved to the containing shared container. */
  childIdKeys: readonly string[];
}

const noCommands: ReadonlySet<string> = new Set();

/**
 * The single data declaration for command-to-Commons routing. Entries without
 * commands are deliberate refusal routes: an unknown write which explicitly
 * targets an active shared container must reach the Commons authorization
 * door and be denied, never mutate a private replica which the next compile
 * would silently overwrite.
 */
export const COMMONS_COMMAND_ROUTES: readonly CommonsCommandRoute[] = [
  {
    containerType: "docs.folder",
    commands: COMMONS_COMMANDS.get("docs.folder") ?? noCommands,
    containerIdKeys: ["folder_id", "parent_folder_id"],
    childIdKeys: ["document_id"],
  },
  {
    containerType: "tally.group",
    commands: COMMONS_COMMANDS.get("tally.group") ?? noCommands,
    containerIdKeys: ["group_id"],
    childIdKeys: ["expense_id"],
  },
  {
    containerType: "core.document",
    commands: COMMONS_COMMANDS.get("core.document") ?? noCommands,
    containerIdKeys: ["document_id"],
    childIdKeys: [],
  },
  {
    containerType: "core.collection",
    commands: noCommands,
    containerIdKeys: ["collection_id"],
    childIdKeys: [],
  },
  {
    containerType: "media.asset",
    commands: noCommands,
    containerIdKeys: ["asset_id", "media_asset_id"],
    childIdKeys: [],
  },
  {
    containerType: "core.content_item",
    commands: noCommands,
    containerIdKeys: ["content_id", "content_item_id"],
    childIdKeys: [],
  },
  {
    containerType: "locker.item",
    commands: noCommands,
    containerIdKeys: ["item_id", "locker_item_id"],
    childIdKeys: [],
  },
];

export function isCommonsCommandActable(
  containerType: ShareableItemType,
  command: string
): boolean {
  return COMMONS_COMMANDS.get(containerType)?.has(command) === true;
}

export function commonsCommandsFor(
  containerType: ShareableItemType
): readonly string[] {
  return [...(COMMONS_COMMANDS.get(containerType) ?? [])].toSorted();
}
