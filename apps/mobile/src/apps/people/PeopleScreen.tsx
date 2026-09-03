import { useNavigation } from "@react-navigation/native";
import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useBandOwner } from "../../kit/band/band-owner";
import { useTheme } from "../../kit/theme";
import type { PeopleShellNavigation } from "../../navigation";
import VaultBar from "../../screens/home/VaultBar";
import type { PeopleBandKey } from "./people-band";
import PeopleBand from "./PeopleBand";

export interface PeopleScreenProps {
  current: PeopleBandKey;
  children: React.ReactNode;
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
    navigation.popTo("PeopleHome", { destination: key });
  };

  return (
    <View
      style={[
        styles.frame,
        { backgroundColor: colors.bg, paddingTop: insets.top },
      ]}
    >
      {/* The vault lockup on every route (see `VaultBar`): which vault, which
          gateway, and the product's two global verbs. */}
      <VaultBar />
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
