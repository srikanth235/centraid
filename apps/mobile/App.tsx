import React, { useCallback, useEffect } from 'react';
import { Text, View, useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFonts } from 'expo-font';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { ShareIntentProvider } from 'expo-share-intent';
import { navThemeFor, resolveTheme } from './src/kit/theme';
import { useUploadReconciliation } from './src/lib/upload/boot';
import { ReplicaProvider, useReplica } from './src/kit/replica/ReplicaProvider';
import { ShareIntentIngest } from './src/kit/hooks/ShareIntentIngest';
import { hydrateProfile, isOnboarded } from './src/lib/profile';
import OnboardingScreen from './src/screens/Onboarding';
import ErrorBoundary from './src/ErrorBoundary';

// Direct sub-path imports avoid the package's barrel index.js which
// re-exports every weight (some of which Metro fails to resolve).
import Geist_400Regular from '@expo-google-fonts/geist/400Regular/Geist_400Regular.ttf';
import Geist_500Medium from '@expo-google-fonts/geist/500Medium/Geist_500Medium.ttf';
import Geist_600SemiBold from '@expo-google-fonts/geist/600SemiBold/Geist_600SemiBold.ttf';
import SpaceGrotesk_500Medium from '@expo-google-fonts/space-grotesk/500Medium/SpaceGrotesk_500Medium.ttf';
import SpaceGrotesk_600SemiBold from '@expo-google-fonts/space-grotesk/600SemiBold/SpaceGrotesk_600SemiBold.ttf';
import JetBrainsMono_400Regular from '@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf';
import JetBrainsMono_500Medium from '@expo-google-fonts/jetbrains-mono/500Medium/JetBrainsMono_500Medium.ttf';
import JetBrainsMono_600SemiBold from '@expo-google-fonts/jetbrains-mono/600SemiBold/JetBrainsMono_600SemiBold.ttf';
import PlayfairDisplay_600SemiBold from '@expo-google-fonts/playfair-display/600SemiBold/PlayfairDisplay_600SemiBold.ttf';
import PlayfairDisplay_600SemiBold_Italic from '@expo-google-fonts/playfair-display/600SemiBold_Italic/PlayfairDisplay_600SemiBold_Italic.ttf';

import HomeScreen from './src/screens/Home';
import AppDetailScreen from './src/screens/AppDetail';
import SettingsScreen from './src/screens/Settings';
import ApprovalsScreen from './src/screens/Approvals';
import MobileFallbackScreen from './src/screens/MobileFallback';
import PhotosHome from './src/apps/photos/PhotosHome';
import PhotoLightbox from './src/apps/photos/PhotoLightbox';
import PhotosLibrary from './src/apps/photos/PhotosLibrary';
import PhotosSearch from './src/apps/photos/PhotosSearch';
import BackupHealth from './src/apps/photos/BackupHealth';
import PlacesMap from './src/apps/photos/PlacesMap';
import FaceReview from './src/apps/photos/FaceReview';
import DuplicateReview from './src/apps/photos/DuplicateReview';
import AlbumDetail from './src/apps/photos/AlbumDetail';
import PhotoStateView from './src/apps/photos/PhotoStateView';
import DocsHome from './src/apps/docs/DocsHome';
import DocumentViewer from './src/apps/docs/DocumentViewer';
import AgendaHome from './src/apps/agenda/AgendaHome';
import AgendaEvent from './src/apps/agenda/AgendaEvent';
import type {
  AgendaStackParamList,
  AppsStackParamList,
  DocsStackParamList,
  PhotosStackParamList,
  RootStackParamList,
  SettingsStackParamList,
  TabParamList,
} from './src/navigation';

// Keep the native splash up until fonts have loaded — avoids a flash of
// system-font text on first render.
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
const Tab = createBottomTabNavigator<TabParamList>();
const PhotosStack = createNativeStackNavigator<PhotosStackParamList>();
const DocsStack = createNativeStackNavigator<DocsStackParamList>();
const AgendaStack = createNativeStackNavigator<AgendaStackParamList>();
const AppsStack = createNativeStackNavigator<AppsStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();

function UploadReconciliation(): null {
  const { session } = useReplica();
  useUploadReconciliation(session);
  return null;
}

function PhotosNavigator(): React.JSX.Element {
  const { colors } = resolveTheme(useColorScheme());
  return (
    <PhotosStack.Navigator
      screenOptions={{ contentStyle: { backgroundColor: colors.bg }, headerShown: false }}
    >
      <PhotosStack.Screen name="PhotosHome" component={PhotosHome} />
      <PhotosStack.Screen
        name="PhotoLightbox"
        component={PhotoLightbox}
        options={{ animation: 'fade_from_bottom', gestureEnabled: false }}
      />
      <PhotosStack.Screen name="PhotosLibrary" component={PhotosLibrary} />
      <PhotosStack.Screen name="PhotosSearch" component={PhotosSearch} />
      <PhotosStack.Screen name="BackupHealth" component={BackupHealth} />
      <PhotosStack.Screen name="PlacesMap" component={PlacesMap} />
      <PhotosStack.Screen name="FaceReview" component={FaceReview} />
      <PhotosStack.Screen name="DuplicateReview" component={DuplicateReview} />
      <PhotosStack.Screen name="AlbumDetail" component={AlbumDetail} />
      <PhotosStack.Screen name="PhotoStateView" component={PhotoStateView} />
    </PhotosStack.Navigator>
  );
}

function DocsNavigator(): React.JSX.Element {
  const { colors } = resolveTheme(useColorScheme());
  return (
    <DocsStack.Navigator
      screenOptions={{ contentStyle: { backgroundColor: colors.bg }, headerShown: false }}
    >
      <DocsStack.Screen name="DocsHome" component={DocsHome} />
      <DocsStack.Screen name="DocumentViewer" component={DocumentViewer} />
    </DocsStack.Navigator>
  );
}

function AgendaNavigator(): React.JSX.Element {
  const { colors } = resolveTheme(useColorScheme());
  return (
    <AgendaStack.Navigator
      screenOptions={{ contentStyle: { backgroundColor: colors.bg }, headerShown: false }}
    >
      <AgendaStack.Screen name="AgendaHome" component={AgendaHome} />
      <AgendaStack.Screen name="AgendaEvent" component={AgendaEvent} />
    </AgendaStack.Navigator>
  );
}

function AppsNavigator(): React.JSX.Element {
  const { colors } = resolveTheme(useColorScheme());
  return (
    <AppsStack.Navigator
      screenOptions={{
        animation: 'slide_from_right',
        contentStyle: { backgroundColor: colors.bg },
        headerShown: false,
      }}
    >
      <AppsStack.Screen name="Home" component={HomeScreen} />
      <AppsStack.Screen name="AppDetail" component={AppDetailScreen} />
    </AppsStack.Navigator>
  );
}

function SettingsNavigator(): React.JSX.Element {
  const { colors } = resolveTheme(useColorScheme());
  return (
    <SettingsStack.Navigator
      screenOptions={{
        animation: 'slide_from_right',
        contentStyle: { backgroundColor: colors.bg },
        headerShown: false,
      }}
    >
      <SettingsStack.Screen name="Settings" component={SettingsScreen} />
      <SettingsStack.Screen name="Approvals" component={ApprovalsScreen} />
    </SettingsStack.Navigator>
  );
}

/** Surfaces ReplicaProvider.error when the session fails to open (issue #468 K2). */
function ReplicaErrorBanner(): React.JSX.Element | null {
  const { error, ready } = useReplica();
  const { colors } = resolveTheme(useColorScheme());
  if (!ready || !error) return null;
  return (
    <View
      style={{
        backgroundColor: colors.danger ?? '#c44',
        paddingHorizontal: 14,
        paddingVertical: 10,
      }}
    >
      <Text style={{ color: '#fff', fontFamily: 'Geist_500Medium', fontSize: 13 }}>{error}</Text>
    </View>
  );
}

function Tabs(): React.JSX.Element {
  return (
    <Tab.Navigator
      initialRouteName="Apps"
      screenListeners={{
        // `selection` haptic on tab switch — matches the bridge vocabulary
        // WebView apps get via expo-haptics (src/lib/bridge/dispatch.ts).
        tabPress: () => {
          void Haptics.selectionAsync();
        },
      }}
      screenOptions={{
        headerShown: false,
        // The Centraid Mobile design is a launcher model: Home and each app
        // screen carry their own bottom bar, so the OS tab bar is hidden and
        // the tab navigator is used purely as a route container.
        tabBarStyle: { display: 'none' },
      }}
    >
      <Tab.Screen
        name="Apps"
        component={AppsNavigator}
        options={{
          tabBarLabel: 'Home',
          tabBarIcon: ({ color, size }) => <Feather name="grid" size={size} color={color} />,
        }}
      />
      <Tab.Screen
        name="Photos"
        component={PhotosNavigator}
        options={{
          tabBarLabel: 'Photos',
          tabBarIcon: ({ color, size }) => <Feather name="image" size={size} color={color} />,
        }}
      />
      <Tab.Screen
        name="Docs"
        component={DocsNavigator}
        options={{
          tabBarIcon: ({ color, size }) => <Feather name="folder" size={size} color={color} />,
        }}
      />
      <Tab.Screen
        name="Agenda"
        component={AgendaNavigator}
        options={{
          tabBarIcon: ({ color, size }) => <Feather name="calendar" size={size} color={color} />,
        }}
      />
      <Tab.Screen
        name="SettingsTab"
        component={SettingsNavigator}
        options={{
          tabBarLabel: 'Settings',
          tabBarIcon: ({ color, size }) => <Feather name="settings" size={size} color={color} />,
        }}
      />
    </Tab.Navigator>
  );
}

export default function App(): React.JSX.Element | null {
  const scheme = useColorScheme();
  const { colors } = resolveTheme(scheme);
  // `null` while the profile prefs hydrate; then true/false gates onboarding.
  const [onboarded, setOnboarded] = React.useState<boolean | null>(null);
  const [fontsLoaded, fontError] = useFonts({
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_600SemiBold,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    PlayfairDisplay_600SemiBold,
    PlayfairDisplay_600SemiBold_Italic,
  });

  useEffect(() => {
    void hydrateProfile().then(() => setOnboarded(isOnboarded()));
  }, []);

  const onReady = useCallback(async () => {
    if ((fontsLoaded || fontError) && onboarded !== null) {
      await SplashScreen.hideAsync().catch(() => {
        /* noop */
      });
    }
  }, [fontsLoaded, fontError, onboarded]);

  useEffect(() => {
    void onReady();
  }, [onReady]);

  if ((!fontsLoaded && !fontError) || onboarded === null) {
    return null;
  }

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <View style={{ backgroundColor: colors.bg, flex: 1 }} onLayout={onReady}>
            <ShareIntentProvider options={{ scheme: 'centraid', resetOnBackground: false }}>
              <ReplicaProvider>
                <UploadReconciliation />
                <ShareIntentIngest />
                {/* The replica error banner is only meaningful inside the app
                    shell — during onboarding the user hasn't paired yet, so a
                    "couldn't open replica" banner would just be noise. */}
                {onboarded ? <ReplicaErrorBanner /> : null}
                {onboarded ? (
                  <NavigationContainer theme={navThemeFor(scheme)}>
                    <StatusBar style="auto" />
                    <RootStack.Navigator screenOptions={{ headerShown: false }}>
                      <RootStack.Screen name="Tabs" component={Tabs} />
                      <RootStack.Screen
                        name="MobileFallback"
                        component={MobileFallbackScreen}
                        options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
                      />
                    </RootStack.Navigator>
                  </NavigationContainer>
                ) : (
                  <>
                    <StatusBar style="light" />
                    <OnboardingScreen onDone={() => setOnboarded(true)} />
                  </>
                )}
              </ReplicaProvider>
            </ShareIntentProvider>
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
