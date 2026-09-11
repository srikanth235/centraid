// SYSTEM PLACE (#1015, S1): Settings, Vault, Devices, Backup — the stem's own
// rooms. `PlaceHeader` over `SectionBlock` / `RowsBlock`, and nothing else.
//
// A PLACE spends no colour on itself: there is no app mark here, because
// Needs you is not an app with a hue, it is somewhere the frame goes.
//
// A place ROOT draws the frame's Home band at its foot (R-NY-1), and then no
// Home key: the band's Home tab is the way home, and two ways home on one
// screen is one too many. A place with no band — a pushed sub-page, a signal
// detail — keeps the Home key as a header control, never a floating plate: the
// floating variant sat on the standing health line on exactly these screens
// (audit B14). The band is a NODE the screen hands in, not an import: the
// kit may not reach the launcher's pin model or the navigator.

import React, { useMemo } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import HomeKey from "../components/HomeKey";
import PlaceHeader from "../components/PlaceHeader";
import TopSafeArea from "../components/TopSafeArea";
import { useTheme } from "../theme";
import type { PlaceRef } from "./place";
import { BackKey } from "./PushedPage";
import type {
  RoomAction,
  RoomEmpty,
  RoomError,
  RoomLoading,
} from "./room-contracts";
import RoomBody from "./RoomBody";
import { styles } from "./rooms.styles";

export interface SystemPlaceProps {
  title: string;
  /**
   * The grid plate, in the header's leading slot. Ignored when `band` is
   * present: a place that draws the band draws no Home key (R-NY-1).
   */
  onHome?: () => void;
  /**
   * The frame's Home band, at the foot under the footer — where `PushedPage`
   * draws an app's. Only a place ROOT passes one; the node decides for
   * itself whether it draws (a pushed sub-page's band draws nothing).
   */
  band?: React.ReactNode;
  /** Computed from the stack; a stem root has no parent and draws no back. */
  backTo?: PlaceRef;
  onBack?: () => void;
  action?: RoomAction;
  secondary?: RoomAction;
  loading?: RoomLoading;
  error?: RoomError;
  empty?: RoomEmpty;
  /** `SectionBlock` / `RowsBlock` only — a system place has no bespoke JSX. */
  children?: React.ReactNode;
  /** The docked line some stem places carry under the body (health, counts). */
  footer?: React.ReactNode;
  /** Pull to re-read. A place with nothing to re-read omits it. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** For the one place that scrolls itself to a section it just named. */
  bodyRef?: React.Ref<ScrollView>;
  /**
   * The modals this place owns — a confirm sheet, a camera it opens over
   * itself. They hang OUTSIDE the scrolling body: a `Modal` nested in a
   * `ScrollView`'s content is still a modal, but its measurement is the
   * scroller's, and Settings' scanner is full-screen.
   */
  overlay?: React.ReactNode;
  /** For the end-to-end flows that name a place by id, not by its title. */
  testID?: string;
}

export default function SystemPlace({
  title,
  onHome,
  band,
  backTo,
  onBack,
  action,
  secondary,
  loading,
  error,
  empty,
  children,
  footer,
  onRefresh,
  refreshing = false,
  bodyRef,
  overlay,
  testID,
}: SystemPlaceProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(() => ({ backgroundColor: colors.bg }), [colors]);
  return (
    <TopSafeArea style={[styles.room, ink]} testID={testID}>
      <View style={styles.backRow}>
        {onHome && !band ? <HomeKey onPress={onHome} /> : null}
        {backTo && onBack ? <BackKey backTo={backTo} onBack={onBack} /> : null}
      </View>
      <PlaceHeader
        primary={
          action ? { label: action.label, onPress: action.onPress } : undefined
        }
        secondary={
          secondary
            ? { label: secondary.label, onPress: secondary.onPress }
            : undefined
        }
        title={title}
      />
      <RoomBody empty={empty} error={error} loading={loading}>
        <ScrollView
          contentContainerStyle={styles.placeBody}
          keyboardShouldPersistTaps="handled"
          ref={bodyRef}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                onRefresh={onRefresh}
                refreshing={refreshing}
                tintColor={colors.textFaint}
              />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      </RoomBody>
      {footer}
      {band ? <View>{band}</View> : null}
      {overlay}
    </TopSafeArea>
  );
}
