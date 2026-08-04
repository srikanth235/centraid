import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  appLockEnabled,
  authenticateAppLock,
  canUseAppLock,
  disableAppLock,
  enableAppLock,
} from "../../lib/app-lock";
import { clearSecureCache } from "../../lib/secure-storage";
import { Text } from "../components/NativeText";
import { family, radii, spacing, t, useTheme } from "../theme";
import type { ThemeColors } from "../theme";

interface AppLockContextValue {
  enabled: boolean;
  supported: boolean;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  lockNow: () => void;
}

const AppLockContext = createContext<AppLockContextValue>({
  enabled: false,
  supported: false,
  enable: async () => undefined,
  disable: async () => undefined,
  lockNow: () => undefined,
});

export function AppLockProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [hydrated, setHydrated] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const authenticatingRef = useRef(false);
  const [error, setError] = useState<string>();

  const unlock = useCallback(async (): Promise<void> => {
    if (authenticatingRef.current) return;
    authenticatingRef.current = true;
    setAuthenticating(true);
    setError(undefined);
    try {
      if (await authenticateAppLock()) setUnlocked(true);
      else
        setError(
          "The biometric key changed. Reinstall Centraid to reset this protected local replica."
        );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Authentication was cancelled."
      );
    } finally {
      authenticatingRef.current = false;
      setAuthenticating(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const next = await appLockEnabled();
      setEnabled(next);
      setUnlocked(!next);
      setHydrated(true);
      if (next) await unlock();
    })();
  }, [unlock]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (!enabled) return;
      if (next === "active") {
        if (!unlocked) void unlock();
        return;
      }
      clearSecureCache();
      setUnlocked(false);
    });
    return () => sub.remove();
  }, [enabled, unlocked, unlock]);

  const value = useMemo<AppLockContextValue>(
    () => ({
      enabled,
      supported: canUseAppLock(),
      enable: async () => {
        await enableAppLock();
        setEnabled(true);
        setUnlocked(true);
      },
      disable: async () => {
        await disableAppLock();
        setEnabled(false);
        setUnlocked(true);
      },
      lockNow: () => {
        clearSecureCache();
        setUnlocked(false);
      },
    }),
    [enabled]
  );

  if (!hydrated)
    return (
      <SafeAreaView style={styles.screen}>
        <ActivityIndicator color={colors.textFaint} />
      </SafeAreaView>
    );
  if (enabled && !unlocked)
    return (
      <SafeAreaView style={styles.screen}>
        <View accessibilityViewIsModal style={styles.card}>
          <Text style={styles.eyebrow}>DEVICE LOCK</Text>
          <Text style={styles.title}>Centraid is locked</Text>
          <Text style={styles.copy}>
            Your local replica and gateway credentials stay unavailable until
            you authenticate on this device.
          </Text>
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={authenticating}
            onPress={() => void unlock()}
            style={styles.button}
          >
            {authenticating ? (
              <ActivityIndicator color={colors.textInv} />
            ) : (
              <Text style={styles.buttonText}>Unlock</Text>
            )}
          </Pressable>
        </View>
      </SafeAreaView>
    );
  return (
    <AppLockContext.Provider value={value}>{children}</AppLockContext.Provider>
  );
}

export function useAppLock(): AppLockContextValue {
  return useContext(AppLockContext);
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    button: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: radii.md,
      marginTop: spacing[5],
      minHeight: 48,
      justifyContent: "center",
    },
    buttonText: {
      color: colors.textInv,
      fontFamily: family.sansBold,
      fontSize: 15,
    },
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      borderWidth: 1,
      maxWidth: 420,
      padding: spacing[5],
      width: "88%",
    },
    copy: { ...t("body"), color: colors.textSoft, marginTop: spacing[3] },
    error: { ...t("small"), color: colors.danger, marginTop: spacing[3] },
    eyebrow: {
      ...t("control"),
      color: colors.textFaint,
      fontFamily: family.monoBold,
      letterSpacing: 1.2,
    },
    screen: {
      alignItems: "center",
      backgroundColor: colors.bg,
      flex: 1,
      justifyContent: "center",
    },
    title: { ...t("title"), color: colors.text, marginTop: spacing[2] },
  });
