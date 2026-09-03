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
  feature: keyof MobileGatewayFeatures;
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
