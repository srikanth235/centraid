// The nested app-stack navigators, split out of `App.tsx` for the same reason
// `lazy-screens.tsx` was (#765, extended by #821): the composition root crossed
// the repo's 625-line ceiling once Docs and People became stacks again, and
// this block has a single job — wire each cover's screens into its stack — with
// no coupling to boot, providers, or the root navigator. It lives beside
// `App.tsx`, not under `src/`, because it names screens from every app and only
// the composition root may do that (`scripts/check-import-boundaries.ts`).

import { createNativeStackNavigator } from "@react-navigation/native-stack";
import React from "react";

import {
  AgendaEvent,
  AgendaHome,
  ApprovalsScreen,
  BackupHealthScreen,
  DocsHome,
  DocsFolder,
  DocumentRead,
  DocumentViewer,
  DocumentEditor,
  DocumentVersions,
  DocumentProperties,
  DocsCapabilities,
  DocsProposedFiling,
  DocumentNames,
  DocsAdd,
  DocsUpload,
  DocsScan,
  DocsRecent,
  DocsStarred,
  DocsTrash,
  DocsStorage,
  PeopleHome,
  PersonView,
  PersonLog,
  PersonEditor,
  PersonLink,
  PersonMerge,
  PeopleTrash,
  AlbumDetail,
  DuplicateReview,
  DuplicatesShelf,
  FaceReview,
  MemoriesView,
  PhotosPeopleView,
  PhotoPicker,
  PhotoLightbox,
  PhotosHome,
  PhotosLibrary,
  PhotosSearch,
  PhotoStateView,
  PlacesMap,
  PlacesView,
  PlaceDetail,
  PhoneStorageScreen,
  SettingsScreen,
  SharingScreen,
} from "./lazy-screens";
import { useTheme } from "./src/kit/theme";
import type {
  AgendaStackParamList,
  DocsStackParamList,
  PeopleStackParamList,
  PhotosStackParamList,
  SettingsStackParamList,
} from "./src/navigation";

const PhotosStack = createNativeStackNavigator<PhotosStackParamList>();
const DocsStack = createNativeStackNavigator<DocsStackParamList>();
const PeopleStack = createNativeStackNavigator<PeopleStackParamList>();
const AgendaStack = createNativeStackNavigator<AgendaStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();

export function PhotosNavigator(): React.JSX.Element {
  const { colors } = useTheme();
  return (
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
      <PhotosStack.Screen name="DuplicatesShelf" component={DuplicatesShelf} />
      <PhotosStack.Screen name="DuplicateReview" component={DuplicateReview} />
      <PhotosStack.Screen name="PhotosMemories" component={MemoriesView} />
      <PhotosStack.Screen name="AlbumDetail" component={AlbumDetail} />
      <PhotosStack.Screen name="PhotoPicker" component={PhotoPicker} />
      <PhotosStack.Screen name="PhotoStateView" component={PhotoStateView} />
    </PhotosStack.Navigator>
  );
}

export function DocsNavigator(): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <DocsStack.Navigator
      screenOptions={{
        contentStyle: { backgroundColor: colors.bg },
        headerShown: false,
      }}
    >
      <DocsStack.Screen name="DocsHome" component={DocsHome} />
      <DocsStack.Screen name="DocsFolder" component={DocsFolder} />
      <DocsStack.Screen name="DocumentRead" component={DocumentRead} />
      <DocsStack.Screen
        name="DocumentViewer"
        component={DocumentViewer}
        options={{ animation: "fade_from_bottom", gestureEnabled: false }}
      />
      <DocsStack.Screen name="DocumentEditor" component={DocumentEditor} />
      <DocsStack.Screen name="DocumentVersions" component={DocumentVersions} />
      <DocsStack.Screen
        name="DocumentProperties"
        component={DocumentProperties}
      />
      <DocsStack.Screen name="DocsCapabilities" component={DocsCapabilities} />
      <DocsStack.Screen
        name="DocsProposedFiling"
        component={DocsProposedFiling}
      />
      <DocsStack.Screen name="DocumentNames" component={DocumentNames} />
      <DocsStack.Screen name="DocsAdd" component={DocsAdd} />
      <DocsStack.Screen name="DocsUpload" component={DocsUpload} />
      <DocsStack.Screen name="DocsScan" component={DocsScan} />
      <DocsStack.Screen name="DocsRecent" component={DocsRecent} />
      <DocsStack.Screen name="DocsStarred" component={DocsStarred} />
      <DocsStack.Screen name="DocsTrash" component={DocsTrash} />
      <DocsStack.Screen name="DocsStorage" component={DocsStorage} />
    </DocsStack.Navigator>
  );
}

export function PeopleNavigator(): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <PeopleStack.Navigator
      screenOptions={{
        contentStyle: { backgroundColor: colors.bg },
        headerShown: false,
      }}
    >
      <PeopleStack.Screen name="PeopleHome" component={PeopleHome} />
      <PeopleStack.Screen name="Person" component={PersonView} />
      <PeopleStack.Screen name="PersonLog" component={PersonLog} />
      <PeopleStack.Screen name="PersonEditor" component={PersonEditor} />
      <PeopleStack.Screen name="PersonLink" component={PersonLink} />
      <PeopleStack.Screen name="PersonMerge" component={PersonMerge} />
      <PeopleStack.Screen name="PeopleTrash" component={PeopleTrash} />
    </PeopleStack.Navigator>
  );
}

export function AgendaNavigator(): React.JSX.Element {
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

export function SettingsNavigator(): React.JSX.Element {
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
