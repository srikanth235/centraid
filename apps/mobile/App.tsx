// Direct sub-path imports avoid the package's barrel index.js which
// re-exports every weight (some of which Metro fails to resolve).
//
// The Binding Layer's four faces, two weights (400 / 500) each where the face
// ships one: Instrument Sans (body/UI), Instrument Serif (display, plus its
// italic for the home greeting), Source Serif 4 (reading), DM Mono (numeric).
import DMMono_400Regular from "@expo-google-fonts/dm-mono/400Regular/DMMono_400Regular.ttf";
import DMMono_500Medium from "@expo-google-fonts/dm-mono/500Medium/DMMono_500Medium.ttf";
import InstrumentSans_400Regular from "@expo-google-fonts/instrument-sans/400Regular/InstrumentSans_400Regular.ttf";
import InstrumentSans_500Medium from "@expo-google-fonts/instrument-sans/500Medium/InstrumentSans_500Medium.ttf";
import InstrumentSerif_400Regular from "@expo-google-fonts/instrument-serif/400Regular/InstrumentSerif_400Regular.ttf";
import InstrumentSerif_400Regular_Italic from "@expo-google-fonts/instrument-serif/400Regular_Italic/InstrumentSerif_400Regular_Italic.ttf";
import SourceSerif4_400Regular from "@expo-google-fonts/source-serif-4/400Regular/SourceSerif4_400Regular.ttf";
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

import { configurePhotoImageCache } from "./src/apps/photos/image-cache";
import { LINKING } from "./src/deep-links";
import ErrorBoundary from "./src/ErrorBoundary";
import { Text } from "./src/kit/components/NativeText";
import StatusLine from "./src/kit/components/StatusLine";
import { ShareIntentIngest } from "./src/kit/hooks/ShareIntentIngest";
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
import { NotificationCoordinator } from "./src/lib/notifications";
import { hydrateProfile, isOnboarded } from "./src/lib/profile";
import { MOBILE_COMPATIBILITY_WALL_COPY } from "./src/lib/replica/mobile-gateway-compatibility-core";
import { useUploadReconciliation } from "./src/lib/upload/boot";
import { rootNavigationRef } from "./src/navigation";
import type {
  AgendaStackParamList,
  DocsStackParamList,
  PhotosStackParamList,
  RootStackParamList,
  SettingsStackParamList,
} from "./src/navigation";
// Only the two screens that can be on screen at first paint are imported
// eagerly: Home is the initial route of the root stack, Onboarding is what the
// tree renders instead when the profile says the user has not been through it.
import HomeScreen from "./src/screens/Home";
import OnboardingScreen from "./src/screens/Onboarding";

/**
 * Defer a screen module's *evaluation* until the first navigation to it.
 *
 * Metro has no code splitting, so the bytes still ship in the launch bundle —
 * what this buys is that `react-native-maps`, `expo-camera`,
 * `react-native-webview` and `expo-video` no longer run their module bodies
 * (and therefore their `requireNativeComponent` / TurboModule registration) as
 * part of app start. That native-module init is the measurable cold-start cost,
 * not the parse.
 *
 * The wrapper exists so the result stays a plain `ComponentType<P>`:
 * `React.lazy` returns a `LazyExoticComponent`, which react-navigation's
 * `component=` prop does not accept.
 */
function lazyScreen<P extends object>(
  load: () => Promise<{ default: React.ComponentType<P> }>
): React.ComponentType<P> {
  const Lazy = React.lazy(load);
  function LazyScreen(props: P): React.JSX.Element {
    return <Lazy {...props} />;
  }
  return LazyScreen;
}

// Every screen below is reachable only through a `component=` prop on a
// navigator, so nothing else in this file may reference these bindings — that
// is what keeps the deferral honest.
const AgendaEvent = lazyScreen(() => import("./src/apps/agenda/AgendaEvent"));
const AgendaHome = lazyScreen(() => import("./src/apps/agenda/AgendaHome"));
const AssistantScreen = lazyScreen(
  () => import("./src/apps/assistant/Assistant")
);
const AutomationsScreen = lazyScreen(
  () => import("./src/apps/automations/Automations")
);
const DocsHome = lazyScreen(() => import("./src/apps/docs/DocsHome"));
const DocumentViewer = lazyScreen(
  () => import("./src/apps/docs/DocumentViewer")
);
const InsightsScreen = lazyScreen(() => import("./src/apps/insights/Insights"));
const LockerHome = lazyScreen(() => import("./src/apps/locker/LockerHome"));
const NotesHome = lazyScreen(() => import("./src/apps/notes/NotesHome"));
const PeopleHome = lazyScreen(() => import("./src/apps/people/PeopleHome"));
const AlbumDetail = lazyScreen(() => import("./src/apps/photos/AlbumDetail"));
const DuplicateReview = lazyScreen(
  () => import("./src/apps/photos/DuplicateReview")
);
const DuplicatesShelf = lazyScreen(
  () => import("./src/apps/photos/DuplicatesShelf")
);
const FaceReview = lazyScreen(() => import("./src/apps/photos/FaceReview"));
const MemoriesView = lazyScreen(() => import("./src/apps/photos/MemoriesView"));
const PhotosPeopleView = lazyScreen(
  () => import("./src/apps/photos/PhotosPeopleView")
);
const PhotoPicker = lazyScreen(() => import("./src/apps/photos/PhotoPicker"));
const PhotoLightbox = lazyScreen(
  () => import("./src/apps/photos/PhotoLightbox")
);
const PhotosHome = lazyScreen(() => import("./src/apps/photos/PhotosHome"));
const PhotosLibrary = lazyScreen(
  () => import("./src/apps/photos/PhotosLibrary")
);
const PhotosSearch = lazyScreen(() => import("./src/apps/photos/PhotosSearch"));
const PhotoStateView = lazyScreen(
  () => import("./src/apps/photos/PhotoStateView")
);
const PlacesMap = lazyScreen(() => import("./src/apps/photos/PlacesMap"));
const PlacesView = lazyScreen(() => import("./src/apps/photos/PlacesView"));
const PlaceDetail = lazyScreen(() => import("./src/apps/photos/PlaceDetail"));
const TallyHome = lazyScreen(() => import("./src/apps/tally/TallyHome"));
const TasksHome = lazyScreen(() => import("./src/apps/tasks/TasksHome"));
const AppDetailScreen = lazyScreen(() => import("./src/screens/AppDetail"));
const ApprovalsScreen = lazyScreen(() => import("./src/screens/Approvals"));
// A FRAME screen since issue #712 B2 — it moved out of the Photos stack whole.
const BackupHealthScreen = lazyScreen(
  () => import("./src/screens/BackupHealth")
);
const CaptureScreen = lazyScreen(() => import("./src/screens/Capture"));
const PhoneStorageScreen = lazyScreen(
  () => import("./src/screens/PhoneStorage")
);
const ScanScreen = lazyScreen(() => import("./src/screens/Scan"));
const SettingsScreen = lazyScreen(() => import("./src/screens/Settings"));
const SharingScreen = lazyScreen(() => import("./src/screens/Sharing"));

// Held until the profile prefs say onboarding vs app — see the comment on the
// `onboarded === null` gate in App() for why fonts are deliberately *not* part
// of this condition any more.
SplashScreen.preventAutoHideAsync().catch(() => {
  /* noop */
});

// Surface scheduled notifications even when the app is foregrounded —
// otherwise the OS swallows them silently, which is confusing for things
// like Focus timers and Hydrate reminders. See issue #14 (Phase C bridges).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const RootStack = createNativeStackNavigator<RootStackParamList>();
const PhotosStack = createNativeStackNavigator<PhotosStackParamList>();
const DocsStack = createNativeStackNavigator<DocsStackParamList>();
const AgendaStack = createNativeStackNavigator<AgendaStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();

// Presenting an app cover: an edge-to-edge full-screen modal that cross-fades in
// (`fade`). `fullScreenModal` (not `modal`) so the cover truly covers the screen —
// the plain `modal` presentation is the native iOS card sheet (rounded top, inset,
// parent receding behind), which is what gives the interactive pull-down but never
// fills the screen. A cover has no native pull-down then; it exits via the in-app
// leave key. A true zoom-out-of-the-tile transition isn't expressible on
// native-stack, which only takes fixed animation presets. Headers stay hidden —
// each screen draws its own bar.
const COVER_OPTIONS = {
  animation: "fade",
  presentation: "fullScreenModal",
} as const;

function UploadReconciliation(): null {
  const { session } = useReplica();
  useUploadReconciliation(session);
  return null;
}

function PhotosNavigator(): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <PhotosStack.Navigator
        screenOptions={{
          contentStyle: { backgroundColor: colors.bg },
          headerShown: false,
        }}
      >
        <PhotosStack.Screen name="PhotosHome" component={PhotosHome} />
        <PhotosStack.Screen
          name="PhotoLightbox"
          component={PhotoLightbox}
          options={{ animation: "fade_from_bottom", gestureEnabled: false }}
        />
        <PhotosStack.Screen name="PhotosLibrary" component={PhotosLibrary} />
        <PhotosStack.Screen name="PhotosSearch" component={PhotosSearch} />
        <PhotosStack.Screen name="PlacesView" component={PlacesView} />
        <PhotosStack.Screen name="PlacesMap" component={PlacesMap} />
        <PhotosStack.Screen name="PlaceDetail" component={PlaceDetail} />
        <PhotosStack.Screen name="FaceReview" component={FaceReview} />
        <PhotosStack.Screen name="PhotosPeople" component={PhotosPeopleView} />
        <PhotosStack.Screen
          name="DuplicatesShelf"
          component={DuplicatesShelf}
        />
        <PhotosStack.Screen
          name="DuplicateReview"
          component={DuplicateReview}
        />
        <PhotosStack.Screen name="PhotosMemories" component={MemoriesView} />
        <PhotosStack.Screen name="AlbumDetail" component={AlbumDetail} />
        <PhotosStack.Screen name="PhotoPicker" component={PhotoPicker} />
        <PhotosStack.Screen name="PhotoStateView" component={PhotoStateView} />
      </PhotosStack.Navigator>
    </View>
  );
}

function DocsNavigator(): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <DocsStack.Navigator
      screenOptions={{
        contentStyle: { backgroundColor: colors.bg },
        headerShown: false,
      }}
    >
      <DocsStack.Screen name="DocsHome" component={DocsHome} />
      <DocsStack.Screen name="DocumentViewer" component={DocumentViewer} />
    </DocsStack.Navigator>
  );
}

function AgendaNavigator(): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <AgendaStack.Navigator
      screenOptions={{
        contentStyle: { backgroundColor: colors.bg },
        headerShown: false,
      }}
    >
      <AgendaStack.Screen name="AgendaHome" component={AgendaHome} />
      <AgendaStack.Screen name="AgendaEvent" component={AgendaEvent} />
    </AgendaStack.Navigator>
  );
}

function SettingsNavigator(): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <SettingsStack.Navigator
      screenOptions={{
        animation: "slide_from_right",
        contentStyle: { backgroundColor: colors.bg },
        headerShown: false,
      }}
    >
      <SettingsStack.Screen name="Settings" component={SettingsScreen} />
      <SettingsStack.Screen name="Approvals" component={ApprovalsScreen} />
      <SettingsStack.Screen name="Sharing" component={SharingScreen} />
      <SettingsStack.Screen
        name="PhoneStorage"
        component={PhoneStorageScreen}
      />
      <SettingsStack.Screen
        name="BackupHealth"
        component={BackupHealthScreen}
      />
    </SettingsStack.Navigator>
  );
}

/**
 * Surfaces ReplicaProvider.error when the session fails to open (issue #468 K2).
 * The "never paired yet" case is expected — Home already invites pairing — so it
 * is suppressed here; only a genuine open failure raises the red bar. The top
 * inset keeps that bar clear of the status bar instead of bleeding under it.
 */
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
  active,
  children,
}: {
  // Pairing must be allowed to finish before the post-onboarding shell can
  // cover the screen with a compatibility wall.
  active: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { colors } = useTheme();
  const { compatibility, refresh } = useReplica();
  if (!active || !compatibility) return <>{children}</>;
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
          testID="replica-compatibility-retry"
          accessibilityLabel="Retry connection"
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
  // The device-local Appearance preference (System/Light/Dark) folds over the OS
  // scheme here so the nav container theme + status bar follow it, matching the
  // per-screen `useTheme()` override (src/kit/theme/appearance.ts).
  const scheme = resolveScheme(useAppearance(), useColorScheme());
  const { colors } = resolveTheme(scheme);
  // `null` while the profile prefs hydrate; then true/false gates onboarding.
  const [onboarded, setOnboarded] = React.useState<boolean | null>(null);
  // The return tuple is deliberately dropped: nothing gates on it any more (see
  // the tradeoff note below the effects). `useFonts` still re-renders this
  // component when the faces land, which is what swaps the system fallback out.
  useFonts({
    DMMono_400Regular,
    DMMono_500Medium,
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSerif_400Regular,
    InstrumentSerif_400Regular_Italic,
    SourceSerif4_400Regular,
  });

  useEffect(() => {
    // The appearance read must not sit behind the profile read, or first paint
    // waits on two round trips to AsyncStorage instead of one.
    void hydrateAppearance();
    void hydrateProfile().then(() => setOnboarded(isOnboarded()));
    // expo-image ships with no ceiling on its in-memory bitmap cache, so a long
    // scroll through the photo grid otherwise holds every decoded thumbnail
    // alive. From an effect rather than module scope: it touches a native
    // module, and nothing before first paint depends on it.
    configurePhotoImageCache();
  }, []);

  // Deliberate tradeoff (#659 M3): the splash lifts as soon as the profile has
  // hydrated, *without* waiting on the ten font faces. Text therefore paints in
  // the system font for the frame or two before `useFonts` resolves and
  // re-renders. The alternative — the previous `!fontsLoaded` gate — held a
  // blank screen for the whole font load on every cold start, which is a far
  // more expensive way to avoid a brief typeface swap.
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

  // The one gate that survives: it decides onboarding vs app, so there is no
  // correct tree to render before it resolves.
  if (onboarded === null) {
    return null;
  }

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* Seeded with the insets the native side already measured at launch,
            so the first frame is laid out correctly instead of at zero until
            the first JS layout pass reports back. NOTE: this alone does NOT
            fix the cover screens' top inset — that was measured and it does
            not; see `kit/components/TopSafeArea.tsx`. */}
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
                  <ReplicaCompatibilityGate active={onboarded === true}>
                    <UploadReconciliation />
                    <ShareIntentIngest />
                    <NotificationCoordinator />
                    {/* The replica error banner is only meaningful inside the app
                      shell — during onboarding the user hasn't paired yet, so a
                      "couldn't open replica" banner would just be noise. */}
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
                        {/* One boundary for every lazily-evaluated screen. The
                          fallback is a bare themed fill rather than a spinner:
                          module evaluation is sub-frame in the common case, so
                          a spinner would only ever register as a flash. */}
                        <React.Suspense
                          fallback={
                            <View
                              style={{ backgroundColor: colors.bg, flex: 1 }}
                            />
                          }
                        >
                          <RootStack.Navigator
                            screenOptions={{ headerShown: false }}
                            // `selection` haptic when a cover opens — preserves the
                            // vocabulary the old tabPress listener gave, and the one
                            // WebView apps get via expo-haptics (src/lib/bridge/dispatch.ts).
                            // `closing` guards it to the open transition, not dismissal.
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
                              component={LockerHome}
                              options={COVER_OPTIONS}
                            />
                            <RootStack.Screen
                              name="Tasks"
                              component={TasksHome}
                              options={COVER_OPTIONS}
                            />
                            <RootStack.Screen
                              name="People"
                              component={PeopleHome}
                              options={COVER_OPTIONS}
                            />
                            <RootStack.Screen
                              name="Notes"
                              component={NotesHome}
                              options={COVER_OPTIONS}
                            />
                            <RootStack.Screen
                              name="Tally"
                              component={TallyHome}
                              options={COVER_OPTIONS}
                            />
                            <RootStack.Screen
                              name="AppDetail"
                              component={AppDetailScreen}
                              options={COVER_OPTIONS}
                            />
                            <RootStack.Screen
                              name="Assistant"
                              component={AssistantScreen}
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
                              name="Settings"
                              component={SettingsNavigator}
                              options={COVER_OPTIONS}
                            />
                          </RootStack.Navigator>
                        </React.Suspense>
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
            <StatusLine />
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
