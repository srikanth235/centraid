// The nested app-stack navigators: each cover's screens wired into its stack.
//
// It lives beside `App.tsx`, not under `src/`, because it names screens from
// every app and only the composition root may do that
// (`scripts/check-import-boundaries.ts`).

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
  DocsTrash,
  DocsStorage,
  LockerHome,
  LockerItem,
  LockerEdit,
  LockerAccess,
  LockerTrash,
  LockerSurface,
  PeopleHome,
  PersonView,
  PersonLog,
  PersonEditor,
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
  TallyHome,
  TallyGroup,
  TallyFriend,
  TallyExpense,
  TallyAdd,
  TallyReceipt,
  TallySettle,
  TallyRecurring,
  TallySpending,
  TallyTrash,
  TallySearch,
  TallySurface,
} from "./lazy-screens";
import { useTheme } from "./src/kit/theme";
import type {
  AgendaStackParamList,
  DocsStackParamList,
  LockerStackParamList,
  PeopleStackParamList,
  PhotosStackParamList,
  SettingsStackParamList,
  TallyStackParamList,
} from "./src/navigation";

const PhotosStack = createNativeStackNavigator<PhotosStackParamList>();
const DocsStack = createNativeStackNavigator<DocsStackParamList>();
const LockerStack = createNativeStackNavigator<LockerStackParamList>();
const PeopleStack = createNativeStackNavigator<PeopleStackParamList>();
const AgendaStack = createNativeStackNavigator<AgendaStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();
const TallyStack = createNativeStackNavigator<TallyStackParamList>();

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
      <DocsStack.Screen name="DocsTrash" component={DocsTrash} />
      <DocsStack.Screen name="DocsStorage" component={DocsStorage} />
    </DocsStack.Navigator>
  );
}

/**
 * Locker's own stack. Ten surfaces on the design's route table, six routes
 * here: the four band PLACES share `LockerHome` (a band tap swaps what is
 * drawn, never pushes), and the two gates are not routes at all — every
 * surface wraps `LockerScreen.tsx`, which withdraws the children and the band
 * while the vault is locked, at setup or denied.
 */
export function LockerNavigator(): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <LockerStack.Navigator
      screenOptions={{
        contentStyle: { backgroundColor: colors.bg },
        headerShown: false,
      }}
    >
      <LockerStack.Screen name="LockerHome" component={LockerHome} />
      <LockerStack.Screen name="LockerItem" component={LockerItem} />
      <LockerStack.Screen name="LockerEdit" component={LockerEdit} />
      <LockerStack.Screen name="LockerAccess" component={LockerAccess} />
      <LockerStack.Screen name="LockerTrash" component={LockerTrash} />
      <LockerStack.Screen name="LockerSurface" component={LockerSurface} />
    </LockerStack.Navigator>
  );
}

/**
 * Tally's own stack. Fifteen surfaces on the design's route table, twelve
 * routes here: the four band PLACES share `TallyHome` (a band tap swaps what is
 * drawn, never pushes), and the denied gate is not a route at all — every
 * surface wraps `TallyScreen.tsx`, which withdraws the children and the band
 * while the grant is gone.
 */
export function TallyNavigator(): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <TallyStack.Navigator
      screenOptions={{
        contentStyle: { backgroundColor: colors.bg },
        headerShown: false,
      }}
    >
      <TallyStack.Screen name="TallyHome" component={TallyHome} />
      <TallyStack.Screen name="TallyGroup" component={TallyGroup} />
      <TallyStack.Screen name="TallyFriend" component={TallyFriend} />
      <TallyStack.Screen name="TallyExpense" component={TallyExpense} />
      <TallyStack.Screen name="TallyAdd" component={TallyAdd} />
      <TallyStack.Screen name="TallyReceipt" component={TallyReceipt} />
      <TallyStack.Screen name="TallySettle" component={TallySettle} />
      <TallyStack.Screen name="TallyRecurring" component={TallyRecurring} />
      <TallyStack.Screen name="TallySpending" component={TallySpending} />
      <TallyStack.Screen name="TallyTrash" component={TallyTrash} />
      <TallyStack.Screen name="TallySearch" component={TallySearch} />
      <TallyStack.Screen name="TallySurface" component={TallySurface} />
    </TallyStack.Navigator>
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
      <SettingsStack.Screen name="SettingsHome" component={SettingsScreen} />
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
