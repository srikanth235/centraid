import type AsyncStorage from "@react-native-async-storage/async-storage";
import type * as Notifications from "expo-notifications";
import { describe, expect, test, vi } from "vitest";

import { nextBriefNotificationAt } from "./daily-brief";
import type * as Gateway from "./gateway";

vi.mock(import("@react-native-async-storage/async-storage"), () => ({
  default: {
    getItem: vi.fn<typeof AsyncStorage.getItem>(),
    setItem: vi.fn<typeof AsyncStorage.setItem>(),
  } as unknown as typeof AsyncStorage,
}));
vi.mock(
  import("expo-notifications"),
  () =>
    ({
      SchedulableTriggerInputTypes: { DATE: "date" },
      getPermissionsAsync: vi.fn<typeof Notifications.getPermissionsAsync>(),
      scheduleNotificationAsync:
        vi.fn<typeof Notifications.scheduleNotificationAsync>(),
    }) as unknown as typeof Notifications
);
vi.mock(
  import("./gateway"),
  () =>
    ({
      authHeader: vi.fn<typeof Gateway.authHeader>(() => ({})),
      fetchJson: vi.fn<typeof Gateway.fetchJson>(),
      requireGatewayBase: vi.fn<typeof Gateway.requireGatewayBase>(),
    }) as unknown as typeof Gateway
);

describe("daily brief scheduling", () => {
  test("arms 07:00 today before seven and tomorrow after seven", () => {
    expect(
      nextBriefNotificationAt(new Date(2026, 6, 29, 6, 30)).getTime()
    ).toBe(new Date(2026, 6, 29, 7).getTime());
    expect(nextBriefNotificationAt(new Date(2026, 6, 29, 8)).getTime()).toBe(
      new Date(2026, 6, 30, 7).getTime()
    );
  });
});
