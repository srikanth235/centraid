// governance: allow-repo-hygiene file-size-limit The #712 settings surface coordinates coupled gateway, pairing, storage, and device permission state in one screen.
import { CameraView, useCameraPermissions } from "expo-camera";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  View,
  StyleSheet,
  ScrollView,
  Pressable,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Button from "../kit/components/Button";
import Icon from "../kit/components/Icon";
import { Text, TextInput } from "../kit/components/NativeText";
import Tappable from "../kit/components/Tappable";
import { TEST_IDS } from "../kit/test-ids";
import { family, radii, spacing, t, useTheme } from "../kit/theme";
import type { ThemeColors } from "../kit/theme";
import {
  hydrateGatewayToken,
  hydrateGatewayUrl,
  setGatewayToken,
  setGatewayUrl,
} from "../lib/gateway";
import {
  getDesktopName,
  getTunnelStatus,
  hydratePhoneLink,
  isPaired,
  isTunnelAvailable,
  pair,
  subscribeTunnelStatus,
  unpair,
} from "../lib/phone-link";
import type { TunnelStatus } from "../lib/phone-link";
import type { SettingsScreenProps } from "../navigation";
import AccessSection from "./settings/AccessSection";
import AppearanceSection from "./settings/AppearanceSection";
import AppLockSection from "./settings/AppLockSection";
import BandSection from "./settings/BandSection";
import EnrichmentSection from "./settings/EnrichmentSection";
import SettingsSection from "./settings/SettingsSection";
import VaultSection from "./settings/VaultSection";
import YouSection from "./settings/YouSection";

interface TicketPasteProps {
  value: string;
  onChangeText: (next: string) => void;
  onSubmit: () => void;
  pairing: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
  label: string;
}

function TicketPasteField({
  value,
  onChangeText,
  onSubmit,
  pairing,
  styles,
  colors,
  label,
}: TicketPasteProps): React.JSX.Element {
  return (
    <>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="one-line pairing ticket"
        placeholderTextColor={colors.textFaint}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        editable={!pairing}
        accessibilityLabel="Paste pairing ticket"
      />
      <View style={styles.actions}>
        <Button
          label={pairing ? "Pairing…" : "Pair with ticket"}
          icon="Key"
          onPress={onSubmit}
          disabled={pairing || value.trim().length === 0}
        />
      </View>
    </>
  );
}

function defaultDeviceName(): string {
  return Platform.OS === "ios" ? "iPhone" : "Android phone";
}

function tunnelStatusLabel(status: TunnelStatus | undefined): string {
  if (!status) return "Checking…";
  switch (status.state) {
    case "running":
      return status.port ? `Connected (port ${status.port})` : "Connected";
    case "starting":
      return "Connecting…";
    case "error":
      return `Error: ${status.error ?? "unknown"}`;
    case "stopped":
      return "Not connected";
  }
}

export default function SettingsScreen({
  navigation,
}: SettingsScreenProps<"SettingsHome">): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [paired, setPaired] = useState(false);
  const [desktopName, setDesktopName] = useState("");
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus | undefined>(
    undefined
  );
  const [scanning, setScanning] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | undefined>(undefined);
  const [pasteTicket, setPasteTicket] = useState("");

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const [tokenValue, setTokenValue] = useState("");
  const [hydrated, setHydrated] = useState(false);

  const tunnelAvailable = isTunnelAvailable();

  useEffect(() => {
    void Promise.all([
      hydratePhoneLink(),
      hydrateGatewayUrl(),
      hydrateGatewayToken(),
    ]).then(([, url, token]) => {
      setPaired(isPaired());
      setDesktopName(getDesktopName());
      setUrlValue(url);
      setTokenValue(token);
      setHydrated(true);
    });
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
        setPasteTicket("");
      })
      .catch((error: unknown) => {
        setPairError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setPairing(false));
  }, []);

  const onScanned = useCallback(
    (payload: string): void => {
      setScanning(false);
      runPair(payload);
    },
    [runPair]
  );

  const onPastePair = useCallback((): void => {
    runPair(pasteTicket);
  }, [pasteTicket, runPair]);

  const unpairNow = useCallback((): void => {
    void unpair().then(() => {
      setPaired(false);
      setDesktopName("");
      setTunnelStatus(undefined);
    });
  }, []);

  const onUnpair = useCallback((): void => {
    Alert.alert(
      "Unpair this device?",
      "The encrypted link will be removed from this phone. The gateway and its vaults stay intact.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Unpair", style: "destructive", onPress: unpairNow },
      ]
    );
  }, [unpairNow]);

  const saveAdvanced = (): void => {
    setGatewayUrl(urlValue);
    setGatewayToken(tokenValue);
    navigation.getParent()?.goBack();
  };

  if (scanning) {
    return (
      <PairScanner onScanned={onScanned} onCancel={() => setScanning(false)} />
    );
  }

  return (
    <View
      style={[styles.safe, { paddingTop: insets.top }]}
      testID={TEST_IDS.settings.screen}
    >
      <View style={styles.header}>
        <Tappable
          accessibilityRole="button"
          accessibilityLabel="Back to home"
          hitSlop={10}
          onPress={() => navigation.getParent()?.goBack()}
        >
          <Icon name="arrow-left" size={26} color={colors.text} />
        </Tappable>
        <Text style={styles.title}>Settings</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        <YouSection />
        <AppearanceSection />
        <AppLockSection />
        <VaultSection />
        {/* Read-only view of the effective enrichment policy (#807) —
            it sits under Vault because it is a fact ABOUT the vault, and above
            the device/link sections that are facts about this phone. */}
        <EnrichmentSection />
        {/* The one dashboard over standing answers (#883, ruling V-dashboard):
            the same rows, grouping and words as the desktop's Settings →
            Access, rendered for this seat. It sits under the vault's own facts
            and above the facts about this phone. */}
        <AccessSection />
        <BandSection />

        <SettingsSection label="Desktop link">
          {paired ? (
            <View style={styles.linkCard}>
              <Text style={styles.linkName}>
                {desktopName || "Your gateway"}
              </Text>
              <Text style={styles.linkStatus}>
                {tunnelStatusLabel(tunnelStatus)}
              </Text>
              <Text style={styles.help}>
                Switch vaults from the vault menu on Home — pair another desktop
                to add one here.
              </Text>
              <View style={styles.linkAction}>
                {tunnelAvailable ? (
                  <Button
                    label={pairing ? "Pairing…" : "Pair another"}
                    icon="Camera"
                    variant="secondary"
                    onPress={() => setScanning(true)}
                    disabled={pairing}
                  />
                ) : null}
                <Button
                  label="Unpair"
                  icon="X"
                  variant="secondary"
                  onPress={onUnpair}
                />
              </View>
              {tunnelAvailable ? (
                <View style={styles.advanced}>
                  <TicketPasteField
                    label="Or paste another ticket"
                    value={pasteTicket}
                    onChangeText={setPasteTicket}
                    onSubmit={onPastePair}
                    pairing={pairing}
                    styles={styles}
                    colors={colors}
                  />
                </View>
              ) : null}
              {pairError ? (
                <Text style={styles.pairError}>{pairError}</Text>
              ) : null}
            </View>
          ) : (
            <View>
              <Text style={styles.help}>
                Scan a desktop "Connect phone" QR, or a terminal QR from{" "}
                <Text style={styles.helpMono}>centraid-gateway pair --qr</Text>{" "}
                on a VPS. You can also paste the one-line ticket. Apps then load
                over an encrypted tunnel.
              </Text>
              {tunnelAvailable ? (
                <>
                  <Button
                    label={pairing ? "Pairing…" : "Scan QR code"}
                    icon="Camera"
                    onPress={() => setScanning(true)}
                    disabled={pairing}
                  />
                  <View style={styles.spacer} />
                  <TicketPasteField
                    label="Or paste ticket"
                    value={pasteTicket}
                    onChangeText={setPasteTicket}
                    onSubmit={onPastePair}
                    pairing={pairing}
                    styles={styles}
                    colors={colors}
                  />
                </>
              ) : (
                <Text style={styles.unavailable}>
                  The tunnel module isn't available in Expo Go — point at a dev
                  gateway in Advanced, below.
                </Text>
              )}
              {pairError ? (
                <Text style={styles.pairError}>{pairError}</Text>
              ) : null}
            </View>
          )}
        </SettingsSection>

        <SettingsSection label="Notifications">
          <Pressable
            onPress={() => navigation.navigate("Approvals")}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            accessibilityLabel="Notifications"
          >
            <Icon name="CheckCircle" size={18} color={colors.textSoft} />
            <Text style={styles.rowLabel}>Decisions and updates</Text>
            <Icon name="ChevronRight" size={16} color={colors.textFaint} />
          </Pressable>
        </SettingsSection>

        <SettingsSection label="Sharing">
          <Pressable
            onPress={() => navigation.navigate("Sharing")}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            accessibilityLabel="Sharing"
            testID={TEST_IDS.settings.sharingRow}
          >
            <Icon name="Share" size={18} color={colors.textSoft} />
            <Text style={styles.rowLabel}>People you are linked with</Text>
            <Icon name="ChevronRight" size={16} color={colors.textFaint} />
          </Pressable>
        </SettingsSection>

        <SettingsSection label="Storage">
          <Pressable
            onPress={() => navigation.navigate("PhoneStorage")}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            accessibilityLabel="On this phone"
          >
            <Icon name="Folder" size={18} color={colors.textSoft} />
            <Text style={styles.rowLabel}>On this phone</Text>
            <Icon name="ChevronRight" size={16} color={colors.textFaint} />
          </Pressable>
          {/* Backup health is a FRAME row, not a Photos one (#712). The two
              rows are the same question from opposite ends: what this phone is
              HOLDING, and whether what it holds has left it. The policy the
              second one edits governs every byte-bearing app, not photographs
              — which is why it may not live inside one. */}
          <View style={styles.rowGap} />
          <Pressable
            onPress={() => navigation.navigate("BackupHealth")}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            accessibilityLabel="Backup health"
          >
            <Icon name="upload-cloud" size={18} color={colors.textSoft} />
            <Text style={styles.rowLabel}>
              Backup health and transfer rules
            </Text>
            <Icon name="ChevronRight" size={16} color={colors.textFaint} />
          </Pressable>
        </SettingsSection>

        <SettingsSection label="Advanced (developer)">
          <Pressable
            onPress={() => setAdvancedOpen((v) => !v)}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            accessibilityLabel="Gateway connection"
          >
            <Icon name="Code" size={18} color={colors.textSoft} />
            <Text style={styles.rowLabel}>Gateway connection</Text>
            <Icon
              name={advancedOpen ? "ChevronDown" : "ChevronRight"}
              size={16}
              color={colors.textFaint}
            />
          </Pressable>

          {advancedOpen ? (
            <View style={styles.advanced}>
              <Text style={styles.fieldLabel}>Gateway URL</Text>
              <Text style={styles.help}>
                Dev fallback for simulators: a directly reachable gateway, e.g.
                http://127.0.0.1:18789. An authed gateway needs the tunnel — the
                WebView attaches no token.
              </Text>
              <TextInput
                value={urlValue}
                onChangeText={setUrlValue}
                placeholder="http://127.0.0.1:18789"
                placeholderTextColor={colors.textFaint}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                editable={hydrated}
              />
              <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>
                Gateway token
              </Text>
              <Text style={styles.help}>
                Bearer token used only for the app list and approvals fetches in
                this mode.
              </Text>
              <TextInput
                value={tokenValue}
                onChangeText={setTokenValue}
                placeholder="paste token here"
                placeholderTextColor={colors.textFaint}
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
    </View>
  );
}

function PairScanner({
  onScanned,
  onCancel,
}: {
  onScanned: (payload: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  return (
    <View style={[styles.scanSafe, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        <Pressable
          onPress={onCancel}
          hitSlop={12}
          accessibilityLabel="Cancel scan"
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
        >
          <Icon name="ArrowLeft" size={20} color={colors.text} />
        </Pressable>
        <Text style={styles.scanTitle}>Scan pairing code</Text>
        <View style={styles.barSpacer} />
      </View>
      {permission?.granted ? (
        <View style={styles.scanWrap}>
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => {
              if (scannedRef.current) return;
              scannedRef.current = true;
              onScanned(data);
            }}
          />
          <Text style={styles.scanHint}>
            Point the camera at a desktop "Connect phone" QR or a gateway `pair
            --qr` terminal QR.
          </Text>
        </View>
      ) : (
        <View style={styles.scanDenied}>
          <Text style={styles.emptyTitle}>Camera access needed.</Text>
          <Text style={styles.help}>
            Allow camera access in system settings to scan the pairing code.
          </Text>
          <Button label="Back" variant="secondary" onPress={onCancel} />
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actions: { marginTop: spacing[5] },
    advanced: { marginTop: spacing[4] },
    backBtn: {
      alignItems: "center",
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    bar: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingVertical: spacing[2],
    },
    barSpacer: { width: 36 },
    body: {
      paddingBottom: spacing[6],
      paddingHorizontal: spacing[5],
      paddingTop: spacing[4],
    },
    camera: { borderRadius: radii.md, flex: 1, overflow: "hidden" },
    emptyTitle: { ...t("title"), color: colors.text, marginBottom: spacing[2] },
    fieldLabel: {
      ...t("smallStrong"),
      color: colors.textSoft,
      marginBottom: 6,
    },
    fieldLabelSpaced: { marginTop: spacing[4] },
    help: { ...t("small"), color: colors.textFaint, marginBottom: spacing[3] },
    helpMono: {
      fontFamily: family.sansRegular,
      color: colors.textSoft,
    },
    input: {
      ...t("body"),
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      color: colors.text,
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
    linkName: { ...t("bodyStrong"), color: colors.text },
    linkStatus: { ...t("small"), color: colors.textFaint, marginTop: 2 },
    pairError: { ...t("small"), color: colors.danger, marginTop: spacing[3] },
    row: {
      alignItems: "center",
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      flexDirection: "row",
      gap: spacing[3],
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    rowGap: { height: spacing[2] },
    rowLabel: { ...t("body"), color: colors.text, flex: 1 },
    safe: { backgroundColor: colors.bg, flex: 1 },
    scanDenied: { padding: spacing[5] },
    scanHint: {
      ...t("small"),
      color: colors.textFaint,
      marginTop: spacing[3],
      textAlign: "center",
    },
    scanSafe: { backgroundColor: colors.bg, flex: 1 },
    scanTitle: { ...t("title"), color: colors.text },
    scanWrap: { flex: 1, padding: spacing[5] },
    spacer: { height: spacing[5] },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[3],
      paddingHorizontal: spacing[5],
      paddingTop: spacing[2],
    },
    title: {
      ...t("display"),
      color: colors.text,
    },
    unavailable: { ...t("small"), color: colors.textFaint },
  });
