// The device seam for `kit/haptics.ts` (#1015, S15), for the stub tier.
//
// `expo-haptics` dereferences a native module at MODULE scope, so any test
// whose graph reaches the kit's moment channel must stand a seam in front of
// it. The RNTL tier gets one from `native-device-seams.ts`; the stub tier has
// no setup file by design (each file mocks `react-native` its own way), so a
// stub-tier test declares it per file:
//
//     vi.mock(import("expo-haptics"), () => hapticsStub());
//
// One factory rather than a repeated literal per file, so a moment added to
// the channel is added here once.
import { vi } from "vitest";

type Haptics = typeof import("expo-haptics");

export function hapticsStub(): Partial<Haptics> {
  return {
    ImpactFeedbackStyle: { Light: "light", Medium: "medium" } as never,
    NotificationFeedbackType: { Success: "success" } as never,
    impactAsync: vi.fn<Haptics["impactAsync"]>(async () => undefined),
    notificationAsync: vi.fn<Haptics["notificationAsync"]>(
      async () => undefined
    ),
    selectionAsync: vi.fn<Haptics["selectionAsync"]>(async () => undefined),
  };
}
