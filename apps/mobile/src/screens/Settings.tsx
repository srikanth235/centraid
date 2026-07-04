import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Icon from '../components/Icon';
import Button from '../components/Button';
import { colors, radii, spacing, t } from '../theme';
import {
  hydrateGatewayToken,
  hydrateGatewayUrl,
  setGatewayToken,
  setGatewayUrl,
} from '../lib/gateway';
import {
  getDesktopName,
  getTunnelStatus,
  hydratePhoneLink,
  isPaired,
  isTunnelAvailable,
  pair,
  subscribeTunnelStatus,
  unpair,
  type TunnelStatus,
} from '../lib/phone-link';
import type { RootScreenProps } from '../navigation';

// Mobile-only settings. The primary path is the desktop link: scan the
// "Connect phone" QR on your desktop once, and everything loads through an
// encrypted tunnel — no URLs, no tokens. The manual URL/token fields under
// "Advanced (developer)" remain as a dev fallback for simulators pointing
// at a token-less local gateway.

function defaultDeviceName(): string {
  return Platform.OS === 'ios' ? 'iPhone' : 'Android phone';
}

function tunnelStatusLabel(status: TunnelStatus | undefined): string {
  if (!status) return 'Checking…';
  switch (status.state) {
    case 'running':
      return status.port ? `Connected (port ${status.port})` : 'Connected';
    case 'starting':
      return 'Connecting…';
    case 'error':
      return `Error: ${status.error ?? 'unknown'}`;
    case 'stopped':
      return 'Not connected';
  }
}

export default function SettingsScreen({
  navigation,
}: RootScreenProps<'Settings'>): React.JSX.Element {
  const [paired, setPaired] = useState(false);
  const [desktopName, setDesktopName] = useState('');
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | undefined>(undefined);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [urlValue, setUrlValue] = useState('');
  const [tokenValue, setTokenValue] = useState('');
  const [hydrated, setHydrated] = useState(false);

  const tunnelAvailable = isTunnelAvailable();

  useEffect(() => {
    void Promise.all([hydratePhoneLink(), hydrateGatewayUrl(), hydrateGatewayToken()]).then(
      ([, url, token]) => {
        setPaired(isPaired());
        setDesktopName(getDesktopName());
        setUrlValue(url);
        setTokenValue(token);
        setHydrated(true);
      },
    );
  }, []);

  useEffect(() => {
    if (!tunnelAvailable) return undefined;
    void getTunnelStatus().then(setTunnelStatus);
    const sub = subscribeTunnelStatus(setTunnelStatus);
    return () => sub.remove();
  }, [tunnelAvailable]);

  const onScanned = useCallback((payload: string): void => {
    setScanning(false);
    setPairing(true);
    setPairError(undefined);
    pair(payload, defaultDeviceName())
      .then(({ desktopName: name }) => {
        setPaired(true);
        setDesktopName(name);
      })
      .catch((err: unknown) => {
        setPairError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setPairing(false));
  }, []);

  const onUnpair = useCallback((): void => {
    void unpair().then(() => {
      setPaired(false);
      setDesktopName('');
      setTunnelStatus(undefined);
    });
  }, []);

  const saveAdvanced = (): void => {
    setGatewayUrl(urlValue);
    setGatewayToken(tokenValue);
    navigation.goBack();
  };

  if (scanning) {
    return <PairScanner onScanned={onScanned} onCancel={() => setScanning(false)} />;
  }

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
        <Text style={styles.sectionLabel}>Desktop link</Text>
        {paired ? (
          <View style={styles.linkCard}>
            <Text style={styles.linkName}>{desktopName || 'Your desktop'}</Text>
            <Text style={styles.linkStatus}>{tunnelStatusLabel(tunnelStatus)}</Text>
            <View style={styles.linkAction}>
              <Button label="Unpair" icon="X" variant="soft" onPress={onUnpair} />
            </View>
          </View>
        ) : (
          <View>
            <Text style={styles.help}>
              Scan the QR code under "Connect phone" in Centraid on your desktop. Apps then load
              over an encrypted tunnel — no URLs or tokens needed.
            </Text>
            {tunnelAvailable ? (
              <Button
                label={pairing ? 'Pairing…' : 'Pair with desktop'}
                icon="Camera"
                onPress={() => setScanning(true)}
                disabled={pairing}
              />
            ) : (
              <Text style={styles.unavailable}>
                Pairing needs a development build — the tunnel module isn't available in Expo Go.
                Use the Advanced section below to point at a dev gateway instead.
              </Text>
            )}
            {pairError ? <Text style={styles.pairError}>{pairError}</Text> : null}
          </View>
        )}

        <View style={styles.spacer} />
        <Pressable
          onPress={() => navigation.navigate('Approvals')}
          style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
          accessibilityLabel="Approvals"
        >
          <Icon name="CheckCircle" size={18} color={colors.ink2} strokeWidth={1.75} />
          <Text style={styles.rowLabel}>Approvals</Text>
          <Icon name="ChevronRight" size={16} color={colors.ink3} strokeWidth={1.75} />
        </Pressable>

        <View style={styles.spacer} />
        <Pressable
          onPress={() => setAdvancedOpen((v) => !v)}
          style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
          accessibilityLabel="Advanced (developer)"
        >
          <Icon name="Code" size={18} color={colors.ink2} strokeWidth={1.75} />
          <Text style={styles.rowLabel}>Advanced (developer)</Text>
          <Icon
            name={advancedOpen ? 'ChevronDown' : 'ChevronRight'}
            size={16}
            color={colors.ink3}
            strokeWidth={1.75}
          />
        </Pressable>

        {advancedOpen ? (
          <View style={styles.advanced}>
            <Text style={styles.sectionLabel}>Gateway URL</Text>
            <Text style={styles.help}>
              Dev fallback for simulators: a directly reachable gateway, e.g.
              http://127.0.0.1:18789. An authed gateway needs the tunnel — the WebView attaches no
              token.
            </Text>
            <TextInput
              value={urlValue}
              onChangeText={setUrlValue}
              placeholder="http://127.0.0.1:18789"
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
              Bearer token used only for the app list and approvals fetches in this mode.
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
              <Button label="Save" icon="Check" onPress={saveAdvanced} />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// --- QR scanner ---

function PairScanner({
  onScanned,
  onCancel,
}: {
  onScanned: (payload: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  return (
    <SafeAreaView style={styles.scanSafe} edges={['top']}>
      <View style={styles.bar}>
        <Pressable
          onPress={onCancel}
          hitSlop={12}
          accessibilityLabel="Cancel scan"
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
        >
          <Icon name="ArrowLeft" size={20} color={colors.ink} strokeWidth={1.75} />
        </Pressable>
        <Text style={styles.title}>Scan pairing code</Text>
        <View style={styles.barSpacer} />
      </View>
      {permission?.granted ? (
        <View style={styles.scanWrap}>
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (scannedRef.current) return;
              scannedRef.current = true;
              onScanned(data);
            }}
          />
          <Text style={styles.scanHint}>
            Point the camera at the "Connect phone" QR on your desktop.
          </Text>
        </View>
      ) : (
        <View style={styles.scanDenied}>
          <Text style={styles.emptyTitle}>Camera access needed.</Text>
          <Text style={styles.help}>
            Allow camera access to scan the pairing QR code. You can enable it in system settings.
          </Text>
          <Button label="Back" variant="soft" onPress={onCancel} />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: { marginTop: spacing[5] },
  advanced: { marginTop: spacing[4] },
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
  camera: { borderRadius: radii.md, flex: 1, overflow: 'hidden' },
  emptyTitle: { ...t('title'), color: colors.ink, marginBottom: spacing[2] },
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
  linkAction: { marginTop: spacing[3] },
  linkCard: {
    backgroundColor: colors.bgElev,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1,
    padding: spacing[4],
  },
  linkName: { ...t('bodyStrong'), color: colors.ink },
  linkStatus: { ...t('small'), color: colors.ink3, marginTop: 2 },
  pairError: { ...t('small'), color: colors.danger, marginTop: spacing[3] },
  row: {
    alignItems: 'center',
    backgroundColor: colors.bgElev,
    borderColor: colors.line,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing[3],
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  rowLabel: { ...t('body'), color: colors.ink, flex: 1 },
  safe: { backgroundColor: colors.bg, flex: 1 },
  scanDenied: { padding: spacing[5] },
  scanHint: {
    ...t('small'),
    color: colors.ink3,
    marginTop: spacing[3],
    textAlign: 'center',
  },
  scanSafe: { backgroundColor: colors.bg, flex: 1 },
  scanWrap: { flex: 1, padding: spacing[5] },
  sectionLabel: { ...t('small'), color: colors.ink2, fontWeight: '600', marginBottom: 6 },
  spacer: { height: spacing[5] },
  title: { ...t('title'), color: colors.ink },
  unavailable: { ...t('small'), color: colors.ink3 },
});
