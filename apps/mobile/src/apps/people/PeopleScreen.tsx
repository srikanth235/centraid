// People shell frame (#821): content is flex:1 ABOVE the claimed band + Home
// capsule, so no pushed screen dead-ends.

import { useNavigation } from "@react-navigation/native";
import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useBandOwner } from "../../kit/band/band-owner";
import { useTheme } from "../../kit/theme";
import type { PeopleShellNavigation } from "../../navigation";
import type { PeopleBandKey } from "./people-band";
import PeopleBand from "./PeopleBand";

export interface PeopleScreenProps {
  /** Which destination this surface sits under. */
  current: PeopleBandKey;
  children: React.ReactNode;
  /** Hide the band while a modal sheet owns the foot. */
  bandHidden?: boolean;
}

export default function PeopleScreen({
  current,
  children,
  bandHidden,
}: PeopleScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<PeopleShellNavigation>();
  const { bandOwner } = useBandOwner("people");
  const styles = useMemo(() => makeStyles(), []);

  const onDestination = (key: PeopleBandKey): void => {
    // POP, never push — destinations live on PeopleHome.
    navigation.popTo("PeopleHome", { destination: key });
  };

  return (
    <View
      style={[
        styles.frame,
        { backgroundColor: colors.bg, paddingTop: insets.top },
      ]}
    >
      <View style={styles.body}>{children}</View>
      {bandHidden === true ? null : (
        <PeopleBand
          owner={bandOwner}
          current={current}
          onSelect={onDestination}
          onHome={() => navigation.popTo("Home")}
        />
      )}
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    body: { flex: 1 },
    frame: { flex: 1 },
  });
