// The lazily-evaluated screen registry for the root and nested navigators.
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
 * what this buys is that `expo-camera`,
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
export const DocsFolder = lazyScreen(
  () => import("./src/apps/docs/FolderView")
);
export const DocumentRead = lazyScreen(
  () => import("./src/apps/docs/DocumentRead")
);
export const DocumentViewer = lazyScreen(
  () => import("./src/apps/docs/DocumentViewer")
);
export const DocumentEditor = lazyScreen(
  () => import("./src/apps/docs/DocumentEditor")
);
export const DocumentVersions = lazyScreen(
  () => import("./src/apps/docs/DocumentVersions")
);
export const DocumentProperties = lazyScreen(
  () => import("./src/apps/docs/DocumentProperties")
);
export const DocsCapabilities = lazyScreen(
  () => import("./src/apps/docs/DocsCapabilities")
);
export const DocsProposedFiling = lazyScreen(
  () => import("./src/apps/docs/ProposedFiling")
);
export const DocumentNames = lazyScreen(
  () => import("./src/apps/docs/DocumentNames")
);
export const DocsAdd = lazyScreen(() => import("./src/apps/docs/AddToDocs"));
export const DocsUpload = lazyScreen(
  () => import("./src/apps/docs/BulkUpload")
);
export const DocsScan = lazyScreen(() => import("./src/apps/docs/DocsScan"));
export const DocsRecent = lazyScreen(
  () => import("./src/apps/docs/RecentlyChanged")
);
export const DocsStarred = lazyScreen(
  () => import("./src/apps/docs/DocsStarred")
);
export const DocsTrash = lazyScreen(() => import("./src/apps/docs/DocsTrash"));
export const DocsStorage = lazyScreen(
  () => import("./src/apps/docs/DocsStorage")
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
export const PersonView = lazyScreen(
  () => import("./src/apps/people/PersonView")
);
export const PersonLog = lazyScreen(() => import("./src/apps/people/LogTouch"));
export const PersonEditor = lazyScreen(
  () => import("./src/apps/people/PersonEditor")
);
export const PersonMerge = lazyScreen(
  () => import("./src/apps/people/MergeView")
);
export const PeopleTrash = lazyScreen(
  () => import("./src/apps/people/PeopleTrash")
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
export const ApprovalsScreen = lazyScreen(
  () => import("./src/screens/Approvals")
);
export const BackupHealthScreen = lazyScreen(
  () => import("./src/screens/BackupHealth")
);
export const CaptureScreen = lazyScreen(() => import("./src/screens/Capture"));
// Interim shells for the three places that became covers of their own: the
// ROUTE is what these owe, so that Home's Connectors/Data/Devices rows stop
// landing on Settings or on nothing at all (#765).
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
