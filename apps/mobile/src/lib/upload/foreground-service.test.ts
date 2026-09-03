import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ReactNative = typeof import("react-native");
type ForegroundServiceModule = typeof import("./foreground-service");

const native = {
  start: vi.fn<(total: number) => void>(),
  update: vi.fn<(completed: number, total: number) => void>(),
  stop: vi.fn<() => void>(),
};

vi.mock(import("react-native"), () => ({
  Platform: {
    OS: "android",
  } as unknown as ReactNative["Platform"],
  NativeModules: { CentraidUploadForeground: native },
}));

let UploadForegroundService: ForegroundServiceModule["UploadForegroundService"];

describe("foreground-service", () => {
  beforeEach(async () => {
    native.start.mockClear();
    native.update.mockClear();
    native.stop.mockClear();
    vi.resetModules();
    ({ UploadForegroundService } = await import("./foreground-service"));
  });

  afterEach(() => vi.clearAllMocks());

  describe("UploadForegroundService refcount", () => {
    it("starts the native service once and stops it once across a single owner", () => {
      UploadForegroundService.start(3);
      UploadForegroundService.stop();
      expect(native.start).toHaveBeenCalledOnce();
      expect(native.stop).toHaveBeenCalledOnce();
    });

    it("keeps the service alive until the LAST concurrent owner stops", () => {
      UploadForegroundService.start(2);
      UploadForegroundService.start(5);
      expect(
        native.start,
        "started once, not per owner"
      ).toHaveBeenCalledOnce();

      UploadForegroundService.stop();
      expect(
        native.stop,
        "first stop must not tear down the live drain"
      ).not.toHaveBeenCalled();
      UploadForegroundService.stop();
      expect(native.stop).toHaveBeenCalledOnce();
    });

    it("treats start(0) as a no-op and never underflows on an unowned stop", () => {
      UploadForegroundService.start(0);
      UploadForegroundService.stop();
      UploadForegroundService.update(1, 2);
      expect(native.start).not.toHaveBeenCalled();
      expect(native.stop).not.toHaveBeenCalled();
      expect(
        native.update,
        "no update without an owner"
      ).not.toHaveBeenCalled();
    });

    it("forwards progress only while an owner holds the service", () => {
      UploadForegroundService.start(4);
      UploadForegroundService.update(2, 4);
      expect(native.update).toHaveBeenCalledWith(2, 4);
      UploadForegroundService.stop();
      UploadForegroundService.update(3, 4);
      expect(
        native.update,
        "no update after the owner released"
      ).toHaveBeenCalledOnce();
    });
  });
});
