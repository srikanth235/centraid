// The lazily-evaluated screen registry for the root and nested navigators.
//
// Split out of `App.tsx` (#765): that file crossed the repo's 625-line ceiling
// once Connectors, Data and Devices got covers of their own, and this block is
// the one part of it with a single job and no coupling to the rest — every
// binding here is reached exclusively through a `component=` prop.
//
// It lives beside `App.tsx` rather than under `src/` on purpose. This file is
// part of the composition root: it names every app, and `scripts/check-import-
// boundaries.ts` forbids anything under `src/` from importing `src/apps/*`
// (platform/kit may not reach into an app, and no app may reach into another).
// Only the root is allowed to wire them together, so only the root can hold
// this list.

import React from "react";

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
export const AgendaEvent = lazyScreen(
  () => import("./src/apps/agenda/AgendaEvent")
);
export const AgendaHome = lazyScreen(
  () => import("./src/apps/agenda/AgendaHome")
);
export const AssistantFullScreen = lazyScreen(
  () => import("./src/apps/assistant/Assistant")
);
export const AssistantScreen = lazyScreen(
  () => import("./src/apps/assistant/AssistantCompanionSheet")
);
export const AutomationsScreen = lazyScreen(
  () => import("./src/apps/automations/Automations")
);
export const DocsHome = lazyScreen(() => import("./src/apps/docs/DocsHome"));
export const DocumentViewer = lazyScreen(
  () => import("./src/apps/docs/DocumentViewer")
);
export const InsightsScreen = lazyScreen(
  () => import("./src/apps/insights/Insights")
);
export const LockerHome = lazyScreen(
  () => import("./src/apps/locker/LockerHome")
);
export const NotesHome = lazyScreen(() => import("./src/apps/notes/NotesHome"));
export const PeopleHome = lazyScreen(
  () => import("./src/apps/people/PeopleHome")
);
export const AlbumDetail = lazyScreen(
  () => import("./src/apps/photos/AlbumDetail")
);
export const DuplicateReview = lazyScreen(
  () => import("./src/apps/photos/DuplicateReview")
);
export const DuplicatesShelf = lazyScreen(
  () => import("./src/apps/photos/DuplicatesShelf")
);
export const FaceReview = lazyScreen(
  () => import("./src/apps/photos/FaceReview")
);
export const MemoriesView = lazyScreen(
  () => import("./src/apps/photos/MemoriesView")
);
export const PhotosPeopleView = lazyScreen(
  () => import("./src/apps/photos/PhotosPeopleView")
);
export const PhotoPicker = lazyScreen(
  () => import("./src/apps/photos/PhotoPicker")
);
export const PhotoLightbox = lazyScreen(
  () => import("./src/apps/photos/PhotoLightbox")
);
export const PhotosHome = lazyScreen(
  () => import("./src/apps/photos/PhotosHome")
);
export const PhotosLibrary = lazyScreen(
  () => import("./src/apps/photos/PhotosLibrary")
);
export const PhotosSearch = lazyScreen(
  () => import("./src/apps/photos/PhotosSearch")
);
export const PhotoStateView = lazyScreen(
  () => import("./src/apps/photos/PhotoStateView")
);
export const PlacesMap = lazyScreen(
  () => import("./src/apps/photos/PlacesMap")
);
export const PlacesView = lazyScreen(
  () => import("./src/apps/photos/PlacesView")
);
export const PlaceDetail = lazyScreen(
  () => import("./src/apps/photos/PlaceDetail")
);
export const TallyHome = lazyScreen(() => import("./src/apps/tally/TallyHome"));
export const TasksHome = lazyScreen(() => import("./src/apps/tasks/TasksHome"));
export const AppDetailScreen = lazyScreen(
  () => import("./src/screens/AppDetail")
);
export const ApprovalsScreen = lazyScreen(
  () => import("./src/screens/Approvals")
);
// A FRAME screen since issue #712 B2 — it moved out of the Photos stack whole.
export const BackupHealthScreen = lazyScreen(
  () => import("./src/screens/BackupHealth")
);
export const CaptureScreen = lazyScreen(() => import("./src/screens/Capture"));
// The three places promoted to covers of their own (issue #765). Interim
// shells until the per-screen agents land — the ROUTE is what stage 2 owes,
// so that Home's Connectors/Data/Devices rows stop landing on Settings or on
// nothing at all.
export const ConnectorsScreen = lazyScreen(
  () => import("./src/screens/connectors/Connectors")
);
export const DataScreen = lazyScreen(() => import("./src/screens/data/Data"));
export const DevicesScreen = lazyScreen(
  () => import("./src/screens/devices/Devices")
);
export const PhoneStorageScreen = lazyScreen(
  () => import("./src/screens/PhoneStorage")
);
export const ScanScreen = lazyScreen(() => import("./src/screens/Scan"));
export const SignalNotificationScreen = lazyScreen(
  () => import("./src/screens/SignalNotification")
);
export const SettingsScreen = lazyScreen(
  () => import("./src/screens/Settings")
);
export const SharingScreen = lazyScreen(() => import("./src/screens/Sharing"));
export const SystemOnPhoneScreen = lazyScreen(
  () => import("./src/screens/SystemOnPhone")
);
