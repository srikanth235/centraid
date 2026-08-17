import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_1gl5zx7 from "../../../gateway-client.js";
import {
  CRON_DEFAULT_TIMEZONE_PREF,
  loadDefaultCronTimeZone,
  saveDefaultCronTimeZone,
} from "./settingsCronTimezoneData.js";

const getUserPrefs = vi.hoisted(() =>
  vi.fn<typeof TypeImport_1gl5zx7.getUserPrefs>()
);
const saveUserPrefs = vi.hoisted(() =>
  vi.fn<typeof TypeImport_1gl5zx7.saveUserPrefs>()
);

vi.mock(import("../../../gateway-client.js"), () => ({
  getUserPrefs: () => getUserPrefs(),
  saveUserPrefs: (patch: Record<string, unknown>) => saveUserPrefs(patch),
}));

describe("settingsCronTimezoneData", () => {
  beforeEach(() => {
    getUserPrefs.mockReset();
    saveUserPrefs.mockReset();
    getUserPrefs.mockResolvedValue({});
    saveUserPrefs.mockResolvedValue({});
  });

  describe("settingsCronTimezoneData", () => {
    it("loads the gateway default cron timezone pref", async () => {
      getUserPrefs.mockResolvedValue({
        [CRON_DEFAULT_TIMEZONE_PREF]: "America/New_York",
      });
      await expect(loadDefaultCronTimeZone()).resolves.toBe("America/New_York");
    });

    it("returns empty string when the pref is unset", async () => {
      await expect(loadDefaultCronTimeZone()).resolves.toBe("");
    });

    it("saves a valid IANA name", async () => {
      await expect(
        saveDefaultCronTimeZone("Europe/London")
      ).resolves.toBeNull();
      expect(saveUserPrefs).toHaveBeenCalledWith({
        [CRON_DEFAULT_TIMEZONE_PREF]: "Europe/London",
      });
    });

    it("clears the pref when empty", async () => {
      await expect(saveDefaultCronTimeZone("  ")).resolves.toBeNull();
      expect(saveUserPrefs).toHaveBeenCalledWith({
        [CRON_DEFAULT_TIMEZONE_PREF]: null,
      });
    });

    it("refuses an unknown IANA name without writing, naming the last good zone", async () => {
      // The typo is on screen already; what a member cannot see is which zone
      // their schedules are still firing in, so the error states that.
      const err = await saveDefaultCronTimeZone("Not/A_Zone", "Europe/London");
      expect(err).toBe(
        "Not a zone the gateway knows. Still using Europe/London."
      );
      expect(saveUserPrefs).not.toHaveBeenCalled();
    });

    it("names the host clock when there is no last good zone", async () => {
      await expect(saveDefaultCronTimeZone("Not/A_Zone")).resolves.toBe(
        "Not a zone the gateway knows. Still using the host clock."
      );
    });

    it("returns the gateway's own words when the write is refused", async () => {
      saveUserPrefs.mockRejectedValue(new Error("prefs.write refused"));
      await expect(
        saveDefaultCronTimeZone("Europe/Paris", "Europe/London")
      ).resolves.toBe("prefs.write refused. Still using Europe/London.");
    });
  });
});
