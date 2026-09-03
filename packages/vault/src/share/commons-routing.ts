import type { ShareableItemType } from "./closure.js";

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

export const COMMONS_COMMAND_ROUTES: readonly CommonsCommandRoute[] = [
  tallyGroup("tally.add_expense", true),
  tallyGroup("tally.add_group_member", true),
  tallyGroup("tally.remove_group_member", true),
  tallyGroup("tally.rename_group", true),
  tallyGroup("tally.settle_up", true),
  tallyExpense("tally.edit_expense", true),
  tallyExpense("tally.delete_expense", true),
  tallyExpense("tally.restore_expense", true),
  tallyGroup("tally.add_receipt_expense"),
  tallyGroup("tally.delete_group"),
  tallyGroup("tally.save_recurring_expense"),
  tallyGroup("tally.archive_group"),
  tallyGroup("tally.set_group_simplification"),
  tallyGroup("tally.leave_group"),
  tallyGroup("tally.nudge"),
  tallyExpense("tally.bind_txn"),
  tallyExpense("tally.set_expense_memo"),
  tallyExpense("tally.undo_expense"),
  tallyExpense("tally.reallocate_receipt"),

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

export function isCommonsCommandActable(
  containerType: ShareableItemType,
  command: string
): boolean {
  return commonsRoutesForCommand(command).some(
    (declared) => declared.containerType === containerType && declared.actable
  );
}
