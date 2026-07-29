import * as Clipboard from "expo-clipboard";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import AppHeader from "../../kit/components/AppHeader";
import Icon from "../../kit/components/Icon";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import { useTheme } from "../../kit/theme";
import { appQuery, resolveAppMeta } from "../../lib/gateway";
import type { LockerScreenProps } from "../../navigation";
import {
  lockerBiometricsSupported,
  lockerDeviceCredentialId,
  newLockerDeviceSecret,
  readLockerDeviceCredential,
  removeLockerDeviceCredential,
  storeLockerDeviceCredential,
} from "./locker-device-auth";
import { makeLockerStyles } from "./LockerHome.styles";
import type {
  AuthResult,
  ItemsResult,
  LockerItem,
  LockerRow,
  ScreenState,
} from "./LockerHome.types";
import { ItemAuthModal, ItemDetailModal, StateCard } from "./LockerHome.views";

const META = resolveAppMeta({
  id: "locker",
  name: "Locker",
  description: "Passwords, codes and secrets under custody.",
  iconKey: "Key",
  colorKey: "slate",
});
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
export default function LockerHome({
  navigation,
}: LockerScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeLockerStyles(colors), [colors]);
  const replica = useReplica();
  const [screen, setScreen] = useState<ScreenState>({ kind: "loading" });
  const [sessionToken, setSessionToken] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [working, setWorking] = useState(false);
  const [deviceCredentialId, setDeviceCredentialId] = useState<string | null>(
    null
  );
  const [detail, setDetail] = useState<LockerItem | null>(null);
  const [pendingItem, setPendingItem] = useState<LockerRow | null>(null);
  const [itemPassphrase, setItemPassphrase] = useState("");
  const [itemError, setItemError] = useState<string>();
  const [masked, setMasked] = useState(false);
  const [activityNonce, setActivityNonce] = useState(0);
  const lastCopied = useRef<string | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearClipboard = useCallback(async (): Promise<void> => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = null;
    const value = lastCopied.current;
    lastCopied.current = null;
    if (!value) return;
    const current = await Clipboard.getStringAsync().catch(() => "");
    if (current === value)
      await Clipboard.setStringAsync("").catch(() => false);
  }, []);

  const callAuth = useCallback(
    (input: Record<string, unknown>) =>
      appQuery<AuthResult>("locker", "auth", input),
    []
  );

  const localLock = useCallback(
    (token = sessionToken): void => {
      if (token)
        void callAuth({ operation: "lock", sessionToken: token }).catch(
          () => undefined
        );
      setSessionToken("");
      setDetail(null);
      setPendingItem(null);
      setPassphrase("");
      setItemPassphrase("");
      setItemError(undefined);
      setScreen((current) => ({
        kind: "locked",
        configured: current.kind === "locked" ? current.configured : true,
      }));
      void clearClipboard();
    },
    [callAuth, clearClipboard, sessionToken]
  );

  const loadItems = useCallback(
    async (token: string): Promise<void> => {
      try {
        const result = await appQuery<ItemsResult>("locker", "items", {
          auth_session: token,
          limit: 500,
        });
        if (result.vaultDenied) {
          setScreen({
            kind: "denied",
            message:
              result.vaultDenied.message ??
              "Locker access needs approval in vault settings.",
          });
          return;
        }
        if (result.authRequired) {
          setSessionToken("");
          setScreen({
            kind: "locked",
            configured: result.configured ?? true,
            message: "Locker relocked after inactivity.",
          });
          return;
        }
        const items = result.items ?? [];
        setScreen(
          items.length === 0
            ? { kind: "empty" }
            : { kind: "ready", items, refreshing: false }
        );
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : String(caughtError);
        setScreen(
          replica.online
            ? { kind: "error", message }
            : {
                kind: "offline",
                message:
                  "Locker stays locked while the gateway is unreachable. Reconnect to reveal secrets.",
              }
        );
      }
    },
    [replica.online]
  );

  const checkStatus = useCallback(async (): Promise<void> => {
    setDeviceCredentialId(await lockerDeviceCredentialId());
    try {
      const result = await callAuth({ operation: "status" });
      setScreen({
        kind: "locked",
        configured: result.configured,
        ...(result.message ? { message: result.message } : {}),
      });
    } catch (caughtError) {
      setScreen({
        kind: "offline",
        message:
          caughtError instanceof Error
            ? caughtError.message
            : "The gateway is unreachable.",
      });
    }
  }, [callAuth]);

  useEffect(() => {
    const timer = setTimeout(() => void checkStatus(), 0);
    return () => clearTimeout(timer);
  }, [checkStatus]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        setMasked(false);
        return;
      }
      setMasked(true);
      localLock();
    });
    return () => sub.remove();
  }, [localLock]);

  useEffect(() => {
    if (!sessionToken) return;
    const timer = setTimeout(() => localLock(sessionToken), SESSION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [activityNonce, localLock, sessionToken]);

  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
      void clearClipboard();
    },
    [clearClipboard]
  );

  const unlockWith = async (
    secret: string,
    credentialId?: string
  ): Promise<void> => {
    setWorking(true);
    try {
      const configured =
        screen.kind === "locked" ? screen.configured : Boolean(sessionToken);
      const result = await callAuth({
        operation: configured ? "unlock" : "configure",
        secret,
        ...(credentialId ? { credentialId } : {}),
      });
      if (!result.ok || !result.sessionToken) {
        setScreen({
          kind: "locked",
          configured: result.configured,
          message:
            result.message ??
            (result.retryAfterMs
              ? `Try again in ${Math.ceil(result.retryAfterMs / 1000)} seconds.`
              : "Authentication failed."),
        });
        return;
      }
      setPassphrase("");
      setSessionToken(result.sessionToken);
      setActivityNonce((value) => value + 1);
      await loadItems(result.sessionToken);
    } catch (caughtError) {
      setScreen({
        kind: "offline",
        message:
          caughtError instanceof Error
            ? caughtError.message
            : "The gateway is unreachable.",
      });
    } finally {
      setWorking(false);
    }
  };

  const biometricUnlock = async (): Promise<void> => {
    setWorking(true);
    try {
      const credential = await readLockerDeviceCredential();
      if (!credential) {
        await removeLockerDeviceCredential();
        setDeviceCredentialId(null);
        setScreen({
          kind: "locked",
          configured: true,
          message:
            "The saved biometric credential changed. Unlock with your primary passphrase.",
        });
        return;
      }
      await unlockWith(credential.secret, credential.credentialId);
    } catch (caughtError) {
      setScreen({
        kind: "locked",
        configured: true,
        message:
          caughtError instanceof Error
            ? caughtError.message
            : "Biometric authentication was cancelled.",
      });
    } finally {
      setWorking(false);
    }
  };

  const enableLockerBiometrics = async (): Promise<void> => {
    if (!sessionToken) return;
    setWorking(true);
    let credentialId = "";
    try {
      const secret = await newLockerDeviceSecret();
      const result = await callAuth({
        label: "Centraid mobile biometric",
        operation: "enroll-device",
        secret,
        sessionToken,
      });
      credentialId = result.credentialId ?? "";
      if (!result.ok || !credentialId)
        throw new Error(result.message ?? "Device enrollment was refused.");
      await storeLockerDeviceCredential(credentialId, secret);
      setDeviceCredentialId(credentialId);
    } catch (caughtError) {
      if (credentialId)
        await callAuth({
          credentialId,
          operation: "revoke-device",
          sessionToken,
        }).catch(() => undefined);
      setScreen({
        kind: "error",
        message:
          caughtError instanceof Error
            ? caughtError.message
            : "Biometric enrollment failed.",
      });
    } finally {
      setWorking(false);
    }
  };

  const revealWith = async (
    row: LockerRow,
    secret: string,
    credentialId?: string
  ): Promise<void> => {
    if (!sessionToken) return;
    setWorking(true);
    try {
      const permit = await callAuth({
        credentialId,
        itemId: row.item_id,
        operation: "authorize-item",
        secret,
        sessionToken,
      });
      if (!permit.ok || !permit.itemToken)
        throw new Error(permit.message ?? "Item authentication failed.");
      const result = await appQuery<{
        item?: LockerItem | null;
        vaultDenied?: { message?: string };
      }>("locker", "item", {
        auth_session: sessionToken,
        item_id: row.item_id,
        item_token: permit.itemToken,
      });
      if (result.vaultDenied)
        throw new Error(
          result.vaultDenied.message ?? "Secret reveal was denied."
        );
      if (!result.item) throw new Error("This Locker item no longer exists.");
      setDetail(result.item);
      setPendingItem(null);
      setItemPassphrase("");
      setItemError(undefined);
      setActivityNonce((value) => value + 1);
    } catch (caughtError) {
      setPendingItem(row);
      setItemPassphrase("");
      setItemError(
        caughtError instanceof Error
          ? caughtError.message
          : "Item authentication failed."
      );
    } finally {
      setWorking(false);
    }
  };

  const openItem = async (row: LockerRow): Promise<void> => {
    setActivityNonce((value) => value + 1);
    setItemError(undefined);
    if (deviceCredentialId) {
      try {
        const credential = await readLockerDeviceCredential();
        if (credential) {
          await revealWith(row, credential.secret, credential.credentialId);
          return;
        }
      } catch {
        // The explicit passphrase sheet below is the honest fallback.
      }
    }
    setPendingItem(row);
  };

  const copySecret = async (value: string): Promise<void> => {
    await Clipboard.setStringAsync(value);
    lastCopied.current = value;
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => {
      void clearClipboard();
    }, 30_000);
  };

  const content = (() => {
    switch (screen.kind) {
      case "loading":
        return <ActivityIndicator color={colors.ink3} style={styles.center} />;
      case "offline":
        return (
          <StateCard
            title="Locker is offline"
            message={screen.message}
            action="Retry"
            onAction={() => void checkStatus()}
            styles={styles}
          />
        );
      case "denied":
        return (
          <StateCard
            title="Locker access needs approval"
            message={screen.message}
            action="Open settings"
            onAction={() =>
              navigation.navigate("Settings", { screen: "Settings" })
            }
            styles={styles}
          />
        );
      case "error":
        return (
          <StateCard
            title="Locker hit a problem"
            message={screen.message}
            action="Retry"
            onAction={() =>
              sessionToken ? void loadItems(sessionToken) : void checkStatus()
            }
            styles={styles}
          />
        );
      case "locked":
        return (
          <View style={styles.locked}>
            <Icon name="Key" size={32} color={colors.ink2} />
            <Text style={styles.stateTitle}>
              {screen.configured ? "Locker is locked" : "Protect Locker"}
            </Text>
            <Text style={styles.stateCopy}>
              {screen.configured
                ? "Enter your primary passphrase. Each secret asks for user presence again before reveal."
                : "Create a primary passphrase of at least 12 characters. It never leaves this online authentication request."}
            </Text>
            <TextInput
              accessibilityLabel={
                screen.configured
                  ? "Locker passphrase"
                  : "Create Locker passphrase"
              }
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setPassphrase}
              onSubmitEditing={() => void unlockWith(passphrase)}
              placeholder={
                screen.configured ? "Primary passphrase" : "New passphrase"
              }
              placeholderTextColor={colors.ink3}
              secureTextEntry
              style={styles.input}
              value={passphrase}
            />
            {screen.message ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {screen.message}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={working || passphrase.length < 12}
              onPress={() => void unlockWith(passphrase)}
              style={[styles.primary, working && styles.disabled]}
            >
              <Text style={styles.primaryText}>
                {screen.configured ? "Unlock" : "Create passphrase"}
              </Text>
            </Pressable>
            {screen.configured && deviceCredentialId ? (
              <Pressable
                accessibilityRole="button"
                disabled={working}
                onPress={() => void biometricUnlock()}
                style={styles.secondary}
              >
                <Text style={styles.secondaryText}>Unlock with biometrics</Text>
              </Pressable>
            ) : null}
          </View>
        );
      case "empty":
        return (
          <StateCard
            title="Locker is empty"
            message="Add your first password, card, secure note, identity, Wi-Fi login, or standalone password."
            styles={styles}
          />
        );
      case "ready":
        return (
          <FlatList
            contentContainerStyle={styles.list}
            data={screen.items}
            keyExtractor={(item) => item.item_id}
            refreshControl={
              <RefreshControl
                refreshing={screen.refreshing}
                onRefresh={() => void loadItems(sessionToken)}
                tintColor={colors.ink3}
              />
            }
            ListHeaderComponent={
              <>
                {!deviceCredentialId && lockerBiometricsSupported() ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={working}
                    onPress={() => void enableLockerBiometrics()}
                    style={styles.biometricCard}
                  >
                    <Text style={styles.biometricTitle}>
                      Use biometrics for Locker
                    </Text>
                    <Text style={styles.biometricCopy}>
                      Store a device-only credential. Your primary passphrase
                      remains the recovery path.
                    </Text>
                  </Pressable>
                ) : null}
                <View style={styles.listHeading}>
                  <Text style={styles.listTitle}>All items</Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => localLock()}
                  >
                    <Text style={styles.lockNow}>Lock</Text>
                  </Pressable>
                </View>
              </>
            }
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                onPress={() => void openItem(item)}
                style={styles.row}
              >
                <View style={styles.rowIcon}>
                  <Icon name="Key" size={18} color={colors.ink2} />
                </View>
                <View style={styles.rowCopy}>
                  <Text numberOfLines={1} style={styles.rowTitle}>
                    {item.title}
                  </Text>
                  <Text numberOfLines={1} style={styles.rowSubtitle}>
                    {item.subtitle}
                  </Text>
                </View>
                <Icon name="ChevronRight" size={16} color={colors.ink3} />
              </Pressable>
            )}
          />
        );
    }
  })();

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader
        title={META.name}
        subtitle="Secrets stay online-only"
        color={META.color}
        iconKey={META.iconKey}
        onBack={() => navigation.goBack()}
      />
      {content}
      <ItemAuthModal
        error={itemError}
        item={pendingItem}
        passphrase={itemPassphrase}
        placeholderColor={colors.ink3}
        styles={styles}
        working={working}
        onChangePassphrase={setItemPassphrase}
        onClose={() => {
          setPendingItem(null);
          setItemError(undefined);
        }}
        onReveal={() => {
          if (pendingItem) void revealWith(pendingItem, itemPassphrase);
        }}
      />
      <ItemDetailModal
        item={detail}
        styles={styles}
        onClose={() => setDetail(null)}
        onCopy={(value) => void copySecret(value)}
      />
      {masked ? (
        <View
          accessibilityLabel="Locker hidden while Centraid is in the background"
          style={styles.mask}
        >
          <Icon name="Key" size={32} color={colors.ink2} />
          <Text style={styles.stateTitle}>Locker is hidden</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}
