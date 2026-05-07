import React from 'react';
import { Pressable, View, Text, StyleSheet } from 'react-native';
import type { AppMetaResolved } from '@centraid/design-tokens';
import Icon from './Icon';
import { colors, t } from '../theme';

const ICON_SIZE = 60;
const ICON_RADIUS = 16;

export interface TileProps {
  app: AppMetaResolved;
  onPress: () => void;
  onLongPress?: () => void;
}

export default function Tile({ app, onPress, onLongPress }: TileProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
    >
      <View style={[styles.iconWrap, { backgroundColor: app.color }]}>
        <Icon name={app.iconKey} size={30} color="#fff" strokeWidth={1.75} />
      </View>
      <Text style={styles.name} numberOfLines={1}>
        {app.name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  iconWrap: {
    alignItems: 'center',
    borderRadius: ICON_RADIUS,
    elevation: 2,
    height: ICON_SIZE,
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { height: 4, width: 0 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    width: ICON_SIZE,
  },
  name: {
    ...t('tiny'),
    color: colors.ink,
    maxWidth: 80,
    textAlign: 'center',
  },
  pressed: { transform: [{ scale: 0.94 }] },
  tile: {
    alignItems: 'center',
    gap: 6,
  },
});
