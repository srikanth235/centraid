import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, Pressable, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Icon from '../kit/components/Icon';
import Button from '../kit/components/Button';
import { Feather } from '@expo/vector-icons';
import { family, radii, spacing, t, useTheme, type ThemeColors } from '../kit/theme';
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
import type { SettingsScreenProps } from '../navigation';
import AppearanceSection from './settings/AppearanceSection';
import SettingsSection from './settings/SettingsSection';
import SpaceSection from './settings/SpaceSection';
import YouSection from './settings/YouSection';

// Settings is a full-screen cover over Home (springboard model): a native back
// arrow returns to Home (no pull-down on a full-screen modal), and the title sits
// in the editorial serif to match Home's greeting. Sections read top-to-bottom as
// one designed surface: You (local profile) · Appearance (theme override) ·
// Space (the active vault) · Desktop link (pairing) · Approvals · Advanced.
//
// The desktop link is the primary connection path: scan a desktop "Connect phone"
// QR, or a headless `centraid-gateway pair` / `pair --qr` terminal QR on a VPS,
// or paste the one-line ticket — everything then loads through an encrypted
// tunnel, no URLs or tokens. The manual URL/token fields under Advanced remain a
// dev fallback for simulators pointing at a token-less local gateway.

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
}: SettingsScreenProps<'Settings'>): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [paired, setPaired] = useState(false);
  const [desktopName, setDesktopName] = useState('');
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus | undefined>(undefined);
  const [scanning, setScanning] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | undefined>(undefined);
  const [pasteTicket, setPasteTicket] = useState('');

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

  const runPair = useCallback((payload: string): void => {
    setPairing(true);
    setPairError(undefined);
    pair(payload, defaultDeviceName())
      .then(({ desktopName: name }) => {
        setPaired(true);
        setDesktopName(name);
        setPasteTicket('');
      })
      .catch((err: unknown) => {
        setPairError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setPairing(false));
  }, []);

  const onScanned = useCallback(
    (payload: string): void => {
      setScanning(false);
      runPair(payload);
    },
    [runPair],
  );

  const onPastePair = useCallback((): void => {
    runPair(pasteTicket);
  }, [pasteTicket, runPair]);

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
    // Settings is a cover over Home — dismiss it back to the launcher, which
    // reloads its app list against the new gateway on focus.
    navigation.getParent()?.goBack();
  };

  if (scanning) {
    return <PairScanner onScanned={onScanned} onCancel={() => setScanning(false)} />;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to home"
          hitSlop={10}
          onPress={() => navigation.getParent()?.goBack()}
        >
          <Feather name="arrow-left" size={26} color={colors.ink} />
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <YouSection />
        <AppearanceSection />
        <SpaceSection />

        <SettingsSection label="Desktop link">
          {paired ? (
            <View style={styles.linkCard}>
              <Text style={styles.linkName}>{desktopName || 'Your gateway'}</Text>
              <Text style={styles.linkStatus}>{tunnelStatusLabel(tunnelStatus)}</Text>
              <Text style={styles.help}>
                Switch between your connected spaces from the space menu on Home. Pair another
                desktop or gateway to add its vault here too.
              </Text>
              <View style={styles.linkAction}>
                {tunnelAvailable ? (
                  <Button
                    label={pairing ? 'Pairing…' : 'Pair another'}
                    icon="Camera"
                    variant="soft"
                    onPress={() => setScanning(true)}
                    disabled={pairing}
                  />
                ) : null}
                <Button label="Unpair" icon="X" variant="soft" onPress={onUnpair} />
              </View>
              {pairError ? <Text style={styles.pairError}>{pairError}</Text> : null}
            </View>
          ) : (
            <View>
              <Text style={styles.help}>
                Scan a desktop "Connect phone" QR, or a terminal QR from{' '}
                <Text style={styles.helpMono}>centraid-gateway pair --qr</Text> on a VPS. You can
                also paste the one-line ticket. Apps then load over an encrypted tunnel.
              </Text>
              {tunnelAvailable ? (
                <>
                  <Button
                    label={pairing ? 'Pairing…' : 'Scan QR code'}
                    icon="Camera"
                    onPress={() => setScanning(true)}
                    disabled={pairing}
                  />
                  <View style={styles.spacer} />
                  <Text style={styles.fieldLabel}>Or paste ticket</Text>
                  <TextInput
                    value={pasteTicket}
                    onChangeText={setPasteTicket}
                    placeholder="one-line pairing ticket"
                    placeholderTextColor={colors.ink3}
                    style={styles.input}
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline
                    editable={!pairing}
                    accessibilityLabel="Paste pairing ticket"
                  />
                  <View style={styles.actions}>
                    <Button
                      label={pairing ? 'Pairing…' : 'Pair with ticket'}
                      icon="Key"
                      onPress={onPastePair}
                      disabled={pairing || pasteTicket.trim().length === 0}
                    />
                  </View>
                </>
              ) : (
                <Text style={styles.unavailable}>
                  Pairing needs a development build — the tunnel module isn't available in Expo Go.
                  Use the Advanced section below to point at a dev gateway instead.
                </Text>
              )}
              {pairError ? <Text style={styles.pairError}>{pairError}</Text> : null}
            </View>
          )}
        </SettingsSection>

        <SettingsSection label="Approvals">
          <Pressable
            onPress={() => navigation.navigate('Approvals')}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            accessibilityLabel="Approvals"
          >
            <Icon name="CheckCircle" size={18} color={colors.ink2} strokeWidth={1.75} />
            <Text style={styles.rowLabel}>Pending approvals</Text>
            <Icon name="ChevronRight" size={16} color={colors.ink3} strokeWidth={1.75} />
          </Pressable>
        </SettingsSection>

        <SettingsSection label="Advanced (developer)">
          <Pressable
            onPress={() => setAdvancedOpen((v) => !v)}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            accessibilityLabel="Gateway connection"
          >
            <Icon name="Code" size={18} color={colors.ink2} strokeWidth={1.75} />
            <Text style={styles.rowLabel}>Gateway connection</Text>
            <Icon
              name={advancedOpen ? 'ChevronDown' : 'ChevronRight'}
              size={16}
              color={colors.ink3}
              strokeWidth={1.75}
            />
          </Pressable>

          {advancedOpen ? (
            <View style={styles.advanced}>
              <Text style={styles.fieldLabel}>Gateway URL</Text>
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
              <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Gateway token</Text>
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
        </SettingsSection>
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
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
        <Text style={styles.scanTitle}>Scan pairing code</Text>
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
            Point the camera at a desktop "Connect phone" QR or a gateway `pair --qr` terminal QR.
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

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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
    body: { paddingBottom: spacing[7], paddingHorizontal: spacing[5], paddingTop: spacing[4] },
    camera: { borderRadius: radii.md, flex: 1, overflow: 'hidden' },
    emptyTitle: { ...t('title'), color: colors.ink, marginBottom: spacing[2] },
    fieldLabel: { ...t('small'), color: colors.ink2, fontWeight: '500', marginBottom: 6 },
    fieldLabelSpaced: { marginTop: spacing[4] },
    help: { ...t('small'), color: colors.ink3, marginBottom: spacing[3] },
    helpMono: { fontFamily: 'JetBrainsMono_400Regular', color: colors.ink2 },
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
    linkAction: { gap: spacing[2], marginTop: spacing[3] },
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
    scanTitle: { ...t('title'), color: colors.ink },
    scanWrap: { flex: 1, padding: spacing[5] },
    spacer: { height: spacing[5] },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing[3],
      paddingHorizontal: spacing[5],
      paddingTop: spacing[2],
    },
    title: {
      color: colors.ink,
      fontFamily: family.serif,
      fontSize: 26,
      letterSpacing: -0.3,
    },
    unavailable: { ...t('small'), color: colors.ink3 },
  });
