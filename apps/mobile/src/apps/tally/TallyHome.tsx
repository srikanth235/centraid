// Tally (native cover) — deliberately EMPTY pending a ground-up redesign.
//
// The cover was removed wholesale rather than migrated: the next one is drawn
// from scratch on the new design, so a half-kept screen would only be something
// to unpick. Its route keeps its place in the navigator and its params in
// `navigation.ts`, and the doors it read and wrote through — the replica store,
// the kit, the vault's typed commands — are all untouched. A rebuilt screen
// mounts here and reaches for exactly those again.
//
// It paints the themed page ground and nothing else. An unpainted native view
// shows whatever sits behind it, which reads as a broken screen rather than an
// empty one. It still declares the props its route hands it: the route's
// contract is what the rebuilt screen starts from, and it did not go away
// with the drawing.
import React from "react";
import { View } from "react-native";

import { useTheme } from "../../kit/theme";
import type { TallyScreenProps } from "../../navigation";

export default function TallyHome(_props: TallyScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  return <View style={{ backgroundColor: colors.bg, flex: 1 }} />;
}
