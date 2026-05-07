import React, { useCallback, useEffect } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import type { Theme as NavTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { colors } from '@centraid/design-tokens';

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
import MobileFallbackScreen from './src/screens/MobileFallback';
import type { RootStackParamList } from './src/navigation';

// Keep the native splash up until fonts have loaded — avoids a flash of
// system-font text on first render.
SplashScreen.preventAutoHideAsync().catch(() => {
  /* noop */
});

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme: NavTheme = {
  colors: {
    background: colors.bg,
    border: colors.line,
    card: colors.bgElev,
    notification: colors.accent,
    primary: colors.accent,
    text: colors.ink,
  },
  dark: false,
  fonts: {
    bold: { fontFamily: 'Geist_600SemiBold', fontWeight: '600' },
    heavy: { fontFamily: 'Geist_600SemiBold', fontWeight: '600' },
    medium: { fontFamily: 'Geist_500Medium', fontWeight: '500' },
    regular: { fontFamily: 'Geist_400Regular', fontWeight: '400' },
  },
};

export default function App(): React.JSX.Element | null {
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
    <SafeAreaProvider>
      <View style={{ backgroundColor: colors.bg, flex: 1 }} onLayout={onReady}>
        <NavigationContainer theme={navTheme}>
          <StatusBar style="dark" />
          <Stack.Navigator
            screenOptions={{
              animation: 'slide_from_right',
              contentStyle: { backgroundColor: colors.bg },
              headerShown: false,
            }}
          >
            <Stack.Screen name="Home" component={HomeScreen} />
            <Stack.Screen name="AppDetail" component={AppDetailScreen} />
            <Stack.Screen
              name="MobileFallback"
              component={MobileFallbackScreen}
              options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </View>
    </SafeAreaProvider>
  );
}
