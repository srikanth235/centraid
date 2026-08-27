// The frame's stand-in for "this fixture has no upload queue" (#880).
//
// `lint:engine-conformance` reserves `lib/upload/native-queue` for the frame:
// an app may not name the transfer engine's internals, and the ratchet that
// still lets `apps/photos/timeline-engine.ts` import it may only shrink. An
// app test that must load its subject still needs the module stubbed, because
// the real one drags the native upload chain into the graph. That stand-in
// belongs here, with the frame, not copied into each app's tests.
//
// Import this module first, then `await import(...)` the subject — the mock is
// registered when this module evaluates, so a statically imported subject
// would already be bound to the real chain.
import { vi } from "vitest";

vi.mock(import("../lib/upload/native-queue") as Promise<unknown>, () => ({
  UploadQueue: {
    open: () => {
      throw new Error("no upload queue in this fixture");
    },
  },
}));
