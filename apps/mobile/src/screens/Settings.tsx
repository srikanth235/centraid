import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from '../components/Icon';
import Button from '../components/Button';
import { colors, radii, spacing, t } from '../theme';
import {
  hydrateGatewayToken,
  hydrateGatewayUrl,
  setGatewayToken,
  setGatewayUrl,
} from '../lib/gateway';
import type { RootScreenProps } from '../navigation';

// Mobile-only settings — not synced with desktop. The user enters their
// desktop's LAN IP (e.g. http://192.168.1.42:18789) since 127.0.0.1 from a
// phone points at the phone itself, plus the gateway bearer token shown in
// the desktop app under Settings → Gateway info.
export default function SettingsScreen({
  navigation,
}: RootScreenProps<'Settings'>): React.JSX.Element {
  const [urlValue, setUrlValue] = useState('');
  const [tokenValue, setTokenValue] = useState('');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    Promise.all([hydrateGatewayUrl(), hydrateGatewayToken()]).then(([url, token]) => {
      setUrlValue(url);
      setTokenValue(token);
      setHydrated(true);
    });
  }, []);

  const save = (): void => {
    setGatewayUrl(urlValue);
    setGatewayToken(tokenValue);
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
          value={urlValue}
          onChangeText={setUrlValue}
          placeholder="http://192.168.1.42:18789"
          placeholderTextColor={colors.ink3}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={hydrated}
        />

        <View style={styles.spacer} />
        <Text style={styles.sectionLabel}>Gateway token</Text>
        <Text style={styles.help}>
          Bearer token from the desktop app's gateway settings. Required when the desktop gateway
          enforces token auth — leave blank otherwise.
        </Text>
        <TextInput
          value={tokenValue}
          onChangeText={setTokenValue}
          placeholder="paste token here"
          placeholderTextColor={colors.ink3}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
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
  spacer: { height: spacing[5] },
  title: { ...t('title'), color: colors.ink },
});
