// DECLARED command→container routing for the Commons plane (#750). Routing is
// decided by DECLARATION here, never by the shape of a command name or input
// keys. A command that writes a shared container but misses the rail lands as
// a PRIVATE local mutation that the next compile reverts.
//
// ROUTABLE — input can address this container type, so it must reach the rail.
// ACTABLE — the container type DECLARES this command as its shared write
// surface. Routable-but-not-actable is refused by name. UI filtering is never
// the security boundary.

import type { ShareableItemType } from "./closure.js";

/**
 * How a declared input key names the grant's container.
 * `container` — the key holds the container's own id.
 * `folder-descendant` / `folder-document` — under the granted `docs.folder`.
 * `tally-expense` — expense whose group is the granted `tally.group`.
 */
export type CommonsRouteResolution =
  | "container"
  | "folder-descendant"
  | "folder-document"
  | "tally-expense";

export interface CommonsCommandRoute {
  command: string;
  ownerSchema: string;
  inputKey: string;
  containerType: ShareableItemType;
  resolution: CommonsRouteResolution;
  actable: boolean;
}

/**
 * Key vocabulary for the conformance test: a new command that grows a
 * `group_id` cannot quietly skip the rail. Scoped by owner schema on purpose:
 * `locker.save_item` and `outbox.decide` also carry `item_id`.
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
  // Tally — full declared write surface.
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
  // Archiving hides the group from every member's lists and turning
  // simplification on rewires who owes whom — both are the steward's call
  // about the container itself, not a member's write inside it.
  tallyGroup("tally.archive_group"),
  tallyGroup("tally.set_group_simplification"),
  // Leaving is remove_group_member WITHOUT the on-ledger guard, so declaring
  // it would hand every member an eject verb the guarded one refuses. It stays
  // refused by name; a shared departure is the steward's act.
  tallyGroup("tally.leave_group"),
  // A prepared reminder is the owner's own intention about a person, and it
  // carries `confirm: true` regardless — it is never a shared write.
  tallyGroup("tally.nudge"),
  tallyExpense("tally.bind_txn"),
  tallyExpense("tally.set_expense_memo"),
  tallyExpense("tally.undo_expense"),
  // Re-allocation rewrites every member's share of an expense already agreed.
  // Same stance as add_receipt_expense: routed so the refusal names it.
  tallyExpense("tally.reallocate_receipt"),

  // Documents/folders: enclosing shared folder first, then the document's own grant.
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

  // Albums/photos: no declared write surface — refused, never applied privately.
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

  // Locker items are single-vault — none of these is declared actable, so the
  // rail refuses them by NAME rather than letting a write land privately.
  // Every command carrying `item_id` must be here (#750 conformance), which
  // is why the #872 surface joins the list rather than quietly bypassing it.
  onLockerItem("locker.archive_item"),
  onLockerItem("locker.clear_passkey"),
  onLockerItem("locker.duplicate_item"),
  onLockerItem("locker.remove_field"),
  onLockerItem("locker.set_addresses"),
  onLockerItem("locker.set_field"),
  onLockerItem("locker.set_passkey"),
  onLockerItem("locker.unarchive_item"),
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

export function commonsRoutesForCommand(
  command: string
): readonly CommonsCommandRoute[] {
  return ROUTES_BY_COMMAND.get(command) ?? [];
}

/** Declared write surface? The rail refuses everything else, including routed commands. */
export function isCommonsCommandActable(
  containerType: ShareableItemType,
  command: string
): boolean {
  return commonsRoutesForCommand(command).some(
    (declared) => declared.containerType === containerType && declared.actable
  );
}
