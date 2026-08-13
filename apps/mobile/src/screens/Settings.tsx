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
import AppearanceSection from "./settings/AppearanceSection";
import AppLockSection from "./settings/AppLockSection";
import BandSection from "./settings/BandSection";
import SettingsSection from "./settings/SettingsSection";
import VaultSection from "./settings/VaultSection";
import YouSection from "./settings/YouSection";

// Settings is a full-screen cover over Home (springboard model): a native back
// arrow returns to Home (no pull-down on a full-screen modal), and the title sits
// in the editorial serif to match Home's greeting. Sections read top-to-bottom as
// one designed surface: You (local profile) · Appearance (theme override) ·
// Vault (the active vault) · Desktop link (pairing) · Approvals · Advanced.
//
// The desktop link is the primary connection path: scan a desktop "Connect phone"
// QR, or a headless `centraid-gateway pair` / `pair --qr` terminal QR on a VPS,
// or paste the one-line ticket — everything then loads through an encrypted
// tunnel, no URLs or tokens. The manual URL/token fields under Advanced remain a
// dev fallback for simulators pointing at a token-less local gateway.
//
// BOTH pairing branches offer BOTH roads. The paste field used to render only in
// the unpaired branch, so a phone that had already paired once could add a second
// gateway by camera alone — and a camera is exactly what the two cases that need
// a ticket do not have: a simulator, and a headless VPS whose QR lives in a
// terminal on the same machine you are typing on. The only way back to the paste
// field was to unpair (or reinstall), which throws away a working link to add
// one. Adding a vault must never cost the vault you already have.

interface TicketPasteProps {
  value: string;
  onChangeText: (next: string) => void;
  onSubmit: () => void;
  pairing: boolean;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
  label: string;
}

/** The paste road to a pairing ticket — rendered in BOTH pairing branches. */
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
}: SettingsScreenProps<"Settings">): React.JSX.Element {
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
    // Settings is a cover over Home — dismiss it back to the launcher, which
    // reloads its app list against the new gateway on focus.
    navigation.getParent()?.goBack();
  };

  if (scanning) {
    return (
      <PairScanner onScanned={onScanned} onCancel={() => setScanning(false)} />
    );
  }

  return (
    // `useSafeAreaInsets` + an explicit `paddingTop`, NOT `<TopSafeArea
    // edges={["top"]}>`. Every screen in this app is presented with
    // `COVER_OPTIONS` (a native `fullScreenModal`), and inside that
    // presentation the `edges` form resolved to a ZERO top inset here — the
    // back arrow and the title drew straight through the status bar, over the
    // clock. The hook is what Photos' own cover screens already use
    // (`PhotosHome.tsx`, `PhotosScreen.tsx`), and those render correctly, so
    // this is the form that is known to work under a cover rather than the one
    // that reads better.
    <View style={[styles.safe, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to home"
          hitSlop={10}
          onPress={() => navigation.getParent()?.goBack()}
        >
          <Icon name="arrow-left" size={26} color={colors.text} />
        </Pressable>
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
                Switch between your connected vaults from the vault menu on
                Home. Pair another desktop or gateway to add its vault here too.
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
                  Pairing needs a development build — the tunnel module isn't
                  available in Expo Go. Use the Advanced section below to point
                  at a dev gateway instead.
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
          >
            <Icon name="Share" size={18} color={colors.textSoft} />
            <Text style={styles.rowLabel}>People, links and shared vaults</Text>
            <Icon name="ChevronRight" size={16} color={colors.textFaint} />
          </Pressable>
        </SettingsSection>

        <SettingsSection label="Storage">
          <Pressable
            onPress={() => navigation.navigate("PhoneStorage")}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            accessibilityLabel="Phone storage"
          >
            <Icon name="Folder" size={18} color={colors.textSoft} />
            <Text style={styles.rowLabel}>Vault storage on this phone</Text>
            <Icon name="ChevronRight" size={16} color={colors.textFaint} />
          </Pressable>
          {/* Backup health moved here from the Photos stack (issue #712 B2).
              The two rows are the same question from opposite ends: what this
              phone is HOLDING, and whether what it holds has left it. The
              policy the second one edits governs every byte-bearing app, not
              photographs — which is exactly why it stopped living inside one. */}
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

// --- QR scanner ---

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
    // Same reason as the main screen above: a cover gets no top inset from
    // `<TopSafeArea edges>`, so the scanner's cancel bar landed under the
    // status bar too.
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
            Allow camera access to scan the pairing QR code. You can enable it
            in system settings.
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
