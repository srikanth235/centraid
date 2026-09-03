import type { ReactNode } from "react";

import type { ComposeState, Overlay } from "../compose-state.ts";
import type { ShelfId } from "../shelves.ts";
import type { Person } from "../types.ts";
import { Overlays } from "./Overlays.tsx";

export function withName(overlay: Overlay, name: string): Overlay {
  if (overlay?.kind === "friend") return { ...overlay, name };
  if (overlay?.kind === "group") return { ...overlay, name };
  if (overlay?.kind === "rename") return { ...overlay, name };
  return overlay;
}

export function withIcon(overlay: Overlay, icon: string): Overlay {
  return overlay?.kind === "group" ? { ...overlay, icon } : overlay;
}

export function withColour(overlay: Overlay, color: string): Overlay {
  return overlay?.kind === "group" ? { ...overlay, color } : overlay;
}

export function withToggle(overlay: Overlay, partyId: string): Overlay {
  if (overlay?.kind !== "group") return overlay;
  return {
    ...overlay,
    memberIds: overlay.memberIds.includes(partyId)
      ? overlay.memberIds.filter((id) => id !== partyId)
      : [...overlay.memberIds, partyId],
  };
}

export function withPick(overlay: Overlay, partyId: string): Overlay {
  return overlay?.kind === "member" ? { ...overlay, partyId } : overlay;
}

export interface RoomOverlaysProps {
  overlay: Overlay;
  compose: ComposeState;
  friends: readonly Person[];
  candidates: readonly Person[];
  onNavigate: (shelf: ShelfId) => void;
  onRemove: (partyId: string) => void;
  onCommit: () => void;
}

export function RoomOverlays(props: RoomOverlaysProps): ReactNode {
  const { compose, overlay } = props;
  return (
    <Overlays
      overlay={overlay}
      friends={props.friends}
      candidates={props.candidates}
      onClose={() => compose.close()}
      onNavigate={props.onNavigate}
      onRemove={(partyId) => props.onRemove(partyId)}
      onName={(name) => compose.show(withName(overlay, name))}
      onIcon={(icon) => compose.show(withIcon(overlay, icon))}
      onColour={(color) => compose.show(withColour(overlay, color))}
      onToggleMember={(partyId) => compose.show(withToggle(overlay, partyId))}
      onPickMember={(partyId) => compose.show(withPick(overlay, partyId))}
      onCommit={() => props.onCommit()}
    />
  );
}
