// THE MODAL CONFIRM (v12 handoff § The three confirms) — the acts no reverse
// write can undo. All three stand on this surface now: Trash, Merge, and —
// since the grant plane gave People the write side (#825) — Revoke, whose
// title, body and both control words are the shared kit's
// (`_shared/grant-copy.ts`), which is why the cancel word is a prop: `Keep
// sharing` is the honest opposite of a revoke, where `Cancel` is the opposite
// of the other two.
//
// IT IS `SheetRoom` NOW (#1015, S7), the same room `ConfirmSheet` is built
// on, so People stops being a fifth confirm shape. It is not `ConfirmSheet`
// itself only because that one BUILDS its title from a noun and a count, and
// all three of these titles name the person or the channel — "Trash Ada?",
// "Merge Ada into Adaeze?" — which is more than a noun and a count can say.
// The grabber, the outlined --net verb, the quiet way out and the hosted
// status line are the room's; the sentences are the copy table's.
//
// Everything else in the app reports on the status line with Undo instead of
// asking first.

import React from "react";

import { VERBS } from "@centraid/blueprints/apps/people/people-copy";

import { Text } from "../../kit/components/NativeText";
import { SheetRoom } from "../../kit/rooms";
import { t, useTheme } from "../../kit/theme";

export interface PeopleConfirmProps {
  visible: boolean;
  title: string;
  body: string;
  verb: string;
  /** The way out, where it is not the plain `Cancel`. */
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function PeopleConfirm({
  visible,
  title,
  body,
  verb,
  cancelLabel = VERBS.cancel,
  onConfirm,
  onCancel,
}: PeopleConfirmProps): React.JSX.Element | null {
  const { colors } = useTheme();
  return (
    <SheetRoom
      cancelLabel={cancelLabel}
      onClose={onCancel}
      primary={{ dangerous: true, label: verb, onPress: onConfirm }}
      title={title}
      visible={visible}
    >
      <Text style={[t("body"), { color: colors.textSoft }]}>{body}</Text>
    </SheetRoom>
  );
}
