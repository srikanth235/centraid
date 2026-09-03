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
  PhotosHome:
    | { destination?: "library" | "collections" | "search" }
    | undefined;
  PhotoLightbox: { assetId: string };
  PhotosLibrary: undefined;
  PhotosSearch: undefined;
  PlacesView: undefined;
  PlacesMap: undefined;
  PlaceDetail: { placeKey: string; placeName: string };
  FaceReview: undefined;
  PhotosPeople: undefined;
  DuplicatesShelf: undefined;
  DuplicateReview: undefined;
  PhotosMemories: undefined;
  AlbumDetail: { albumId: string };
  PhotoPicker: { albumId: string };
  PhotoStateView:
    | { mode: "favorites" | "archive" | "trash" | "videos" }
    | { mode: "person"; partyId: string; personName: string };
};

export type DocsStackParamList = {
  DocsHome:
    | {
        destination?:
          | "all"
          | "folders"
          | "starred"
          | "shared"
          | "due"
          | "search";
      }
    | undefined;
  DocsFolder: { folderId: string; folderName: string };
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
  DocsTrash: undefined;
  DocsStorage: undefined;
};

export type LockerStackParamList = {
  LockerHome:
    | { destination?: "items" | "watch" | "gen" | "search" }
    | undefined;
  LockerItem: {
    itemId: string;
    title: string;
    type: LockerItemType;
  };
  LockerEdit: { itemId?: string; generated?: string } | undefined;
  LockerAccess: undefined;
  LockerTrash: undefined;
  LockerSurface: { surface: "import" | "export" | "fill" };
};

export type TallyStackParamList = {
  TallyHome:
    | { destination?: "balances" | "activity" | "groups" | "contrib" }
    | undefined;
  TallyGroup: { groupId: string; name: string };
  TallyFriend: { partyId: string; name: string };
  TallyExpense: { expenseId: string };
  TallyAdd: { groupId?: string; expenseId?: string } | undefined;
  TallyReceipt: { expenseId: string };
  TallySettle: { groupId?: string; partyId?: string } | undefined;
  TallyRecurring: undefined;
  TallySpending: undefined;
  TallyTrash: undefined;
  TallySearch: undefined;
  TallySurface: { surface: "export"; groupId?: string };
};

export type PeopleStackParamList = {
  PeopleHome: { destination?: "people" | "touch" | "search" } | undefined;
  Person: { personId: string };
  PersonLog: { personId: string };
  PersonEditor: { personId?: string } | undefined;
  PersonMerge: { personId: string };
  PeopleTrash: undefined;
};

export type AgendaStackParamList = {
  AgendaHome: undefined;
  AgendaEvent: { eventId: string; instanceKey?: string };
};

export type SettingsStackParamList = {
  SettingsHome: undefined;
  Approvals: undefined;
  Sharing: undefined;
  PhoneStorage: { signalCause?: string } | undefined;
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

export type LockerShellNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<LockerStackParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

export type TallyScreenProps<T extends keyof TallyStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<TallyStackParamList, T>, Root>;

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

export type SettingsScreenProps<T extends keyof SettingsStackParamList> =
  NativeStackScreenProps<SettingsStackParamList, T>;

declare global {
  // oxlint-disable-next-line @typescript-eslint/no-namespace -- grandfathered pre-existing suppression (#247)
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
