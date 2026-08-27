// Navigation tree + route params. One root native stack; no bottom tabs — apps are covers over Home.
// Stable aliases: `Insights` is Activity, `Data` is Vault, `Devices` is Copies.
// Nested screens use `CompositeScreenProps` so `navigate` typechecks across sibling covers.

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

import type { LockerItemType } from "@centraid/blueprints/apps/locker/types";

export type PhotosStackParamList = {
  // Band shelf on this screen (do not push a second copy). `more` is a sheet, never a destination.
  // Longhand, not `Exclude<BandDestinationKey, "more">`: the frame may not import an app
  // (`scripts/check-import-boundaries.ts`). `PhotosScreen.tsx` band handler pins the two.
  PhotosHome:
    | { destination?: "library" | "collections" | "search" }
    | undefined;
  PhotoLightbox: { assetId: string };
  PhotosLibrary: undefined;
  PhotosSearch: undefined;
  // Cards first: More → `PlacesView`, shelf head → `PlacesMap`, card → `PlaceDetail`. Not a `PhotoStateView` mode.
  PlacesView: undefined;
  PlacesMap: undefined;
  PlaceDetail: { placeKey: string; placeName: string };
  FaceReview: undefined;
  // Off the band (#712). Confirmed identities; `FaceReview` triages proposed.
  PhotosPeople: undefined;
  // Two surfaces: shelf lists clusters; review works one cluster.
  DuplicatesShelf: undefined;
  DuplicateReview: undefined;
  // On this day / Trips / Similar — `media.memory` (#724).
  PhotosMemories: undefined;
  AlbumDetail: { albumId: string };
  // Picked set is the picker's own; album is a route param, not shared state (§10).
  PhotoPicker: { albumId: string };
  // No `PhotoPermission` route (#712): OS grant is a timeline STATE (`PhotoAccessPanel.tsx`).
  // `person` carries the display name (no other route). `archive` has no setter but `PhotosLibrary.tsx` still reads it — do not delete blind.
  PhotoStateView:
    | { mode: "favorites" | "archive" | "trash" | "videos" }
    | { mode: "person"; partyId: string; personName: string };
};

export type DocsStackParamList = {
  // Same longhand as `PhotosHome.destination` (import boundary); `DocsScreen.tsx` band handler pins the two.
  DocsHome: { destination?: "all" | "folders" | "due" | "search" } | undefined;
  // Name rides along so the app bar need not wait a replica round-trip.
  DocsFolder: { folderId: string; folderName: string };
  // One read route: reading view for kinds Docs can set, facts panel for kinds it cannot.
  DocumentRead: { documentId: string };
  DocumentViewer: { documentId: string };
  DocumentEditor: { documentId: string };
  DocumentVersions: { documentId: string };
  DocumentProperties: { documentId: string };
  DocsCapabilities: undefined;
  DocsProposedFiling: undefined;
  DocumentNames: { documentId: string };
  DocsAdd: undefined;
  DocsUpload: undefined;
  DocsScan: undefined;
  DocsRecent: undefined;
  DocsStarred: undefined;
  DocsTrash: undefined;
  DocsStorage: undefined;
};

export type LockerStackParamList = {
  // The four band PLACES live on this one route; Item, Add/edit, Trash, Access
  // history and the three elsewhere-surfaces are pushed, because each is a
  // subject with a back row rather than a place. Longhand, not
  // `Exclude<LockerBandDestinationKey, "more">`: the frame may not import an
  // app (`scripts/check-import-boundaries.ts`); `LockerScreen.tsx`'s band
  // handler pins the two.
  LockerHome:
    | { destination?: "items" | "watch" | "gen" | "search" }
    | undefined;
  // Title and type ride along so the app bar and the permit gate need no
  // replica round-trip — and so the gate can name the field this TYPE seals
  // before any read has happened. Never restate the union here: an unfamiliar
  // type must still reach the item screen, which degrades it.
  LockerItem: {
    itemId: string;
    title: string;
    type: LockerItemType;
  };
  // No `itemId` means a new item. `generated` seeds the password field from
  // the generator's "Put it on an item".
  LockerEdit: { itemId?: string; generated?: string } | undefined;
  LockerAccess: undefined;
  LockerTrash: undefined;
  // The surfaces whose door is on another seat, one screen, one param.
  LockerSurface: { surface: "import" | "export" | "fill" };
};

export type TallyStackParamList = {
  // The four band PLACES live on this one route; every other surface is
  // pushed, because each is a subject with a back row rather than a place.
  // Longhand, not `Exclude<TallyBandDestinationKey, "more">`: the frame may not
  // import an app (`scripts/check-import-boundaries.ts`); `TallyScreen.tsx`'s
  // band handler pins the two.
  TallyHome:
    | { destination?: "balances" | "activity" | "groups" | "contrib" }
    | undefined;
  // The group's name rides along so the app bar needs no round trip before the
  // ledger lands, and so a slow read never paints under the previous group.
  TallyGroup: { groupId: string; name: string };
  TallyFriend: { partyId: string; name: string };
  // The id alone: the entry itself is already in whichever ledger payload the
  // member tapped it out of, and re-reading it would be a second copy.
  TallyExpense: { expenseId: string };
  // No `expenseId` means a new expense; `groupId` seeds the group chip, and
  // its absence is the group-less 1:1 case rather than a missing value.
  TallyAdd: { groupId?: string; expenseId?: string } | undefined;
  TallyReceipt: { expenseId: string };
  TallySettle: { groupId?: string; partyId?: string } | undefined;
  TallyRecurring: undefined;
  TallySpending: undefined;
  TallyTrash: undefined;
  TallySearch: undefined;
  // The surface whose door is on another seat, one screen, one param.
  TallySurface: { surface: "export"; groupId?: string };
};

export type PeopleStackParamList = {
  // Same longhand as `DocsHome.destination`.
  PeopleHome: { destination?: "people" | "touch" | "search" } | undefined;
  Person: { personId: string };
  PersonLog: { personId: string };
  // No `personId` means new person.
  PersonEditor: { personId?: string } | undefined;
  PersonMerge: { personId: string };
  PeopleTrash: undefined;
};

export type AgendaStackParamList = {
  AgendaHome: undefined;
  // `instanceKey` is the tapped occurrence; writes still target the series via `eventId`.
  AgendaEvent: { eventId: string; instanceKey?: string };
};

export type SettingsStackParamList = {
  Settings: undefined;
  Approvals: undefined;
  Sharing: undefined;
  PhoneStorage: { signalCause?: string } | undefined;
  // Frame screen, never Photos stack (#712): policy also covers Docs scans and Notes attachments.
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
  Locker: NavigatorScreenParams<LockerStackParamList>;
  Tasks: undefined;
  People: NavigatorScreenParams<PeopleStackParamList>;
  Notes: undefined;
  Tally: NavigatorScreenParams<TallyStackParamList>;
  Assistant: undefined;
  AssistantFull: undefined;
  SystemOnPhone: undefined;
  SignalNotification: { cause: string; detail: "phone" | "backup" };
  Automations: { automationRef?: string } | undefined;
  Insights: { initialTab?: "overview" | "alerts" } | undefined;
  // Root covers, never `SettingsStackParamList` (#765): Settings is not composed with the root stack.
  Connectors: undefined;
  Data: { kind?: string } | undefined;
  Devices: undefined;
  Settings: NavigatorScreenParams<SettingsStackParamList>;
};

export const rootNavigationRef =
  createNavigationContainerRef<RootStackParamList>();

export type RootScreenProps<T extends keyof RootStackParamList> =
  NativeStackScreenProps<RootStackParamList, T>;

export type HomeScreenProps = RootScreenProps<"Home">;
export type CaptureScreenProps = RootScreenProps<"Capture">;
export type ScanScreenProps = RootScreenProps<"Scan">;
export type TasksScreenProps = RootScreenProps<"Tasks">;
export type NotesScreenProps = RootScreenProps<"Notes">;
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

type Root = RootScreenProps<keyof RootStackParamList>;

export type PhotosScreenProps<T extends keyof PhotosStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<PhotosStackParamList, T>, Root>;

/** Via `useNavigation()`, never a prop — so the shell can wrap any Photos screen without widening each screen's type. */
export type PhotosShellNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<PhotosStackParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

export type AgendaScreenProps<T extends keyof AgendaStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<AgendaStackParamList, T>, Root>;

export type DocsScreenProps<T extends keyof DocsStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<DocsStackParamList, T>, Root>;

export type DocsShellNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<DocsStackParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

export type LockerScreenProps<T extends keyof LockerStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<LockerStackParamList, T>, Root>;

/** Via `useNavigation()`, never a prop — so `LockerScreen.tsx` can wrap any
 *  Locker surface without widening each screen's type. */
export type LockerShellNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<LockerStackParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

export type TallyScreenProps<T extends keyof TallyStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<TallyStackParamList, T>, Root>;

/** Via `useNavigation()`, never a prop — so `TallyScreen.tsx` can wrap any
 *  Tally surface without widening each screen's type. */
export type TallyShellNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<TallyStackParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

export type PeopleScreenProps<T extends keyof PeopleStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<PeopleStackParamList, T>, Root>;

export type PeopleShellNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<PeopleStackParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

// Not composed with the root stack: intersecting param lists collapses inner `Settings` to `never`.
// Dismiss via `navigation.getParent()?.goBack()`.
export type SettingsScreenProps<T extends keyof SettingsStackParamList> =
  NativeStackScreenProps<SettingsStackParamList, T>;

declare global {
  // oxlint-disable-next-line @typescript-eslint/no-namespace -- grandfathered pre-existing suppression (#247)
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
