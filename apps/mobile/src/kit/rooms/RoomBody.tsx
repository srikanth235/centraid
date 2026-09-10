// THE BODY EVERY ROOM DRAWS (#1015, S1).
//
// One state machine, one order: an error outranks everything (a screen that
// failed to load has nothing true to say about being empty), then loading,
// then empty, then the screen's own content. Every surface in the audit had
// its own order and three of them could render an empty state over a failed
// read, which tells a member their vault is empty when it is unreachable.

import React from "react";
import { View } from "react-native";

import EmptyBlock from "../components/EmptyBlock";
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

/** The eyebrow every room's error carries; one sentence, no exception text. */
const ERROR_EYEBROW = "THIS PAGE COULD NOT LOAD";

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
          body={error.body}
          eyebrow={ERROR_EYEBROW}
          title={error.title}
          tone="net"
        />
      </View>
    );
  if (loading)
    return (
      <View style={styles.body}>
        <SkeletonRows accessibilityLabel={loading.label} rows={loading.rows} />
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
