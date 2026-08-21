// Single source of truth for the navigation tree + route params.
//
//   RootStack (native stack, springboard model)
//   ├─ Home          → HomeScreen                      (launcher, root)
//   ├─ Photos        → PhotosStack  (timeline, lightbox, library/search/sharing)
//   ├─ Docs          → DocsStack    (drive, folders, coming due, document screens)
//   ├─ Agenda        → AgendaStack  (calendar, event)
//   ├─ Locker        → LockerHome   (native authenticated secrets cover)
//   ├─ Tasks         → TasksHome    (native offline task organizer)
//   ├─ People        → PeopleStack  (roster/touch/search, person, log/edit/link/merge)
//   ├─ Notes         → NotesHome    (native CommonMark + linked-data editor)
//   ├─ Tally         → TallyHome    (native offline shared ledger)
//   ├─ Assistant     → AssistantScreen (chat with the gateway assistant)
//   ├─ Capture       → CaptureScreen (preview-first universal quick add)
//   ├─ Scan          → ScanScreen (camera/share OCR review)
//   ├─ Automations   → AutomationsScreen (list + run the vault's automations)
//   ├─ Insights      → InsightsScreen (Activity; stable route id)
//   ├─ Connectors    → ConnectorsScreen (what is allowed to reach outside)
//   ├─ Data          → DataScreen (Vault; stable route id)
//   ├─ Devices       → DevicesScreen (Copies; stable route id)
//   └─ Settings      → SettingsStack (Settings, Approvals, PhoneStorage,
//                                     BackupHealth)
//
// There is no bottom-tab navigator: the apps are full-screen covers that slide
// up over Home and dismiss with the native swipe-down gesture. Each nested-stack
// screen imports its own typed props off the helpers below, composed with the
// root stack via `CompositeScreenProps` so `navigation.navigate` still
// type-checks when it crosses up to a sibling cover (e.g. Docs → Approvals) or
// back to Home.

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
  // `destination` names which of the claimed band's shelves to land on. The
  // band is rendered on every Photos surface (`PhotosScreen.tsx`), and its
  // three shelf destinations all live on this one screen — so a band tap from
  // a pushed route navigates here WITH the shelf named rather than pushing a
  // second copy of anything. Optional, and `more` never reaches it: More is a
  // sheet, not a route.
  //
  // Written out longhand rather than imported as
  // `Exclude<BandDestinationKey, "more">` from `apps/photos/photos-band.ts`:
  // the frame may not import an app (`scripts/check-import-boundaries.ts`).
  // What pins the two together is `PhotosScreen.tsx`'s band handler, which
  // passes a `BandDestinationKey` straight into this param — a destination
  // added to the band and forgotten here fails to typecheck there.
  PhotosHome:
    | { destination?: "library" | "collections" | "search" }
    | undefined;
  PhotoLightbox: { assetId: string };
  PhotosLibrary: undefined;
  PhotosSearch: undefined;
  // Places' shelf (cards first, proto:4197): `PlacesView` is where the More
  // sheet's "Places" row lands; `PlacesMap` is the full-screen map it opens
  // on demand from the shelf head's Map control, and `PlaceDetail` is what a
  // card opens — one place's photographs, filtered locally (see
  // `PlaceDetail.tsx` for why: `PhotoStateView` has no "place" mode and is
  // not this route's to grow).
  PlacesView: undefined;
  PlacesMap: undefined;
  PlaceDetail: { placeKey: string; placeName: string };
  FaceReview: undefined;
  // The people roster (issue #712). It used to be a band destination rendered
  // inline by `PhotosHome`; now that People is off the band, it is a pushed
  // route like every other shelf behind Collections — reached from Collections'
  // own People section heading (`PhotosCollectionsView.tsx`'s `open()`) and from
  // the Library shelf list's People row alongside `FaceReview`, which this route
  // keeps distinct from: `PhotosPeople` browses confirmed identities,
  // `FaceReview` triages proposed ones.
  PhotosPeople: undefined;
  // Duplicates is TWO surfaces, as the v4 prototype has it: the shelf lists
  // the clusters (proto:4436), and the review works one cluster at a time
  // (proto:4291). The More sheet's row lands on the shelf; the shelf's own
  // primary control is the way into the review.
  DuplicatesShelf: undefined;
  DuplicateReview: undefined;
  // The full Memories surface (issue #724 W7) — On this day, Trips, and
  // Similar moments, read off the vault's `media.memory` projection. Reached
  // from Collections' own Memories section heading
  // (`PhotosCollectionsView.tsx`'s `open()`), which used to have nowhere to
  // send that tap because no "all memories" screen existed.
  PhotosMemories: undefined;
  AlbumDetail: { albumId: string };
  // The picker (§10) — full screen on the phone. Its picked set is its own,
  // so the album it commits to is a route param rather than shared state.
  PhotoPicker: { albumId: string };
  // There is no `PhotoPermission` route (issue #712 P13). The OS
  // photo-library grant is a designed STATE of the timeline, not a screen a
  // member has to go and find: `PhotosHome` renders the permission content in
  // the grid's own slot (`PhotoAccessPanel.tsx`) when the grant cannot produce
  // a timeline. A route to it would be a second, worse way to the same words.
  // Person is a distinct case: it needs the party to filter by AND the name
  // already resolved (the view has no other route to a display name for an
  // id it did not already have on hand). `archive` has no client affordance
  // that ever sets it (nothing writes `archived`/`archived_at` true), but
  // `PhotosLibrary.tsx` still reads it back out — left in place until that
  // caller is retired, not deleted blind. `videos` is Collections' Videos
  // shelf (issue #721 B3) — the same "filter over the one shared timeline"
  // shape as `favorites`, so it grew this union rather than a screen of
  // its own.
  PhotoStateView:
    | { mode: "favorites" | "archive" | "trash" | "videos" }
    | { mode: "person"; partyId: string; personName: string };
};

export type DocsStackParamList = {
  // `destination` names which of the claimed band's shelves to land on — the
  // same shape as `PhotosHome.destination`, and for the same reason: the four
  // shelf destinations (`all` · `folders` · `due` · `search`) all live on this
  // one screen, so a band tap from a pushed route navigates here with the
  // shelf named rather than pushing a second copy. `more` never reaches it:
  // More is a sheet, not a route. Written out longhand rather than imported
  // from `apps/docs/docs-band.ts` — the frame may not import an app
  // (`scripts/check-import-boundaries.ts`); `DocsScreen.tsx`'s band handler
  // pins the two together at its own typecheck.
  DocsHome: { destination?: "all" | "folders" | "due" | "search" } | undefined;
  // Inside one label. The name rides along because the folder row already
  // holds it and the screen's app bar must not wait a replica round-trip to
  // title itself.
  DocsFolder: { folderId: string; folderName: string };
  // One route for the read surface: the component renders the reading view
  // for kinds Docs can set and the facts panel for kinds it cannot — the
  // fork is a fact about the document, not two places.
  DocumentRead: { documentId: string };
  DocumentViewer: { documentId: string };
  DocumentEditor: { documentId: string };
  DocumentVersions: { documentId: string };
  DocumentProperties: { documentId: string };
  // The consent surface and the two screens its capabilities produce.
  DocsCapabilities: undefined;
  DocsProposedFiling: undefined;
  DocumentNames: { documentId: string };
  // Four ways in, and bulk upload as its own surface with per-file honesty.
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
  // The three band destinations (`people` · `touch` · `search`) live on this
  // one screen — same shape and reasoning as `DocsHome.destination` above.
  PeopleHome: { destination?: "people" | "touch" | "search" } | undefined;
  Person: { personId: string };
  // Log a touch: reachable from the person screen and from a Reconnect row.
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
  // Sharing (issue #726 P6): the People panel — shares in/out, link
  // propose/approve, the D9 ask surface and receive setting.
  Sharing: undefined;
  PhoneStorage: { signalCause?: string } | undefined;
  // Backup health (issue #712 B2) — a FRAME screen, beside Phone storage. It
  // used to live in the Photos stack, which was always a compromise: the policy
  // it edits governs Docs' scans and Notes' attachments too, and nothing on it
  // is Photos-specific. Photos deep-links across to it from the More sheet's
  // "Backup" row rather than keeping a copy.
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
  // The three places promoted to screens of their own (issue #765). They are
  // ROOT covers, beside Automations and Insights — not members of
  // `SettingsStackParamList`. Two reasons: a place is not a setting (Connectors
  // used to land on Settings because nothing else existed, which is the bug
  // this fixes), and the Settings stack is deliberately not composed with the
  // root stack, so a screen inside it cannot navigate to a sibling cover.
  Connectors: undefined;
  // `kind` names which store's records to open on — the same "land on the named
  // shelf rather than push a second copy" shape `PhotosHome.destination` uses.
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

/**
 * What the Photos shell (`apps/photos/PhotosScreen.tsx`) needs: the Photos
 * stack (for the band's four shelf destinations and the More sheet's rows)
 * composed with the root stack (for the band capsule's one tap to Home).
 *
 * Read through `useNavigation()` rather than taken as a prop, so the shell can
 * wrap ANY Photos screen without each one having to widen its own navigation
 * type to the union of every route it never navigates to.
 */
export type PhotosShellNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<PhotosStackParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

export type AgendaScreenProps<T extends keyof AgendaStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<AgendaStackParamList, T>, Root>;

export type DocsScreenProps<T extends keyof DocsStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<DocsStackParamList, T>, Root>;

/**
 * What the Docs shell (`apps/docs/DocsScreen.tsx`) needs — the Docs stack for
 * the band's four shelf destinations and the More sheet's rows, composed with
 * the root stack for the band capsule's one tap to Home. Read through
 * `useNavigation()`, same reasoning as `PhotosShellNavigation` above.
 */
export type DocsShellNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<DocsStackParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

export type PeopleScreenProps<T extends keyof PeopleStackParamList> =
  CompositeScreenProps<NativeStackScreenProps<PeopleStackParamList, T>, Root>;

/** The People shell's composite navigation — see `PhotosShellNavigation`. */
export type PeopleShellNavigation = CompositeNavigationProp<
  NativeStackNavigationProp<PeopleStackParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;

// The Settings cover's screens are intentionally NOT composed with the root
// stack: the root route that presents this cover is itself named `Settings`, so
// an intersection with the root param list would collapse the inner `Settings`
// screen's params to `never`. These screens never navigate out to a sibling
// cover — they move between Settings and Approvals and dismiss via
// `navigation.getParent()?.goBack()` — so the plain stack props are sufficient.
export type SettingsScreenProps<T extends keyof SettingsStackParamList> =
  NativeStackScreenProps<SettingsStackParamList, T>;

declare global {
  // Makes `useNavigation()` infer the right list everywhere.
  // eslint-disable-next-line @typescript-eslint/no-namespace -- grandfathered pre-existing suppression (#247)
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
