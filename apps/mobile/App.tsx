import React, { useCallback, useEffect } from 'react';
import { View, useColorScheme } from 'react-native';
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

function Tabs(): React.JSX.Element {
  const { colors } = resolveTheme(useColorScheme());
  return (
    <Tab.Navigator
      initialRouteName="Photos"
      screenListeners={{
        // `selection` haptic on tab switch — matches the bridge vocabulary
        // WebView apps get via expo-haptics (src/lib/bridge/dispatch.ts).
        tabPress: () => {
          void Haptics.selectionAsync();
        },
      }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.ink3,
        tabBarLabelStyle: { fontFamily: 'Geist_500Medium', fontSize: 11 },
        tabBarStyle: { backgroundColor: colors.bgElev, borderTopColor: colors.line },
      }}
    >
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
        name="Apps"
        component={AppsNavigator}
        options={{
          tabBarLabel: 'Apps',
          tabBarIcon: ({ color, size }) => <Feather name="grid" size={size} color={color} />,
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
  const [fontsLoaded, fontError] = useFonts({
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_600SemiBold,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
  });

  const onReady = useCallback(async () => {
    if (fontsLoaded || fontError) {
      await SplashScreen.hideAsync().catch(() => {
        /* noop */
      });
    }
  }, [fontsLoaded, fontError]);

  useEffect(() => {
    void onReady();
  }, [onReady]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <View style={{ backgroundColor: colors.bg, flex: 1 }} onLayout={onReady}>
          <ShareIntentProvider options={{ scheme: 'centraid', resetOnBackground: false }}>
            <ReplicaProvider>
              <UploadReconciliation />
              <ShareIntentIngest />
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
            </ReplicaProvider>
          </ShareIntentProvider>
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
