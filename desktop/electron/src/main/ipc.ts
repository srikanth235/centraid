/*
 * The IPC handlers: the renderer's one door onto the seat (#1020, D-1020-F2).
 *
 * Every handler validates SHAPE at the boundary — `isStatementName`,
 * `parsePageLimit`, `assertRevealableAppId` — before anything crosses the
 * socket, because v0's one real IPC lesson is that there is no per-channel
 * sender check and shape is all there is (census §F4). What is different here
 * is that the thing on the other side of the shape check is a socket whose peer
 * the kernel already vouched for, so a bad shape is a bug in a blueprint rather
 * than an attack surface onto the vault.
 */

import path from "node:path";

import { app, ipcMain, shell } from "electron";
import type { BrowserWindow } from "electron";

import {
  assertRevealableAppId,
  Channel,
  isStatementName,
  keychainPromptExpected,
  parsePageLimit,
} from "./ipc-core.js";
import type { SeatConnection } from "./seat-socket.js";
import {
  checkForUpdatesManual,
  getUpdateStatus,
  relaunchToUpdate,
} from "./update-watcher.js";

export interface IpcDeps {
  /** The live connection, or `undefined` while the seat is down. */
  seat: () => SeatConnection | undefined;
  /** Bring one up, or throw with the reason the member should read. */
  ensureSeat: () => Promise<SeatConnection>;
  /** Why the seat is not running. */
  failure: () => { loopBroken: boolean; message: string } | undefined;
  retry: () => Promise<unknown>;
  lastState: () => unknown;
  dataDir: () => string;
}

function refuseWithoutSeat(deps: IpcDeps): never {
  const failure = deps.failure();
  // THE CRASH-LOOP SENTENCE, quoted. An operator reading "the seat is not
  // running" learns nothing; the count, the window and the child's own stderr
  // are what tell them whether to wait or to act.
  throw new Error(failure?.message ?? "The Centraid seat is not running yet.");
}

async function seatOrRefuse(deps: IpcDeps): Promise<SeatConnection> {
  const live = deps.seat();
  if (live?.alive()) return live;
  try {
    return await deps.ensureSeat();
  } catch {
    refuseWithoutSeat(deps);
  }
}

export function registerIpcHandlers(deps: IpcDeps): void {
  ipcMain.handle(Channel.SEAT_PAGE, async (_event, raw: unknown) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    if (!isStatementName(input["statement"])) {
      throw new Error("that is not a statement this seat serves");
    }
    const limit = parsePageLimit(input["limit"]);
    if (limit === null) {
      // REQUIRED, NOT DEFAULTED: "a default is how an unbounded read gets
      // written by accident" (`query.proto`).
      throw new Error("a page read needs a limit");
    }
    const seat = await seatOrRefuse(deps);
    const after = input["after"];
    const answered = await seat.request({
      t: "page",
      statement: input["statement"],
      limit,
      ...(after && typeof after === "object" ? { after } : {}),
    });
    return {
      columns: answered["columns"] ?? [],
      rows: answered["rows"] ?? [],
      next: answered["next"],
    };
  });

  ipcMain.handle(Channel.SEAT_COMMAND, async (_event, raw: unknown) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    const name = input["name"];
    if (typeof name !== "string" || name.length === 0 || name.length > 128) {
      throw new Error("a command needs a name");
    }
    const seat = await seatOrRefuse(deps);
    const answered = await seat.request({
      t: "command",
      name,
      input: (input["input"] ?? {}) as Record<string, unknown>,
    });
    return answered["value"];
  });

  ipcMain.handle(Channel.SEAT_DEVICES, async () => {
    const seat = await seatOrRefuse(deps);
    return (await seat.request({ t: "devices_list" }))["value"];
  });

  ipcMain.handle(Channel.SEAT_STATE_GET, () => deps.lastState());

  ipcMain.handle(Channel.SEAT_BLOB_STAT, async (_event, raw: unknown) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    const blob = input["blob"];
    if (typeof blob !== "string" || !/^[0-9a-f]{64}$/u.test(blob)) {
      throw new Error("that is not a blob digest");
    }
    const seat = await seatOrRefuse(deps);
    return await seat.request({ t: "blob_stat", blob });
  });

  ipcMain.handle(Channel.SEAT_CAPABILITY_MINT, async (_event, raw: unknown) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    const client = input["client"];
    if (client !== "mcp" && client !== "native-host") {
      // The renderer may not mint a token for itself: main holds the socket,
      // so it has no use for one, and a self-mint would be a bearer the
      // renderer could keep.
      throw new Error("a capability token is only minted for a child process");
    }
    const purpose =
      typeof input["purpose"] === "string" ? input["purpose"] : "one turn";
    const seat = await seatOrRefuse(deps);
    const answered = await seat.request({
      t: "mint_capability",
      client,
      purpose: purpose.slice(0, 200),
      ttl_ms: 60_000,
    });
    return answered["value"];
  });

  ipcMain.handle(Channel.SEAT_RETRY, async () => {
    await deps.retry();
    return { ok: true };
  });

  ipcMain.handle(Channel.SEAT_FAILURE_GET, () => deps.failure() ?? null);

  ipcMain.handle(Channel.HOST_INFO, () => ({
    platform: process.platform,
    packaged: app.isPackaged,
    version: app.getVersion(),
    keychainPromptExpected: keychainPromptExpected({
      platform: process.platform,
      packaged: app.isPackaged,
    }),
  }));

  // THE UPDATER, carried whole (D-1020-F7). `relaunchToUpdate` installs only a
  // download `admitDownloadedUpdate` trusted, and with no release key enrolled
  // that is never — so this door relaunches rather than installs, which is the
  // fail-closed state and not a gap.
  ipcMain.handle(Channel.UPDATE_STATUS, () => getUpdateStatus());
  ipcMain.handle(
    Channel.UPDATE_CHECK,
    async () => await checkForUpdatesManual()
  );
  ipcMain.handle(Channel.UPDATE_RELAUNCH, () => {
    relaunchToUpdate();
    return { ok: true };
  });

  ipcMain.handle(Channel.HOST_REVEAL, async (_event, raw: unknown) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    // VALIDATED BEFORE THE JOIN, because the id reaches `shell.openPath`.
    const id = assertRevealableAppId(input["id"]);
    await shell.openPath(path.join(deps.dataDir(), "apps", id));
    return { ok: true };
  });
}

/** Push one state to every open window. In main, so it survives navigation. */
export function broadcastSeatState(
  windows: () => BrowserWindow[],
  state: unknown
): void {
  for (const window of windows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(Channel.SEAT_STATE_EVENT, state);
  }
}
