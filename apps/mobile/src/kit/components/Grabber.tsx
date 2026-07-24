import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '../theme';

// The sheet "grabber": a small rounded bar centered at the very top of an app
// cover. In the springboard model each app presents as a full-screen modal that
// pulls down to dismiss, and this affordance is the iOS convention that tells
// the eye "grab here / swipe down". The pull-down gesture and the frosted teal
// HomeKey (see HomeKey.tsx) coexist: the gesture is the fast path, the key the
// discoverable one — every cover keeps a visible, always-available way back home.
//
// iOS modal sheets sit just below the status bar, so the top inset is small; the
// bar carries its own top padding rather than reaching for the safe-area inset.
export default function Grabber(): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={[styles.bar, { backgroundColor: colors.ink4 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderRadius: 2.5,
    height: 5,
    width: 36,
  },
  wrap: {
    alignItems: 'center',
    paddingBottom: 4,
    paddingTop: 6,
  },
});
