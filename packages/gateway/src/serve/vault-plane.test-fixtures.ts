// Shared fixture vocabulary for the `vault-plane-*` behaviour suites. The
// plane is expensive to stand up and every suite needs the same three things:
// a bootstrapped plane that stops itself, a seeded calendar to hang schedule
// commands off, and (for the owner-route suites) a live HTTP server in front
// of `makeVaultRouteHandler`. Keeping them here means the suites can be split
// by concern without copy-pasting the setup into each file.
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

import { afterEach } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { uuidv7 } from "@centraid/vault";

import { makeVaultRouteHandler } from "../routes/vault-routes.js";
import { openVaultPlane } from "./vault-plane.js";
import type { VaultPlane, VaultPlaneOptions } from "./vault-plane.js";
import type { VaultRegistry } from "./vault-registry.js";

/** Planes log on every open; the suites assert behaviour, not chatter. */
export const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Recursive byte total of `dir` — used to prove the shipper wrote nothing. */
export async function directoryBytes(dir: string): Promise<number> {
  const sizes = await Promise.all(
    (await fs.readdir(dir, { withFileTypes: true })).map(async (entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory()
        ? directoryBytes(full)
        : (await fs.stat(full)).size;
    })
  );
  return sizes.reduce((total, size) => total + size, 0);
}

/** A `schedule_calendar` row for `schedule.propose_event` to land against. */
export function seedCalendar(plane: VaultPlane): string {
  const id = uuidv7();
  plane.db.vault
    .prepare(
      `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, default_tz, visibility)
       VALUES (?, ?, 'Personal', 'Asia/Kolkata', 'private')`
    )
    .run(id, plane.boot.ownerPartyId);
  return id;
}

export interface PlaneFixture {
  /** Register a teardown. They run in reverse registration order. */
  push: (cleanup: () => Promise<void> | void) => void;
  /** A bootstrapped, self-stopping plane rooted at `dir`. */
  openPlane: (dir: string) => VaultPlane;
  /** …with extra options (WAL shipper gating, notifications hook, …). */
  openPlaneWith: (
    options: Omit<VaultPlaneOptions, "logger"> &
      Partial<Pick<VaultPlaneOptions, "logger">>
  ) => VaultPlane;
  /** Serve `registry`'s owner routes; resolves to the `…/_vault` base URL. */
  serveOwnerRoutes: (registry: VaultRegistry) => Promise<string>;
}

/**
 * Install the per-test teardown and hand back the plane constructors. Call it
 * once inside each suite's `describe` — every plane, registry and server it
 * hands out is torn down after the test that opened it.
 */
export function usePlaneFixture(): PlaneFixture {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  const push = (cleanup: () => Promise<void> | void): void => {
    cleanups.push(cleanup);
  };

  const openPlaneWith = (
    options: Omit<VaultPlaneOptions, "logger"> &
      Partial<Pick<VaultPlaneOptions, "logger">>
  ): VaultPlane => {
    const plane = openVaultPlane({
      logger: silentLogger,
      ...options,
    });
    push(() => plane.stop());
    return plane;
  };

  return {
    push,
    openPlaneWith,
    openPlane: (dir: string) =>
      openPlaneWith({ bootstrap: true, dir, ownerName: "Priya" }),
    serveOwnerRoutes: async (registry: VaultRegistry) => {
      const handler = makeVaultRouteHandler(registry);
      const server = http.createServer((req, res) => {
        void handler(req, res).then((owned) => {
          if (!owned) {
            res.statusCode = 404;
            res.end("{}");
          }
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      push(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          })
      );
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no address");
      return `http://127.0.0.1:${addr.port}/centraid/_vault`;
    },
  };
}
