// A place this GATEWAY has not switched on (the v0 experimental gates).
//
// Reached only the ways a hidden place still can be: a deep link, a saved
// shortcut, a row on another screen that names it. The band and the All-apps
// sheet already drop it (screens/home/places.ts), so this is the wall behind
// the door rather than the door itself — and it is a wall, not a spinner and
// not a 404 from a route the gateway never mounted, because "off" is a fact
// the handshake already told us.
//
// It draws the place's OWN frame — the leave key and the page's title — so a
// member lands somewhere that is recognisably the place they asked for, and
// can leave the way they always do. The words come from the compatibility
// core beside the update-wall copy; this component owns no copy of its own.

import React, { useMemo } from "react";
import { View } from "react-native";

import { MOBILE_FEATURE_OFF_COPY } from "../../lib/replica/mobile-gateway-compatibility-core";
import type { MobileGatewayFeatures } from "../../lib/replica/mobile-gateway-compatibility-core";
import { useTheme } from "../theme";
import EmptyBlock from "./EmptyBlock";
import { styles } from "./FeatureOffPlace.styles";
import HomeKey from "./HomeKey";
import PlaceHeader from "./PlaceHeader";
import TopSafeArea from "./TopSafeArea";

export interface FeatureOffPlaceProps {
  /** Which gate is closed — also which copy this wall says. */
  feature: keyof MobileGatewayFeatures;
  /** The place's own title, so the wall reads as that place, not as an error. */
  title: string;
  onLeave: () => void;
}

export default function FeatureOffPlace({
  feature,
  title,
  onLeave,
}: FeatureOffPlaceProps): React.JSX.Element {
  const { colors } = useTheme();
  const ink = useMemo(() => ({ backgroundColor: colors.bg }), [colors]);
  const copy = MOBILE_FEATURE_OFF_COPY[feature];
  return (
    <TopSafeArea edges={["top"]} style={[styles.safe, ink]}>
      <View style={styles.page}>
        <View style={styles.head}>
          <HomeKey onPress={onLeave} variant="leave" />
          <View style={styles.headBar}>
            {/* No verbs: nothing on this phone can open the gate. */}
            <PlaceHeader title={title} />
          </View>
        </View>
        <View style={styles.body}>
          <EmptyBlock body={copy.body} title={copy.title} />
        </View>
      </View>
    </TopSafeArea>
  );
}
