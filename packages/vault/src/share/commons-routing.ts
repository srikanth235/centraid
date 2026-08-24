// The DECLARED command→container routing table for the Commons plane
// (issue #750). This file is the single source of truth `commonsGrantForCommand`
// consults; routing is decided by DECLARATION here, never by the shape of a
// command name (`command.includes("folder")`) or of its input keys.
//
// Why data and not code: a command that writes into a shared container but
// does not reach the commons rail lands as a PRIVATE local mutation, and the
// next compile reverts it — silent member data loss. Under heuristics that
// happened whenever an input key was renamed. Here the routing is a table, and
// `commons-routing.test.ts` walks the real registered command schemas and
// fails when a declared key is not in the command's `inputSchema`, or when a
// command in a declared owner schema grows a container key with no route.
//
// Two independent facts live on each row:
//
//   * ROUTABLE — the command's input can address this container type, so it
//     must reach the rail. Every routable command is refused or sequenced by
//     the commons authorization path; none of them falls through to a private
//     write.
//   * ACTABLE — the container type DECLARES this command as part of its
//     shared write surface. A routable-but-not-actable command is refused at
//     the steward with a named reason ("… is not declared for …"). UI
//     filtering is never the security boundary.

import type { ShareableItemType } from "./closure.js";

/**
 * How a declared input key names the grant's container.
 *
 * - `container` — the key holds the container's own id.
 * - `folder-descendant` — the key holds a folder id at, or under, the
 *   granted `docs.folder` root.
 * - `folder-document` — the key holds a document id filed anywhere under the
 *   granted `docs.folder` root.
 * - `tally-expense` — the key holds an expense id whose group is the
 *   granted `tally.group`.
 */
export type CommonsRouteResolution =
  | "container"
  | "folder-descendant"
  | "folder-document"
  | "tally-expense";

/** One declared (command, input key) → container-type route. */
export interface CommonsCommandRoute {
  command: string;
  /** The command pack that owns the key (`agent_command.owner_schema`). */
  ownerSchema: string;
  inputKey: string;
  containerType: ShareableItemType;
  resolution: CommonsRouteResolution;
  /** Declared member/steward write surface for that container type. */
  actable: boolean;
}

/**
 * The key VOCABULARY: which (owner schema, input key) pairs address a
 * shareable container at all, and how. The conformance test uses this to
 * decide which registered commands are REQUIRED to carry a route, so a new
 * command that grows a `group_id` cannot quietly skip the rail. Scoping by
 * owner schema is deliberate: `home.update_item` and `outbox.decide` also
 * carry an `item_id`, and they address rows in another domain entirely.
 */
export interface CommonsContainerKey {
  ownerSchema: string;
  inputKey: string;
  containerType: ShareableItemType;
  resolution: CommonsRouteResolution;
}

export const COMMONS_CONTAINER_KEYS: readonly CommonsContainerKey[] = [
  {
    ownerSchema: "tally",
    inputKey: "group_id",
    containerType: "tally.group",
    resolution: "container",
  },
  {
    ownerSchema: "tally",
    inputKey: "expense_id",
    containerType: "tally.group",
    resolution: "tally-expense",
  },
  {
    ownerSchema: "core",
    inputKey: "document_id",
    containerType: "docs.folder",
    resolution: "folder-document",
  },
  {
    ownerSchema: "core",
    inputKey: "document_id",
    containerType: "core.document",
    resolution: "container",
  },
  {
    ownerSchema: "core",
    inputKey: "folder_id",
    containerType: "docs.folder",
    resolution: "folder-descendant",
  },
  {
    ownerSchema: "core",
    inputKey: "parent_folder_id",
    containerType: "docs.folder",
    resolution: "folder-descendant",
  },
  {
    ownerSchema: "core",
    inputKey: "content_id",
    containerType: "core.content_item",
    resolution: "container",
  },
  {
    ownerSchema: "knowledge",
    inputKey: "content_id",
    containerType: "core.content_item",
    resolution: "container",
  },
  {
    ownerSchema: "media",
    inputKey: "album_id",
    containerType: "core.collection",
    resolution: "container",
  },
  {
    ownerSchema: "media",
    inputKey: "asset_id",
    containerType: "media.asset",
    resolution: "container",
  },
  {
    ownerSchema: "enrich",
    inputKey: "asset_id",
    containerType: "media.asset",
    resolution: "container",
  },
  {
    ownerSchema: "locker",
    inputKey: "item_id",
    containerType: "locker.item",
    resolution: "container",
  },
];

/** Terse row builder — the table below is long and reads as data, not code. */
function route(
  command: string,
  ownerSchema: string,
  inputKey: string,
  containerType: ShareableItemType,
  resolution: CommonsRouteResolution,
  actable = false
): CommonsCommandRoute {
  return {
    command,
    ownerSchema,
    inputKey,
    containerType,
    resolution,
    actable,
  };
}

const tallyGroup = (command: string, actable = false): CommonsCommandRoute =>
  route(command, "tally", "group_id", "tally.group", "container", actable);
const tallyExpense = (command: string, actable = false): CommonsCommandRoute =>
  route(
    command,
    "tally",
    "expense_id",
    "tally.group",
    "tally-expense",
    actable
  );
const inFolder = (command: string, actable = false): CommonsCommandRoute =>
  route(
    command,
    "core",
    "document_id",
    "docs.folder",
    "folder-document",
    actable
  );
const onDocument = (command: string, actable = false): CommonsCommandRoute =>
  route(command, "core", "document_id", "core.document", "container", actable);
const onFolder = (
  command: string,
  inputKey: "folder_id" | "parent_folder_id",
  actable = false
): CommonsCommandRoute =>
  route(command, "core", inputKey, "docs.folder", "folder-descendant", actable);
const onContent = (
  command: string,
  ownerSchema = "core"
): CommonsCommandRoute =>
  route(command, ownerSchema, "content_id", "core.content_item", "container");
const onAsset = (command: string, ownerSchema = "media"): CommonsCommandRoute =>
  route(command, ownerSchema, "asset_id", "media.asset", "container");
const onAlbum = (command: string): CommonsCommandRoute =>
  route(command, "media", "album_id", "core.collection", "container");
const onLockerItem = (command: string): CommonsCommandRoute =>
  route(command, "locker", "item_id", "locker.item", "container");

/**
 * Declaration order IS resolution order: `commonsGrantForCommand` walks a
 * command's routes top to bottom and returns the first active grant. A
 * document that lives inside a shared folder resolves to the FOLDER's grant
 * before its own, which is what keeps a shared subtree one commons.
 */
export const COMMONS_COMMAND_ROUTES: readonly CommonsCommandRoute[] = [
  // Tally — the one container type with a full declared write surface.
  tallyGroup("tally.add_expense", true),
  tallyGroup("tally.add_group_member", true),
  tallyGroup("tally.remove_group_member", true),
  tallyGroup("tally.rename_group", true),
  tallyGroup("tally.settle_up", true),
  tallyExpense("tally.edit_expense", true),
  tallyExpense("tally.delete_expense", true),
  tallyExpense("tally.restore_expense", true),
  // Routable, NOT declared: these reach the rail so the steward refuses them
  // by name instead of writing privately into a shared group.
  tallyGroup("tally.add_receipt_expense"),
  tallyGroup("tally.delete_group"),
  tallyGroup("tally.save_recurring_expense"),
  tallyExpense("tally.bind_txn"),
  tallyExpense("tally.set_expense_memo"),
  tallyExpense("tally.undo_expense"),

  // Documents and folders. Every document command resolves against an
  // enclosing shared folder first, then against the document's own grant.
  onFolder("core.add_document", "folder_id", true),
  onFolder("core.create_folder", "parent_folder_id", true),
  onFolder("core.rename_folder", "folder_id", true),
  onFolder("core.delete_folder", "folder_id"),
  inFolder("core.rename_document", true),
  onDocument("core.rename_document", true),
  inFolder("core.edit_document", true),
  onDocument("core.edit_document", true),
  inFolder("core.replace_document_content", true),
  onDocument("core.replace_document_content", true),
  inFolder("core.trash_document", true),
  onDocument("core.trash_document", true),
  inFolder("core.restore_document", true),
  onDocument("core.restore_document", true),
  inFolder("core.move_document", true),
  onDocument("core.move_document"),
  onFolder("core.move_document", "folder_id", true),
  inFolder("core.star_document"),
  onDocument("core.star_document"),
  inFolder("core.unstar_document"),
  onDocument("core.unstar_document"),
  inFolder("core.restore_document_version"),
  onDocument("core.restore_document_version"),
  onContent("core.restore_document_version"),
  onContent("core.attach"),
  onContent("core.set_extracted_text"),
  onContent("knowledge.restore_note_version", "knowledge"),

  // Albums and photos. No declared write surface yet: a command that
  // addresses a shared album or asset is refused, never applied privately.
  onAlbum("media.add_to_album"),
  onAsset("media.add_to_album"),
  onAlbum("media.remove_from_album"),
  onAsset("media.remove_from_album"),
  onAlbum("media.set_album_cover"),
  onAsset("media.set_album_cover"),
  onAlbum("media.rename_album"),
  onAlbum("media.delete_album"),
  onAlbum("media.restore_album"),
  onAsset("media.delete_asset"),
  onAsset("media.purge_asset"),
  onAsset("media.restore_asset"),
  onAsset("media.set_archived"),
  onAsset("media.set_asset_place"),
  onAsset("media.set_favorite"),
  onAsset("media.update_asset"),
  onAsset("enrich.upsert_faces", "enrich"),

  // Locker items.
  onLockerItem("locker.edit_item"),
  onLockerItem("locker.purge_item"),
  onLockerItem("locker.restore_item"),
  onLockerItem("locker.set_memo"),
  onLockerItem("locker.star_item"),
  onLockerItem("locker.totp_code"),
  onLockerItem("locker.trash_item"),
  onLockerItem("locker.unstar_item"),
];

const ROUTES_BY_COMMAND = new Map<string, CommonsCommandRoute[]>();
for (const declared of COMMONS_COMMAND_ROUTES) {
  const existing = ROUTES_BY_COMMAND.get(declared.command);
  if (existing) existing.push(declared);
  else ROUTES_BY_COMMAND.set(declared.command, [declared]);
}

/** The declared routes for one command, in resolution order. */
export function commonsRoutesForCommand(
  command: string
): readonly CommonsCommandRoute[] {
  return ROUTES_BY_COMMAND.get(command) ?? [];
}

/**
 * Is this command part of the container type's DECLARED write surface? The
 * commons rail refuses everything else, including commands it routed here.
 */
export function isCommonsCommandActable(
  containerType: ShareableItemType,
  command: string
): boolean {
  return commonsRoutesForCommand(command).some(
    (declared) => declared.containerType === containerType && declared.actable
  );
}
