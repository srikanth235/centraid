// Direct sub-paths: the barrel re-exports weights Metro cannot resolve.
// Stay at Instrument Sans 400/600: an unnamed face diverges from the registry.
// The 600 rung comes straight from upstream; the 400 rung's FILE is bundled
// (see the `useFonts` call and kit/theme/native.ts).
import InstrumentSans_600SemiBold from "@expo-google-fonts/instrument-sans/600SemiBold/InstrumentSans_600SemiBold.ttf";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useFonts } from "expo-font";
import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import { ShareIntentProvider } from "expo-share-intent";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect } from "react";
import { Pressable, View, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
  SafeAreaProvider,
  SafeAreaView,
  initialWindowMetrics,
  useSafeAreaInsets,
} from "react-native-safe-area-context";

// The 400 rung, bundled rather than upstream — see the `useFonts` call.
import InstrumentSans_470Book from "./assets/fonts/InstrumentSans_470Book.ttf";
import {
  AgendaNavigator,
  DocsNavigator,
  LockerNavigator,
  PeopleNavigator,
  PhotosNavigator,
  SettingsNavigator,
  TallyNavigator,
} from "./lazy-navigators";
import {
  AssistantScreen,
  AssistantFullScreen,
  AutomationsScreen,
  InsightsScreen,
  NotesHome,
  TasksHome,
  CaptureScreen,
  ConnectorsScreen,
  DataScreen,
  DevicesScreen,
  ScanScreen,
  SignalNotificationScreen,
  SystemOnPhoneScreen,
} from "./lazy-screens";
// Side-effect import: registers Photos as the frame's camera-roll target.
import "./src/apps/photos/camera-roll-target";
import { configurePhotoImageCache } from "./src/apps/photos/image-cache";
import { LINKING } from "./src/deep-links";
import ErrorBoundary from "./src/ErrorBoundary";
import { Text } from "./src/kit/components/NativeText";
import { postStatus } from "./src/kit/components/status-line";
import StatusLine from "./src/kit/components/StatusLine";
import {
  hydrateOfflineContent,
  hydratePinnedContent,
} from "./src/kit/fetch-gate";
import { ShareIntentIngest } from "./src/kit/hooks/ShareIntentIngest";
import FrameProbe from "./src/kit/perf/FrameProbe";
import {
  REPLICA_UNPAIRED_MESSAGE,
  ReplicaProvider,
  useReplica,
} from "./src/kit/replica/ReplicaProvider";
import { AppLockProvider } from "./src/kit/security/AppLock";
import {
  hydrateAppearance,
  navThemeFor,
  radii,
  resolveScheme,
  resolveTheme,
  t,
  useAppearance,
  useTheme,
} from "./src/kit/theme";
import { useCameraRollWatcher } from "./src/lib/camera-roll/useCameraRollWatcher";
import { NotificationCoordinator } from "./src/lib/notifications";
import { hydrateProfile, isOnboarded } from "./src/lib/profile";
import { MOBILE_COMPATIBILITY_WALL_COPY } from "./src/lib/replica/mobile-gateway-compatibility-core";
import {
  clearResyncNotice,
  subscribeResyncNotice,
} from "./src/lib/replica/resync-notice";
import { useUploadReconciliation } from "./src/lib/upload/boot";
import { rootNavigationRef } from "./src/navigation";
import type { RootStackParamList } from "./src/navigation";
import HomeScreen from "./src/screens/Home";
import VaultChromeProvider from "./src/screens/home/VaultChrome";
import OnboardingScreen from "./src/screens/Onboarding";

SplashScreen.preventAutoHideAsync().catch(() => {
  /* noop */
});

// Foregrounded notifications must still surface; the OS swallows them (#14).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const RootStack = createNativeStackNavigator<RootStackParamList>();

// `fullScreenModal`, not `modal`: the iOS card sheet never fills.
const COVER_OPTIONS = {
  animation: "fade",
  presentation: "fullScreenModal",
} as const;

function UploadReconciliation(): null {
  const { session, gatewayBase, vaultId } = useReplica();
  useUploadReconciliation(session);
  // Watcher lives beside the drain, not in Photos (#883 C6): what a sweep does
  // is Photos'; when one may run is the frame's.
  useCameraRollWatcher(
    session && gatewayBase
      ? { session, gatewayBase, ...(vaultId ? { vaultId } : {}) }
      : undefined
  );
  // The frame, not a screen, tells the member about a re-sync: it outlives
  // whichever screen started it (#883 C6).
  useEffect(
    () =>
      subscribeResyncNotice((notice) => {
        if (!notice) return;
        postStatus(`${notice.headline} ${notice.detail}`);
        clearResyncNotice();
      }),
    []
  );
  return null;
}

/** Only a genuine open failure raises the bar. */
function ReplicaErrorBanner(): React.JSX.Element | null {
  const { compatibility, error, ready } = useReplica();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  if (!ready || compatibility || !error || error === REPLICA_UNPAIRED_MESSAGE)
    return null;
  return (
    <View
      style={{
        backgroundColor: colors.danger ?? "#c44",
        paddingBottom: 10,
        paddingHorizontal: 14,
        paddingTop: insets.top + 10,
      }}
    >
      <Text style={{ ...t("small"), color: colors.textInv }}>{error}</Text>
    </View>
  );
}

function ReplicaCompatibilityGate({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { colors } = useTheme();
  const { compatibility, refresh } = useReplica();
  if (!compatibility) return <>{children}</>;
  const copy = MOBILE_COMPATIBILITY_WALL_COPY[compatibility];
  return (
    <SafeAreaView
      style={{
        alignItems: "center",
        backgroundColor: colors.bg,
        flex: 1,
        justifyContent: "center",
        paddingHorizontal: 28,
      }}
    >
      <View
        accessibilityRole="alert"
        style={{
          backgroundColor: colors.bgElev,
          borderColor: colors.lineStrong,
          borderRadius: radii.lg,
          borderWidth: 1,
          maxWidth: 420,
          padding: 24,
          width: "100%",
        }}
      >
        <Text
          style={{
            ...t("display"),
            color: colors.text,
          }}
        >
          {copy.title}
        </Text>
        <Text
          style={{
            ...t("body"),
            color: colors.textSoft,
            marginTop: 10,
          }}
        >
          {copy.body}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void refresh?.()}
          style={{
            alignItems: "center",
            backgroundColor: colors.accent,
            borderRadius: radii.md,
            marginTop: 22,
            paddingHorizontal: 16,
            paddingVertical: 13,
          }}
        >
          <Text
            style={{
              ...t("control"),
              color: colors.textInv,
            }}
          >
            {copy.action}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

export default function App(): React.JSX.Element | null {
  const scheme = resolveScheme(useAppearance(), useColorScheme());
  const { colors } = resolveTheme(scheme);
  const [onboarded, setOnboarded] = React.useState<boolean | null>(null);
  // Tuple dropped: splash does not wait on fonts (see `onReady`).
  //
  // The 400 rung's FILE is a 470, which is a LOWERING and not a third weight:
  // the ramp still names two weights and nothing may ask for a 470
  // (kit/theme/native.ts carries why the phone needs it). The upstream 400
  // static is deliberately absent — no role renders it on a touch surface, so
  // loading it would ship a face nothing can reach.
  useFonts({
    InstrumentSans_470Book,
    InstrumentSans_600SemiBold,
  });

  useEffect(() => {
    // Not sequenced behind profile: first paint would wait on two trips.
    void hydrateAppearance();
    void hydrateProfile().then(() => setOnboarded(isOnboarded()));
    // Both are read synchronously on the render path (#883 C6).
    void hydratePinnedContent();
    void hydrateOfflineContent();
    // From an effect: touches a native module; first paint does not need it.
    configurePhotoImageCache();
  }, []);

  // Lift splash on profile hydrate, not fonts: a `!fontsLoaded` gate blanks
  // every cold start (#659).
  const onReady = useCallback(async () => {
    if (onboarded !== null) {
      await SplashScreen.hideAsync().catch(() => {
        /* noop */
      });
    }
  }, [onboarded]);

  useEffect(() => {
    void onReady();
  }, [onReady]);

  if (onboarded === null) {
    return null;
  }

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* Does not fix cover-screen top inset — use TopSafeArea. */}
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <View
            style={{ backgroundColor: colors.bg, flex: 1 }}
            onLayout={onReady}
          >
            <ShareIntentProvider
              options={{ scheme: "centraid", resetOnBackground: false }}
            >
              <AppLockProvider>
                <ReplicaProvider>
                  <ReplicaCompatibilityGate>
                    <UploadReconciliation />
                    <ShareIntentIngest />
                    <NotificationCoordinator />
                    {/* Onboarding has not paired yet — a replica-open banner is noise. */}
                    {onboarded ? <ReplicaErrorBanner /> : null}
                    {onboarded ? (
                      <NavigationContainer
                        ref={rootNavigationRef}
                        linking={LINKING}
                        theme={navThemeFor(scheme)}
                      >
                        <StatusBar
                          style={scheme === "dark" ? "light" : "dark"}
                        />
                        {/* INSIDE the container: the provider routes New chat
                            and a search hit, so it needs a navigation object.
                            Outside it, `useNavigation` throws on first paint. */}
                        <VaultChromeProvider>
                          {/* Bare fill, not a spinner — lazy eval is sub-frame. */}
                          <React.Suspense
                            fallback={
                              <View
                                style={{ backgroundColor: colors.bg, flex: 1 }}
                              />
                            }
                          >
                            <RootStack.Navigator
                              screenOptions={{ headerShown: false }}
                              // Haptic on cover open only — not dismissal.
                              screenListeners={{
                                transitionStart: (e) => {
                                  if (!e.data.closing)
                                    void Haptics.selectionAsync();
                                },
                              }}
                            >
                              <RootStack.Screen
                                name="Home"
                                component={HomeScreen}
                              />
                              <RootStack.Screen
                                name="Capture"
                                component={CaptureScreen}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Scan"
                                component={ScanScreen}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Photos"
                                component={PhotosNavigator}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Docs"
                                component={DocsNavigator}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Agenda"
                                component={AgendaNavigator}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Locker"
                                component={LockerNavigator}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Tasks"
                                component={TasksHome}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="People"
                                component={PeopleNavigator}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Notes"
                                component={NotesHome}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Tally"
                                component={TallyNavigator}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Assistant"
                                component={AssistantScreen}
                                options={{
                                  animation: "none",
                                  presentation: "transparentModal",
                                }}
                              />
                              <RootStack.Screen
                                name="AssistantFull"
                                component={AssistantFullScreen}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="SystemOnPhone"
                                component={SystemOnPhoneScreen}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="SignalNotification"
                                component={SignalNotificationScreen}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Automations"
                                component={AutomationsScreen}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Insights"
                                component={InsightsScreen}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Connectors"
                                component={ConnectorsScreen}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Data"
                                component={DataScreen}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Devices"
                                component={DevicesScreen}
                                options={COVER_OPTIONS}
                              />
                              <RootStack.Screen
                                name="Settings"
                                component={SettingsNavigator}
                                options={COVER_OPTIONS}
                              />
                            </RootStack.Navigator>
                          </React.Suspense>
                        </VaultChromeProvider>
                      </NavigationContainer>
                    ) : (
                      <>
                        <StatusBar style="light" />
                        <OnboardingScreen onDone={() => setOnboarded(true)} />
                      </>
                    )}
                  </ReplicaCompatibilityGate>
                </ReplicaProvider>
              </AppLockProvider>
            </ShareIntentProvider>
            {/* Last child so the readout sits above the navigator. */}
            <FrameProbe />
            <StatusLine />
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
