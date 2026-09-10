// THE SIX ROOMS (#1015, S1) — the only permitted screen roots. See README.md.

export { default as AppPlace } from "./AppPlace";
export type { AppPlaceProps } from "./AppPlace";
export { default as EditorRoom } from "./EditorRoom";
export type { EditorRoomProps } from "./EditorRoom";
export { default as HomeRoom } from "./HomeRoom";
export type { HomeRoomProps } from "./HomeRoom";
export { default as PushedPage } from "./PushedPage";
export type { PushedPageProps } from "./PushedPage";
export { default as SheetRoom } from "./SheetRoom";
export type { SheetRoomProps } from "./SheetRoom";
export { default as SystemPlace } from "./SystemPlace";
export type { SystemPlaceProps } from "./SystemPlace";

export { currentPlace, parentPlace, place, placeStack } from "./place";
export type { PlaceEntry, PlaceRef } from "./place";
export { bandStateFor, selectedSentence } from "./room-contracts";
export type {
  BandState,
  RoomAction,
  RoomEmpty,
  RoomError,
  RoomLoading,
  RoomSelection,
  RoomSelectionAction,
} from "./room-contracts";
