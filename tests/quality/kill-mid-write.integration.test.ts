import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { GATEWAY_WRITE_FAULT_POINTS } from "./fault-points.js";

describe("kill-mid-write harness", () => {
  test.each(GATEWAY_WRITE_FAULT_POINTS)(
    "SIGKILL at %s preserves acknowledged work without a duplicate commit",
    async (faultPoint) => {
      const dir = await tempDir("kill-mid-write-");
      const child = spawn(
        process.execPath,
        [
          path.join(import.meta.dirname, "fixtures/kill-mid-write-child.mjs"),
          dir,
          faultPoint,
        ],
        { stdio: ["ignore", "pipe", "inherit"] }
      );
      await new Promise<void>((resolve, reject) => {
        child.stdout.setEncoding("utf8");
        const onData = (chunk: string) => {
          if (!chunk.includes(`FAULT_READY ${faultPoint}`)) return;
          child.stdout.off("data", onData);
          resolve();
        };
        child.stdout.on("data", onData);
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`fault gateway exited before injection (${code})`))
        );
      });
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      const recovery = spawn(
        process.execPath,
        [
          path.join(import.meta.dirname, "fixtures/kill-mid-write-child.mjs"),
          dir,
          faultPoint,
          "recover",
        ],
        { stdio: ["ignore", "pipe", "inherit"] }
      );
      let output = "";
      recovery.stdout.setEncoding("utf8");
      recovery.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
      await new Promise<void>((resolve, reject) => {
        recovery.once("error", reject);
        recovery.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`recovery gateway exited ${code}`));
        });
      });
      const recoveryLine = output
        .split("\n")
        .find((line) => line.startsWith("QUALITY_RECOVERY "));
      const result = JSON.parse(recoveryLine?.slice(17) ?? "{}") as {
        integrity: {
          vault: { integrity_check: string };
          journal: { integrity_check: string };
        };
        observation: Record<string, unknown>;
      };
      expect(result.integrity.vault.integrity_check).toBe("ok");
      expect(result.integrity.journal.integrity_check).toBe("ok");
      const expected: Record<string, Record<string, unknown>> = {
        "journal-after-append": { turns: 1, items: 1 },
        "blob-after-stage": { sessions: 1, received: 7, state: "open" },
        "wal-before-checkpoint": { items: 1 },
        "automation-after-claim": {
          conversations: 1,
          duplicateClaimAccepted: false,
        },
      };
      expect(result.observation).toStrictEqual(expected[faultPoint]);
    }
  );
});
