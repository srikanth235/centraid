// THE ONE CONFIRM (#1015, S7 — audit found five confirm shapes plus "no
// confirm" across nine surfaces, 21 files calling `Alert.alert`).
//
// Three rules, none of them the caller's to re-decide:
//  - THE NOUN AND THE COUNT ARE IN THE TITLE. "Delete 3 photos?" — never
//    "Are you sure?", which asks about nothing. Copy is signage.
//  - THE DESTRUCTIVE VERB IS OUTLINED `--net`, never filled. A filled
//    destructive button is the view's one primary spent on the thing the
//    member is being asked to reconsider.
//  - UNDO IS THE OTHER HALF. Where the write is reversible, the caller uses
//    `showUndoStatus` (the one undo grammar, `status-line.ts`) and skips the
//    confirm entirely; a confirm AND an undo asks twice.
//
// Adoption is per app: this exports the primitive, and each app's own wave
// replaces its `Alert.alert`.

import React, { useMemo, useState } from "react";

import SheetRoom from "../rooms/SheetRoom";
import { t, useTheme } from "../theme";
import { Text } from "./NativeText";

export interface ConfirmSheetProps {
  visible: boolean;
  /** What is being acted on, singular — "photo", "document", "expense". */
  noun: string;
  /** How many; 1 keeps the singular noun. */
  count?: number;
  /** The verb, sentence case — "Delete", "Empty trash", "Remove". */
  verb: string;
  /** One line on what cannot be undone, when that is true. */
  body?: string;
  onConfirm: () => void;
  onClose: () => void;
}

/** "Delete 3 photos?" / "Delete photo?" — the noun is always present. */
export function confirmTitle(verb: string, noun: string, count = 1): string {
  return count === 1 ? `${verb} ${noun}?` : `${verb} ${count} ${noun}s?`;
}

export default function ConfirmSheet({
  visible,
  noun,
  count = 1,
  verb,
  body,
  onConfirm,
  onClose,
}: ConfirmSheetProps): React.JSX.Element | null {
  const { colors } = useTheme();
  const ink = useMemo(() => ({ color: colors.textSoft }), [colors]);
  return (
    <SheetRoom
      onClose={onClose}
      primary={{
        dangerous: true,
        label: verb,
        onPress: () => {
          onClose();
          onConfirm();
        },
      }}
      title={confirmTitle(verb, noun, count)}
      visible={visible}
    >
      {body ? <Text style={[t("body"), ink]}>{body}</Text> : null}
    </SheetRoom>
  );
}

/** What a caller asks for; the sheet's own `visible` is the hook's. */
export type ConfirmRequest = Omit<ConfirmSheetProps, "visible" | "onClose">;

export interface ConfirmDestructive {
  /** Ask. Nothing happens until the member answers the outlined verb. */
  confirmDestructive: (request: ConfirmRequest) => void;
  /** Render this in the room; it is `null` until something is being asked. */
  confirmSheet: React.JSX.Element | null;
}

/**
 * The confirm as one call. Twenty-one files reach for `Alert.alert` today,
 * each spelling its own question; a hook is what makes the primitive as cheap
 * to use as the alert it replaces, which is the only reason the alert won.
 */
export function useConfirmDestructive(): ConfirmDestructive {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  return {
    confirmDestructive: setRequest,
    confirmSheet: request ? (
      <ConfirmSheet {...request} onClose={() => setRequest(null)} visible />
    ) : null,
  };
}
