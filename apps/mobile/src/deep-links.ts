// Deep-link routing for the whole app: the URL scheme, the screen map, and the
// two ways a link reaches us (an `centraid://` open, or a tapped notification
// whose payload carries one).
//
// Kept out of `App.tsx` because it is a table, not app wiring — it grows one row
// per screen, it is the thing to read when a link goes to the wrong place, and
// it owns the only two `expo-linking` / notification-response subscriptions in
// the app.

import type { LinkingOptions } from "@react-navigation/native";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";

import { SYSTEM_DEEP_LINK_PATH } from "./deep-link-paths";
import type { RootStackParamList } from "./navigation";

export const LINKING: LinkingOptions<RootStackParamList> = {
  prefixes: ["centraid://"],
  async getInitialURL(): Promise<string | null> {
    const url = await Linking.getInitialURL();
    if (url) return url;
    return notificationUrl(
      await Notifications.getLastNotificationResponseAsync()
    );
  },
  subscribe(listener): () => void {
    const linking = Linking.addEventListener("url", ({ url }) => listener(url));
    const notifications = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const url = notificationUrl(response);
        if (url) listener(url);
      }
    );
    return () => {
      linking.remove();
      notifications.remove();
    };
  },
  config: {
    screens: {
      Capture: "capture",
      Scan: {
        path: "scan",
        parse: {
          plaintextSize: Number,
          deleteSourceAfterSettle: (value: string) => value === "true",
        },
      },
      Agenda: {
        screens: {
          AgendaHome: "agenda",
          AgendaEvent: "agenda/event/:eventId",
        },
      },
      Photos: {
        screens: {
          PhotosHome: "photos",
          PhotoLightbox: "photos/:assetId",
        },
      },
      Docs: {
        screens: {
          DocsHome: "docs",
          DocumentRead: "docs/:documentId",
        },
      },
      Locker: {
        screens: {
          LockerHome: "locker",
          LockerItem: "locker/item/:itemId",
        },
      },
      Tasks: "apps/tasks",
      People: {
        screens: {
          PeopleHome: "apps/people",
          Person: "apps/people/:personId",
        },
      },
      Notes: "apps/notes",
      Tally: {
        screens: {
          TallyHome: "apps/tally",
          TallyGroup: "apps/tally/group/:groupId",
          TallyFriend: "apps/tally/friend/:partyId",
          TallyExpense: "apps/tally/expense/:expenseId",
        },
      },
      Assistant: "assistant",
      Automations: "automations",
      Insights: "insights",
      SystemOnPhone: SYSTEM_DEEP_LINK_PATH,
      // `commons-invite` is not a path under `settings`: the URI is minted by
      // the vault (`_shared/commons-invite.ts`), carried by hand, and its host
      // is fixed — this table follows it rather than the other way round. It
      // lands on Sharing because that is the redemption door, and the claim
      // rides through as route params.
      Settings: {
        screens: {
          Settings: "settings",
          Sharing: "commons-invite",
        },
      },
      Home: "",
    },
  },
};

function notificationUrl(
  response: Notifications.NotificationResponse | null
): string | null {
  if (!response) return null;
  const value = (
    response.notification.request.content.data as { url?: unknown }
  ).url;
  return typeof value === "string" && value.startsWith("centraid://")
    ? value
    : null;
}
