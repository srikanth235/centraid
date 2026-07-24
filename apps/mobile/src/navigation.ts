// Single source of truth for the navigation tree + route params.
//
//   RootStack (native stack, springboard model)
//   ├─ Home          → HomeScreen                      (launcher, root)
//   ├─ Photos        → PhotosStack  (timeline, lightbox, library/search/backup)
//   ├─ Docs          → DocsStack    (drive, viewer)
//   ├─ Agenda        → AgendaStack  (calendar, event)
//   ├─ AppDetail     → AppDetailScreen (remote-app WebView cover)
//   ├─ Assistant     → AssistantScreen (chat with the gateway assistant)
//   ├─ Automations   → AutomationsScreen (list + run the space's automations)
//   ├─ Insights      → InsightsScreen (gateway health + limited usage insights)
//   ├─ Settings      → SettingsStack (Settings, Approvals)
//   └─ MobileFallback (desktop-builder fallback modal)
//
// There is no bottom-tab navigator: the apps are full-screen covers that slide
// up over Home and dismiss with the native swipe-down gesture. Each nested-stack
// screen imports its own typed props off the helpers below, composed with the
// root stack via `CompositeScreenProps` so `navigation.navigate` still
// type-checks when it crosses up to a sibling cover (e.g. Docs → Approvals) or
// back to Home.

import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type PhotosStackParamList = {
  PhotosHome: undefined;
  PhotoLightbox: { assetId: string };
  PhotosLibrary: undefined;
  PhotosSearch: undefined;
  BackupHealth: undefined;
  PlacesMap: undefined;
  FaceReview: undefined;
  DuplicateReview: undefined;
  AlbumDetail: { albumId: string };
  PhotoStateView: { mode: 'favorites' | 'archive' | 'trash' };
};

export type DocsStackParamList = {
  DocsHome: { folderId?: string } | undefined;
  DocumentViewer: { documentId: string };
};

export type AgendaStackParamList = {
  AgendaHome: undefined;
  // `instanceKey` renders the tapped occurrence of a recurring series (its
  // date/time and reminder); writes still target the series via `eventId`.
  AgendaEvent: { eventId: string; instanceKey?: string };
};

export type SettingsStackParamList = {
  Settings: undefined;
  Approvals: undefined;
};

export type RootStackParamList = {
  Home: undefined;
  Photos: NavigatorScreenParams<PhotosStackParamList>;
  Docs: NavigatorScreenParams<DocsStackParamList>;
  Agenda: NavigatorScreenParams<AgendaStackParamList>;
  AppDetail: { appId: string };
  Assistant: undefined;
  Automations: undefined;
  Insights: undefined;
  Settings: NavigatorScreenParams<SettingsStackParamList>;
  MobileFallback: undefined;
};

export type RootScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>;

// Root-level screens (no nested stack of their own).
export type HomeScreenProps = RootScreenProps<'Home'>;
export type AppDetailScreenProps = RootScreenProps<'AppDetail'>;
export type AssistantScreenProps = RootScreenProps<'Assistant'>;
export type AutomationsScreenProps = RootScreenProps<'Automations'>;
export type InsightsScreenProps = RootScreenProps<'Insights'>;

// Shared outer context for any nested-stack screen: the root stack, so a screen
// deep inside a cover can still navigate to a sibling cover or back to Home.
type Root = RootScreenProps<keyof RootStackParamList>;

export type PhotosScreenProps<T extends keyof PhotosStackParamList> = CompositeScreenProps<
  NativeStackScreenProps<PhotosStackParamList, T>,
  Root
>;

export type DocsScreenProps<T extends keyof DocsStackParamList> = CompositeScreenProps<
  NativeStackScreenProps<DocsStackParamList, T>,
  Root
>;

export type AgendaScreenProps<T extends keyof AgendaStackParamList> = CompositeScreenProps<
  NativeStackScreenProps<AgendaStackParamList, T>,
  Root
>;

// The Settings cover's screens are intentionally NOT composed with the root
// stack: the root route that presents this cover is itself named `Settings`, so
// an intersection with the root param list would collapse the inner `Settings`
// screen's params to `never`. These screens never navigate out to a sibling
// cover — they move between Settings and Approvals and dismiss via
// `navigation.getParent()?.goBack()` — so the plain stack props are sufficient.
export type SettingsScreenProps<T extends keyof SettingsStackParamList> = NativeStackScreenProps<
  SettingsStackParamList,
  T
>;

declare global {
  // Makes `useNavigation()` infer the right list everywhere.
  // eslint-disable-next-line @typescript-eslint/no-namespace -- grandfathered pre-existing suppression (#247)
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
