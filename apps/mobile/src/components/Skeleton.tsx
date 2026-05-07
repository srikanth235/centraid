import React from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { colors, spacing } from '../theme';

// Shown while an app is hydrating its AsyncStorage keys. The AppHeader
// in AppDetail is already mounted, so this only fills the body.
export default function Skeleton(): React.JSX.Element {
  return (
    <View style={styles.wrap}>
      <ActivityIndicator color={colors.ink3} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    backgroundColor: colors.bg,
    flex: 1,
    justifyContent: 'center',
    paddingTop: spacing[7],
  },
});
