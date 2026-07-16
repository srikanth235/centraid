// Single source of truth for the navigation tree + route params.
//
//   RootStack (native stack)
//   ├─ Tabs (bottom tabs)
//   │  ├─ Photos    → PhotosStack  (PhotosHome)
//   │  ├─ Apps      → AppsStack    (Home, AppDetail)
//   │  └─ SettingsTab → SettingsStack (Settings, Approvals)
//   └─ MobileFallback (root-level modal, over the tabs)
//
// Each screen imports its own typed props off the helpers below. Screens
// inside a tab use `CompositeScreenProps` so `navigation.navigate` still
// type-checks when they cross into a sibling tab (e.g. Home → Approvals) or
// up to the root modal (Home → MobileFallback).

import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type PhotosStackParamList = {
  PhotosHome: undefined;
};

export type AppsStackParamList = {
  Home: undefined;
  AppDetail: { appId: string };
};

export type SettingsStackParamList = {
  Settings: undefined;
  Approvals: undefined;
};

export type TabParamList = {
  Photos: NavigatorScreenParams<PhotosStackParamList>;
  Apps: NavigatorScreenParams<AppsStackParamList>;
  SettingsTab: NavigatorScreenParams<SettingsStackParamList>;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList>;
  MobileFallback: undefined;
};

export type RootScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>;

// Shared outer context for any tab screen: the bottom-tab navigator plus the
// root stack (for the MobileFallback modal). Composed with each stack below.
type TabAndRoot = CompositeScreenProps<
  BottomTabScreenProps<TabParamList>,
  RootScreenProps<keyof RootStackParamList>
>;

export type PhotosScreenProps<T extends keyof PhotosStackParamList> = CompositeScreenProps<
  NativeStackScreenProps<PhotosStackParamList, T>,
  TabAndRoot
>;

export type AppsScreenProps<T extends keyof AppsStackParamList> = CompositeScreenProps<
  NativeStackScreenProps<AppsStackParamList, T>,
  TabAndRoot
>;

export type SettingsScreenProps<T extends keyof SettingsStackParamList> = CompositeScreenProps<
  NativeStackScreenProps<SettingsStackParamList, T>,
  TabAndRoot
>;

declare global {
  // Makes `useNavigation()` infer the right list everywhere.
  // eslint-disable-next-line @typescript-eslint/no-namespace -- grandfathered pre-existing suppression (#247)
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
