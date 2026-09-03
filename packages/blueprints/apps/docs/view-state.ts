import { showsEmptyState } from "../_shared/view-state-kit.ts";
import type { EmptyStateGate } from "../_shared/view-state-kit.ts";
import { FOLDERS, folderIdFrom } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import { emptyCopy } from "./view-copy.ts";
import type { EmptyCopy } from "./view-copy.ts";

export interface ShelfAfterRead {
  shelf: ShelfId;
  goneFolder: boolean;
}

export function shelfAfterRead(
  shelf: ShelfId,
  folderIds: readonly string[]
): ShelfAfterRead {
  const folderId = folderIdFrom(shelf);
  if (!folderId) return { shelf, goneFolder: false };
  return folderIds.includes(folderId)
    ? { shelf, goneFolder: false }
    : { shelf: FOLDERS, goneFolder: true };
}

export const GONE_FOLDER_NOTE =
  "That folder no longer exists. The label has nothing on the other end; refile anything that carried it from here.";

export interface EmptyStateInput extends EmptyStateGate {
  shelf: ShelfId;
  query?: string;
  filtered?: boolean;
  folderName?: string;
  driveIsEmpty?: boolean;
  sharedFromKnown?: boolean;
}

export interface EmptyStateView extends EmptyCopy {
  visible: boolean;
}

export const NO_EMPTY_STATE: EmptyStateView = {
  visible: false,
  variant: "shelf",
  display: false,
  title: "",
  body: "",
};

export function emptyStateView(input: EmptyStateInput): EmptyStateView {
  const query = input.query?.trim() ?? "";
  if (!showsEmptyState(input)) return NO_EMPTY_STATE;
  return {
    visible: true,
    ...emptyCopy(input.shelf, {
      ...(query ? { query } : {}),
      ...(input.filtered ? { filtered: true } : {}),
      ...(input.folderName ? { folderName: input.folderName } : {}),
      ...(input.driveIsEmpty ? { driveIsEmpty: true } : {}),
      ...(input.sharedFromKnown === false ? { sharedFromKnown: false } : {}),
    }),
  };
}

export { libraryReachability } from "../_shared/view-state-kit.ts";
