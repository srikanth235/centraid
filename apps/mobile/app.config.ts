/**
 * Expo config — single-sources version + native build numbers (issue #468 J6).
 * Build numbers come from {@link nativeBuildNumber} so app.json hardcodes cannot drift.
 */
import type { ExpoConfig, ConfigContext } from 'expo/config';
import { nativeBuildNumber } from './src/version-core';

// Keep in lockstep with monorepo root / package.json workspaces (0.1.0).
const VERSION = '0.1.0';
const BUILD = nativeBuildNumber(VERSION);

export default function createExpoConfig({ config }: ConfigContext): ExpoConfig {
  return {
    ...config,
    name: 'Centraid',

    slug: 'centraid',
    version: VERSION,
    orientation: 'portrait',
    scheme: 'centraid',
    userInterfaceStyle: 'automatic',
    icon: '../../assets/icon.png',
    splash: {
      image: '../../assets/splash.png',
      backgroundColor: '#3EC8B4',
      resizeMode: 'contain',
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: 'dev.centraid.mobile',
      buildNumber: String(BUILD),
      infoPlist: {
        UIBackgroundModes: ['processing'],
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: false,
          NSAllowsLocalNetworking: true,
        },
      },
    },
    android: {
      package: 'dev.centraid.mobile',
      versionCode: BUILD,
      adaptiveIcon: {
        foregroundImage: '../../assets/adaptive-icon.png',
        backgroundColor: '#3EC8B4',
      },
    },
    runtimeVersion: {
      policy: 'appVersion',
    },
    updates: {
      checkAutomatically: 'ON_ERROR_RECOVERY',
      url: 'https://u.expo.dev/placeholder-centraid-mobile',
    },
    assetBundlePatterns: ['**/*'],
    plugins: [
      'expo-notifications',
      'expo-secure-store',
      'expo-updates',
      [
        'expo-build-properties',
        {
          ios: { deploymentTarget: '17.5' },
          android: {
            usesCleartextTraffic: false,
          },
        },
      ],
      [
        'expo-media-library',
        {
          photosPermission:
            'Centraid reads your library to show and back up the albums you choose.',
          savePhotosPermission: 'Centraid saves selected vault photos back to your library.',
          isAccessMediaLocationEnabled: true,
          granularPermissions: ['photo', 'video'],
        },
      ],
      [
        'expo-share-intent',
        {
          iosActivationRules: {
            NSExtensionActivationSupportsImageWithMaxCount: 100,
            NSExtensionActivationSupportsMovieWithMaxCount: 20,
            NSExtensionActivationSupportsFileWithMaxCount: 100,
          },
          androidIntentFilters: ['image/*', 'video/*', 'audio/*', 'application/pdf'],
        },
      ],
      [
        'expo-camera',
        {
          cameraPermission:
            'Centraid uses the camera to scan the pairing QR code shown on your desktop.',
        },
      ],
      'expo-video',
      'react-native-quick-crypto',
      './plugins/withCentraidUploadService.cjs',
    ],
    extra: {
      recurrencePolicy: 'bounded-local-expansion',
      // Expose for tests / tooling that cannot import version-core through Expo.
      nativeBuildNumber: BUILD,
    },
  };
}
