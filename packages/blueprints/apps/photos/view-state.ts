import { showsEmptyState } from "../_shared/view-state-kit.ts";
import type { EmptyStateGate } from "../_shared/view-state-kit.ts";
import type { ShelfId } from "./shelves.ts";
import {
  emptyCopy,
  emptyOffersImport,
  EMPTY_TITLE,
  personEmptyCopy,
  searchMissTitle,
} from "./view-copy.ts";

export function shelfAfterRead(
  shelf: ShelfId,
  albumIds: readonly string[]
): ShelfId {
  if (shelf === null) return null;
  if (typeof shelf !== "string") return shelf;
  if (
    shelf.startsWith("built-in:") ||
    shelf.startsWith("tag:") ||
    shelf.startsWith("memory:")
  )
    return shelf;
  return albumIds.includes(shelf) ? shelf : null;
}

export interface EmptyStateInput extends EmptyStateGate {
  shelf: ShelfId;
  query?: string;
  inAlbum?: boolean;
  personName?: string | null;
  phone?: boolean;
}

export interface EmptyStateView {
  visible: boolean;
  title: string;
  body: string;
  offersImport: boolean;
  offersCamera: boolean;
}

export const NO_EMPTY_STATE: EmptyStateView = {
  visible: false,
  title: "",
  body: "",
  offersImport: false,
  offersCamera: false,
};

export function emptyStateView(input: EmptyStateInput): EmptyStateView {
  const query = input.query?.trim() ?? "";
  if (!showsEmptyState(input)) return NO_EMPTY_STATE;
  const offersImport = emptyOffersImport(input.shelf, { query });
  return {
    visible: true,
    title: query ? searchMissTitle(query) : EMPTY_TITLE,
    body:
      input.personName && !query
        ? personEmptyCopy(input.personName)
        : emptyCopy(input.shelf, {
            query,
            ...(input.inAlbum ? { inAlbum: true } : {}),
          }),
    offersImport,
    offersCamera: offersImport && Boolean(input.phone),
  };
}

export { libraryReachability } from "../_shared/view-state-kit.ts";
