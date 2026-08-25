// Single source of truth for the navigation tree + route params.
//
// One root native stack (springboard model). Some route ids are STABLE aliases
// whose screens have since been renamed: `Insights` is Activity, `Data` is
// Vault, `Devices` is Copies.
//
// There is NO bottom-tab navigator: apps are full-screen covers over Home,
// dismissed by the native swipe-down. Nested-stack screens take their props
// from the helpers below, composed with the root stack via
// `CompositeScreenProps` so `navigate` still typechecks when it crosses to a
// sibling cover or back to Home.

import type {
  CompositeNavigationProp,
  CompositeScreenProps,
  NavigatorScreenParams,
} from "@react-navigation/native";
import { createNavigationContainerRef } from "@react-navigation/native";
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from "@react-navigation/native-stack";

export type PhotosStackParamList = {
  // `destination` names which band shelf to land on: all of them live on this
  // one screen, so a band tap from a pushed route navigates here rather than
  // pushing a second copy. `more` never reaches it — More is a sheet.
  //
  // Longhand, not `Exclude<BandDestinationKey, "more">`: the frame may not
  // import an app (`scripts/check-import-boundaries.ts`). What pins the two
  // together is `PhotosScreen.tsx`'s band handler, where a destination added to
  // the band and forgotten here fails to typecheck.
  PhotosHome:
    | { destination?: "library" | "collections" | "search" }
    | undefined;
  PhotoLightbox: { assetId: string };
  PhotosLibrary: undefined;
  PhotosSearch: undefined;
  // Cards first (proto:4197): the More row lands on `PlacesView`, the shelf
  // head opens `PlacesMap`, and a card opens `PlaceDetail` — filtered locally,
  // because `PhotoStateView` has no "place" mode and is not this to grow.
  PlacesView: undefined;
  PlacesMap: undefined;
  PlaceDetail: { placeKey: string; placeName: string };
  FaceReview: undefined;
  // People is OFF the band, so this is a pushed route (#712). Distinct from
  // `FaceReview`: this browses CONFIRMED identities, that triages proposed.
  PhotosPeople: undefined;
  // Duplicates is TWO surfaces, per the v4 prototype: the shelf lists clusters
  // (proto:4436), the review works one at a time (proto:4291).
  DuplicatesShelf: undefined;
  DuplicateReview: undefined;
  // On this day, Trips and Similar moments, off `media.memory` (#724).
  PhotosMemories: undefined;
  AlbumDetail: { albumId: string };
  // The picker's picked set is its own, so the album it commits to is a route
  // param rather than shared state (§10).
  PhotoPicker: { albumId: string };
  // There is deliberately NO `PhotoPermission` route (#712): the OS grant is a
  // designed STATE of the timeline, rendered in the grid's own slot
  // (`PhotoAccessPanel.tsx`). A route would be a second way to the same words.
  //
  // `person` carries the name as well as the party because the view has no
  // other route to a display name. `archive` has no client affordance that
  // sets it, but `PhotosLibrary.tsx` still reads it — do not delete blind.
  PhotoStateView:
    | { mode: "favorites" | "archive" | "trash" | "videos" }
    | { mode: "person"; partyId: string; personName: string };
};

export type DocsStackParamList = {
  // Same shape and reasoning as `PhotosHome.destination`, longhand for the same
  // import-boundary reason; `DocsScreen.tsx`'s band handler pins the two.
  DocsHome: { destination?: "all" | "folders" | "due" | "search" } | undefined;
  // The name rides along so the app bar need not wait a replica round-trip.
  DocsFolder: { folderId: string; folderName: string };
  // ONE route for the read surface: reading view for kinds Docs can set, facts
  // panel for kinds it cannot. The fork is a fact about the document.
  DocumentRead: { documentId: string };
  DocumentViewer: { documentId: string };
  DocumentEditor: { documentId: string };
  DocumentVersions: { documentId: string };
  DocumentProperties: { documentId: string };
  // The consent surface and the two screens its capabilities produce.
  DocsCapabilities: undefined;
  DocsProposedFiling: undefined;
  DocumentNames: { documentId: string };
  DocsAdd: undefined;
  DocsUpload: undefined;
  DocsScan: undefined;
  // The More sheet's shelves.
  DocsRecent: undefined;
  DocsStarred: undefined;
  DocsTrash: undefined;
  DocsStorage: undefined;
};

export type PeopleStackParamList = {
  // Same shape and reasoning as `DocsHome.destination` above.
  PeopleHome: { destination?: "people" | "touch" | "search" } | undefined;
  Person: { personId: string };
  PersonLog: { personId: string };
  // One editor for edit and new: no `personId` means a new person.
  PersonEditor: { personId?: string } | undefined;
  PersonMerge: { personId: string };
  PeopleTrash: undefined;
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
  Sharing: undefined;
  PhoneStorage: { signalCause?: string } | undefined;
  // A FRAME screen, never the Photos stack (#712): the policy it edits governs
  // Docs' scans and Notes' attachments too. Photos deep-links across to it.
  BackupHealth: { signalCause?: string } | undefined;
};

export type RootStackParamList = {
  Home: undefined;
  Capture: { text?: string } | undefined;
  Scan:
    | {
        fileUri?: string;
        fileName?: string;
        mediaType?: string;
        plaintextSize?: number;
        deleteSourceAfterSettle?: boolean;
      }
    | undefined;
  Photos: NavigatorScreenParams<PhotosStackParamList>;
  Docs: NavigatorScreenParams<DocsStackParamList>;
  Agenda: NavigatorScreenParams<AgendaStackParamList>;
  Locker: undefined;
  Tasks: undefined;
  People: NavigatorScreenParams<PeopleStackParamList>;
  Notes: undefined;
  Tally: undefined;
  Assistant: undefined;
  AssistantFull: undefined;
  SystemOnPhone: undefined;
  SignalNotification: { cause: string; detail: "phone" | "backup" };
  Automations: { automationRef?: string } | undefined;
  Insights: { initialTab?: "overview" | "alerts" } | undefined;
  // ROOT covers, never members of `SettingsStackParamList` (#765): a place is
  // not a setting, and the Settings stack is not composed with the root stack,
  // so a screen inside it cannot navigate to a sibling cover.
  Connectors: undefined;
  // `kind` names which store's records to open on — same shape as
  // `PhotosHome.destination`.
  Data: { kind?: string } | undefined;
  Devices: undefined;
  Settings: NavigatorScreenParams<SettingsStackParamList>;
};

export const rootNavigationRef =
  createNavigationContainerRef<RootStackParamList>();

export type RootScreenProps<T extends keyof RootStackParamList> =
  NativeStackScreenProps<RootStackParamList, T>;

// Root-level screens (no nested stack of their own).
export type HomeScreenProps = RootScreenProps<"Home">;
export type CaptureScreenProps = RootScreenProps<"Capture">;
export type ScanScreenProps = RootScreenProps<"Scan">;
export type LockerScreenProps = RootScreenProps<"Locker">;
export type TasksScreenProps = RootScreenProps<"Tasks">;
export type NotesScreenProps = RootScreenProps<"Notes">;
export type TallyScreenProps = RootScreenProps<"Tally">;
export type AssistantScreenProps = RootScreenProps<"Assistant">;
export type AssistantFullScreenProps = RootScreenProps<"AssistantFull">;
export type SystemOnPhoneScreenProps = RootScreenProps<"SystemOnPhone">;
export type SignalNotificationScreenProps =
  RootScreenProps<"SignalNotification">;
export type AutomationsScreenProps = RootScreenProps<"Automations">;
export type InsightsScreenProps = RootScreenProps<"Insights">;
export type ConnectorsScreenProps = RootScreenProps<"Connectors">;
export type DataScreenProps = RootScreenProps<"Data">;
export type DevicesScreenProps = RootScreenProps<"Devices">;

// Shared outer context for any nested-stack screen: the root stack, so a screen
// deep inside a cover can still navigate to a sibling cover or back to Home.
type Root = RootScreenProps<keyof RootStackParamList>;

export type PhotosScreenProps<T extends keyof PhotosStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<PhotosStackParamList, T>, Root>;

/** Read through `useNavigation()`, never taken as a prop, so the shell can wrap
 *  ANY Photos screen without each one widening its own navigation type to the
 *  union of every route it never navigates to. */
export type PhotosShellNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<PhotosStackParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

export type AgendaScreenProps<T extends keyof AgendaStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<AgendaStackParamList, T>, Root>;

export type DocsScreenProps<T extends keyof DocsStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<DocsStackParamList, T>, Root>;

/** See `PhotosShellNavigation`. */
export type DocsShellNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<DocsStackParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

export type PeopleScreenProps<T extends keyof PeopleStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<PeopleStackParamList, T>, Root>;

/** See `PhotosShellNavigation`. */
export type PeopleShellNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<PeopleStackParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

// NOT composed with the root stack, deliberately: the root route presenting
// this cover is itself named `Settings`, so intersecting the param lists
// collapses the inner `Settings` screen's params to `never`. These screens
// dismiss via `navigation.getParent()?.goBack()` instead.
export type SettingsScreenProps<T extends keyof SettingsStackParamList> =
  NativeStackScreenProps<SettingsStackParamList, T>;

declare global {
  // Makes `useNavigation()` infer the right list everywhere.
  // oxlint-disable-next-line @typescript-eslint/no-namespace -- grandfathered pre-existing suppression (#247)
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
