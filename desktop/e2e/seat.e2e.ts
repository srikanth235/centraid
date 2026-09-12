/*
 * The seat's lifecycle and its thin mode, end to end (#1020 lane F).
 *
 * Two claims that only a real app can settle:
 *
 * 1. **Quit stops the seat** (D-1020-F1). v0 deliberately leaves a detached
 *    gateway running (census §F seam 1); a seat process whose only client is
 *    this window is owned, and the process really is gone and the socket really
 *    is unlinked after the window closes.
 * 2. **A thin seat draws "nothing to show", never an empty list.** The three-
 *    state read law, on the screen rather than in a fold.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { centraidBinary, foundVault, makeDataDir, REPO } from "./fixture.mjs";

/** Pids of `centraid seat` processes serving a given socket path. */
function seatPids(socketPath: string): string[] {
  // `ps` rather than a pid file: what is being asserted is that no process is
  // left behind, and a pid file the shell wrote would be the shell's own claim
  // about that rather than the kernel's.
  const listed = execFileSync("ps", ["-eo", "pid=,args="], {
    encoding: "utf8",
  });
  return listed
    .split("\n")
    .filter((line) => line.includes("centraid") && line.includes(socketPath))
    .map((line) => line.trim().split(/\s+/u)[0] ?? "")
    .filter((pid) => pid.length > 0);
}

test("quit stops the seat it started and unlinks its socket", async () => {
  const dataDir = makeDataDir("quit");
  await foundVault(dataDir);
  const socketPath = path.join(dataDir, "seat.sock");
  const app = await electron.launch({
    args: [path.join(REPO, "desktop/e2e/electron-entry.mjs"), "--no-sandbox"],
    env: {
      ...process.env,
      CENTRAID_BINARY: centraidBinary(),
      CENTRAID_DATA_DIR: dataDir,
      CENTRAID_SEAT_SOCKET: socketPath,
    },
  });
  const page = await app.firstWindow();
  await expect(page.getByTestId("state-mode")).toHaveText("replicated");

  // The seat is a real process, and the socket is a real file with mode 0600.
  expect(seatPids(socketPath)).toHaveLength(1);
  expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);

  await app.close();

  // OWNED: the process is gone, not detached.
  await expect
    .poll(() => seatPids(socketPath).length, { timeout: 30_000 })
    .toBe(0);
  // And the socket file went with it, so the next launch has no stale path to
  // probe.
  await expect
    .poll(() => fs.existsSync(socketPath), { timeout: 10_000 })
    .toBe(false);
});

test("a thin seat shows nothing to show, with a reason, and never an empty list", async () => {
  const dataDir = makeDataDir("thin");
  await foundVault(dataDir);
  const socketPath = path.join(dataDir, "seat.sock");
  const app = await electron.launch({
    args: [path.join(REPO, "desktop/e2e/electron-entry.mjs"), "--no-sandbox"],
    env: {
      ...process.env,
      CENTRAID_BINARY: centraidBinary(),
      CENTRAID_DATA_DIR: dataDir,
      CENTRAID_SEAT_SOCKET: socketPath,
      CENTRAID_SEAT_THIN: "1",
    },
  });
  const page = await app.firstWindow();

  await expect(page.getByTestId("state-mode")).toHaveText("thin");
  await expect(page.getByTestId("state-availability")).toHaveText(
    "unavailable"
  );
  await expect(page.getByTestId("state-durability")).toHaveText("none");

  // THE LAW: a reason on the screen, and no list at all — not a list with
  // nothing in it.
  const nothing = page.getByTestId("read-nothing");
  await expect(nothing).toBeVisible();
  await expect(nothing).toContainText("not been paired");
  await expect(page.getByTestId("photos-grid")).toHaveCount(0);
  await expect(page.getByTestId("photos-empty")).toHaveCount(0);
  await expect(page.getByTestId("tally")).toBeVisible();
  // The dashboard's numbers are absent rather than zero: a thin seat with no
  // gateway knows nothing about what the vault holds, and "0 expenses" would
  // be an assertion nobody can make.
  await expect(page.getByTestId("tally-expenses")).toHaveCount(0);

  await app.close();
});

test("the same door serves the shell in replicated mode, with the ledger's own rows", async () => {
  const dataDir = makeDataDir("replicated");
  await foundVault(dataDir);
  const socketPath = path.join(dataDir, "seat.sock");
  const app = await electron.launch({
    args: [path.join(REPO, "desktop/e2e/electron-entry.mjs"), "--no-sandbox"],
    env: {
      ...process.env,
      CENTRAID_BINARY: centraidBinary(),
      CENTRAID_DATA_DIR: dataDir,
      CENTRAID_SEAT_SOCKET: socketPath,
    },
  });
  const page = await app.firstWindow();

  // A FRESHLY FOUNDED vault: one vault row, no friends, no ledger. The base
  // currency is the founding's own, read out of `core_vault` through the
  // catalogue — so the whole path (socket → core → vault → fold → screen) is
  // what produced this string.
  await expect(page.getByTestId("tally-currency")).not.toHaveText("—");
  await expect(page.getByTestId("tally-friends")).toHaveText("0");
  await expect(page.getByTestId("tally-expenses")).toHaveText("0");
  await expect(page.getByTestId("photos-empty")).toBeVisible();
  // Nothing was refused, so the numbers above are answers rather than absences.
  await expect(page.getByTestId("tally-unavailable")).toHaveCount(0);

  // A read the catalogue does not carry is refused at the boundary, before a
  // socket frame is written.
  const refused = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          CentraidApi: {
            page: (input: {
              statement: string;
              limit: number;
            }) => Promise<unknown>;
          };
        }
      ).CentraidApi.page({ statement: "SELECT * FROM core_party", limit: 1 });
      return "allowed";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(refused).not.toBe("allowed");
  expect(refused).toContain("statement");

  await app.close();
});
