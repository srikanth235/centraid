import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from '../components/Icon';
import Button from '../components/Button';
import { colors, radii, spacing, t } from '../theme';
import { hydrateGatewayUrl, setGatewayUrl } from '../lib/gateway';
import type { RootScreenProps } from '../navigation';

// Mobile-only settings — not synced with desktop. v1 is just the gateway
// URL: user enters their desktop's LAN IP (e.g. http://192.168.1.42:18789)
// since 127.0.0.1 from a phone points at the phone itself.
export default function SettingsScreen({
  navigation,
}: RootScreenProps<'Settings'>): React.JSX.Element {
  const [value, setValue] = useState('');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    hydrateGatewayUrl().then((current) => {
      setValue(current);
      setHydrated(true);
    });
  }, []);

  const save = (): void => {
    setGatewayUrl(value);
    navigation.goBack();
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.bar}>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={12}
          accessibilityLabel="Back"
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
        >
          <Icon name="ArrowLeft" size={20} color={colors.ink} strokeWidth={1.75} />
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <View style={styles.barSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.sectionLabel}>Gateway URL</Text>
        <Text style={styles.help}>
          Your desktop's LAN address. Find it in Centraid on your Mac under "Show gateway info". The
          default 127.0.0.1 won't work from a phone — use the LAN IP, e.g.
          http://192.168.1.42:18789.
        </Text>
        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder="http://192.168.1.42:18789"
          placeholderTextColor={colors.ink3}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={hydrated}
        />

        <View style={styles.actions}>
          <Button label="Save" icon="Check" onPress={save} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: { marginTop: spacing[5] },
  backBtn: {
    alignItems: 'center',
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  bar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: spacing[2],
  },
  barSpacer: { width: 36 },
  body: { padding: spacing[5] },
  help: { ...t('small'), color: colors.ink3, marginBottom: spacing[3] },
  input: {
    ...t('body'),
    backgroundColor: colors.bgElev,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.ink,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  safe: { backgroundColor: colors.bg, flex: 1 },
  sectionLabel: { ...t('small'), color: colors.ink2, fontWeight: '600', marginBottom: 6 },
  title: { ...t('title'), color: colors.ink },
});
