// THE BODY EVERY ROOM DRAWS (#1015, S1).
//
// One state machine, one order: an error outranks everything (a screen that
// failed to load has nothing true to say about being empty), then loading,
// then empty, then the screen's own content. Every surface in the audit had
// its own order and three of them could render an empty state over a failed
// read, which tells a member their vault is empty when it is unreachable.

import React from "react";
import { View } from "react-native";

import { ERROR_HEALTH } from "@centraid/client/surface-copy";

import EmptyBlock from "../components/EmptyBlock";
import NoteBlock from "../components/NoteBlock";
import PanelBlock from "../components/PanelBlock";
import SkeletonRows from "../components/SkeletonRows";
import type { RoomEmpty, RoomError, RoomLoading } from "./room-contracts";
import { styles } from "./rooms.styles";

export interface RoomBodyProps {
  loading?: RoomLoading;
  error?: RoomError;
  empty?: RoomEmpty;
  children?: React.ReactNode;
}

/** The eyebrow every room's error carries — the shell's own word, shared with
 *  every other seat (`@centraid/client/surface-copy`), and sentence case like
 *  every other label (D2). */
const ERROR_EYEBROW = ERROR_HEALTH;

export default function RoomBody({
  loading,
  error,
  empty,
  children,
}: RoomBodyProps): React.JSX.Element {
  if (error)
    return (
      <View style={styles.body}>
        <PanelBlock
          action={{ label: error.retry.label, onPress: error.retry.onPress }}
          action2={
            error.secondary
              ? {
                  label: error.secondary.label,
                  onPress: error.secondary.onPress,
                }
              : undefined
          }
          body={error.body}
          eyebrow={ERROR_EYEBROW}
          facts={
            error.detail
              ? [{ key: "what happened", net: true, value: error.detail }]
              : undefined
          }
          title={error.title}
          tone="net"
        />
      </View>
    );
  if (loading)
    return (
      <View style={styles.body}>
        <SkeletonRows accessibilityLabel={loading.label} rows={loading.rows} />
        {loading.note ? <NoteBlock text={loading.note} /> : null}
      </View>
    );
  if (empty)
    return (
      <View style={styles.body}>
        <EmptyBlock {...empty} />
      </View>
    );
  return <View style={styles.body}>{children}</View>;
}
