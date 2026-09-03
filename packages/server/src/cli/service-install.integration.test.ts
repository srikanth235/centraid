import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { buildLaunchdPlist, launchAgentPlistPath } from "./service-unit.ts";
import type { ServiceUnitSpec } from "./service-unit.ts";

vi.setConfig({ testTimeout: 30_000 });

const TEST_LABEL = "dev.centraid.gateway.e2e-test";

function guiTarget(): string {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("no POSIX uid — cannot address the launchd gui domain");
  return `gui/${uid}`;
}

describe("service-install", () => {
  test("real launchctl bootstrap/print/bootout round-trip against a TEST label, never the real daemon label", async (t) => {
    if (process.platform !== "darwin") {
      t.skip("launchd e2e only runs on darwin");
      return;
    }
    if (process.env.CENTRAID_LAUNCHD_E2E !== "1") {
      t.skip(
        "set CENTRAID_LAUNCHD_E2E=1 (on darwin) to run the real launchctl e2e"
      );
      return;
    }

    expect(TEST_LABEL).not.toBe("dev.centraid.gateway");

    const home = os.homedir();
    const plistPath = launchAgentPlistPath(home, TEST_LABEL);
    const work = tempDirSync("launchd-e2e-");
    const stdoutLog = path.join(work, `${TEST_LABEL}-stdout.log`);
    const stderrLog = path.join(work, `${TEST_LABEL}-stderr.log`);

    const spec: ServiceUnitSpec = {
      nodeBin: "/bin/sleep",
      cliEntry: "9999999",
      args: [],
      stdoutLog,
      stderrLog,
      workingDirectory: work,
    };
    const plist = buildLaunchdPlist(TEST_LABEL, spec);

    try {
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, plist, "utf8");
      execFileSync("launchctl", ["bootstrap", guiTarget(), plistPath], {
        stdio: "pipe",
      });

      const waitForRunning = async (attempt: number): Promise<string> => {
        let printed = "";
        try {
          printed = execFileSync(
            "launchctl",
            ["print", `${guiTarget()}/${TEST_LABEL}`],
            {
              encoding: "utf8",
            }
          );
        } catch {
          printed = "";
        }
        if (/state = running/u.test(printed) || attempt >= 39) return printed;
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
        return waitForRunning(attempt + 1);
      };
      const printed = await waitForRunning(0);
      expect(printed).toMatch(/state = running/u);
    } finally {
      try {
        execFileSync("launchctl", ["bootout", `${guiTarget()}/${TEST_LABEL}`], {
          stdio: "pipe",
        });
      } catch {
        // Intentionally empty.
      }
      await fs.rm(plistPath, { force: true });
      await fs.rm(stdoutLog, { force: true });
      await fs.rm(stderrLog, { force: true });
    }
  }, 30000);
});
