/*
 * The cross-vault scopes listing (issue #599 Phase 4; ownership since #726).
 *
 * A real `gateway.db` with real owners and real `vault_owners`, because every
 * claim here is an authorization fact: what an owner may see is what they
 * own, a vault they do not own does not exist as far as they are concerned,
 * and the app-follows-the-person auto-mount is driven by the same ownership.
 * The vault REGISTRY is stubbed — this route only ever reads a vault's
 * presentation and its installed-app set, never its contents.
 */

import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { describe, afterEach, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import type { BorrowedEdgeSummary } from "../serve/lend-audience.js";
import { openVaultRegistry } from "../serve/vault-registry.js";
import {
  MAX_MOUNTED_NATIVE_SCOPES,
  makeScopesRouteHandler,
} from "./scopes-routes.js";
import type { ScopeVault } from "./scopes-routes.js";

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const dirs: string[] = [];
describe("scopes-routes suite", () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  interface ScopeRow {
    vaultId: string;
    label: string;
    personal?: boolean;
    color?: string;
    icon?: string;
    canWrite: boolean;
    installed?: boolean;
    borrowed?: {
      edgeId: string;
      holderLabel: string;
      itemType: string;
      reachState: string;
      reason: string | null;
      mounted: boolean;
    };
  }

  interface Harness {
    url: string;
    enrollments: EnrollmentStore;
    /** Priya: owns her personal vault and Family. */
    priya: string;
    /** Sid: owns Partner only. */
    sid: string;
    /** What each vault has installed — mutated by the auto-mount seam. */
    installed: Map<string, Set<string>>;
    /** Every (vaultId, appId) the auto-mount seam was asked to install. */
    ensured: Array<[string, string]>;
    get: (
      endpointId?: string,
      query?: string,
      hostCustody?: boolean
    ) => Promise<Response>;
  }

  // Three mounted vaults in registry listing order (`VaultRegistry.list()`:
  // the default vault, then the rest oldest-first — see the #665 test below).
  const VAULTS: ScopeVault[] = [
    {
      vaultId: "vault-priya",
      name: "Priya",
      personal: true,
      color: "#b91c1c",
      icon: "sparkle",
    },
    { vaultId: "vault-family", name: "Family" },
    { vaultId: "vault-partner", name: "Partner only" },
  ];

  async function harness(
    opts: {
      ensureFails?: boolean;
      borrowedScopes?: (
        audienceVaultIds: readonly string[]
      ) => readonly BorrowedEdgeSummary[];
    } = {}
  ): Promise<Harness> {
    const root = await tempDir("scopes-routes-");
    dirs.push(root);
    const database = GatewayDatabase.open(root);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);

    const priya = enrollments.enroll({
      endpointId: "priya-laptop",
      vaultIds: ["vault-priya", "vault-family"],
      label: "Priya laptop",
      ownerLabel: "Priya",
    });
    const sid = enrollments.enroll({
      endpointId: "sid-phone",
      vaultIds: ["vault-partner"],
      label: "Sid phone",
      ownerLabel: "Sid",
    });

    const installed = new Map<string, Set<string>>([
      ["vault-priya", new Set(["notes"])],
      ["vault-family", new Set<string>()],
      ["vault-partner", new Set<string>()],
    ]);
    const ensured: Array<[string, string]> = [];

    const handler = makeScopesRouteHandler({
      enrollments,
      listVaults: () => VAULTS,
      installedApps: (vaultId) => installed.get(vaultId),
      ensureAppInstalled: async (vaultId, appId) => {
        ensured.push([vaultId, appId]);
        if (opts.ensureFails) throw new Error("install exploded");
        installed.get(vaultId)?.add(appId);
        return true;
      },
      isHostCustody: (req) => req.headers["x-test-host-custody"] === "1",
      ...(opts.borrowedScopes ? { borrowedScopes: opts.borrowedScopes } : {}),
    });
    const server = http.createServer((req, res) => {
      void (async () => {
        if (!(await handler(req, res))) {
          res.statusCode = 404;
          res.end("{}");
        }
      })();
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/centraid/_vault/scopes`;

    return {
      url: base,
      enrollments,
      priya: priya.ownerId,
      sid: sid.ownerId,
      installed,
      ensured,
      get: (endpointId, query, hostCustody = false) =>
        fetch(`${base}${query ?? ""}`, {
          headers: {
            ...(endpointId ? { [AUTHED_DEVICE_HEADER]: endpointId } : {}),
            ...(hostCustody ? { "x-test-host-custody": "1" } : {}),
          },
        }),
    };
  }

  async function scopesOf(response: Response): Promise<ScopeRow[]> {
    return ((await response.json()) as { scopes: ScopeRow[] }).scopes;
  }

  // ---------------------------------------------------------------------------
  // What an owner sees
  // ---------------------------------------------------------------------------

  test("an owner sees exactly the vaults they own, in registry order", async () => {
    const f = await harness();

    const scopes = await scopesOf(await f.get("priya-laptop"));

    // Partner-only is mounted and invisible: absence, never a refusal — and
    // every owned row is writable (`canWrite` is ownership-sourced, #726).
    expect(scopes).toStrictEqual([
      {
        vaultId: "vault-priya",
        label: "Priya",
        personal: true,
        color: "#b91c1c",
        icon: "sparkle",
        canWrite: true,
      },
      {
        vaultId: "vault-family",
        label: "Family",
        personal: false,
        canWrite: true,
      },
    ]);
  });

  /*
   * Issue #665: the two client-facing vault listings — this plane and the
   * plain `GET /_vault/vaults` a gateway without a scopes plane degrades to —
   * both read `VaultRegistry.list()`, so a client can never be told two
   * different "which vault is primary?" answers. A REAL registry here, not
   * the stub above, because the ordering being asserted is the registry's.
   */
  test("the personal vault heads the scopes plane and the degraded vault listing alike", async () => {
    const root = await tempDir("scopes-order-");
    dirs.push(root);
    const registry = openVaultRegistry({
      rootDir: root,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      ownerName: "Priya",
    });
    // Founding order is the real one: Shared first, Personal second.
    const shared = registry.create("Shared");
    const personal = registry.create("Personal", { personal: true });
    // The desktop fresh path renames it — a name match would break here.
    registry.rename(personal.vaultId, "Priya");

    const database = GatewayDatabase.open(path.join(root, "gw"));
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);
    enrollments.enroll({
      endpointId: "priya-laptop",
      vaultIds: [shared.vaultId, personal.vaultId],
      label: "Priya laptop",
      ownerLabel: "Priya",
    });

    const handler = makeScopesRouteHandler({
      enrollments,
      listVaults: () => registry.list(),
      installedApps: () => undefined,
    });
    const server = http.createServer((req, res) => {
      void (async () => {
        if (!(await handler(req, res))) {
          res.statusCode = 404;
          res.end("{}");
        }
      })();
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;

    const scopes = await scopesOf(
      await fetch(`http://127.0.0.1:${port}/centraid/_vault/scopes`, {
        headers: { [AUTHED_DEVICE_HEADER]: "priya-laptop" },
      })
    );

    // The marked vault is first even though `Shared` is older…
    expect(scopes.map((row) => row.vaultId)).toStrictEqual([
      personal.vaultId,
      shared.vaultId,
    ]);
    expect(scopes[0]!.vaultId).toBe(registry.defaultVaultId());
    // …and the degraded listing agrees, row for row.
    expect(registry.list().map((v) => v.vaultId)).toStrictEqual(
      scopes.map((row) => row.vaultId)
    );
    registry.stop();
  });

  test("another owner on the same machine sees only their own vault", async () => {
    const f = await harness();

    const scopes = await scopesOf(await f.get("sid-phone"));

    expect(scopes).toStrictEqual([
      {
        vaultId: "vault-partner",
        label: "Partner only",
        personal: false,
        canWrite: true,
      },
    ]);
  });

  test("an owned vault this gateway does not mount is not a scope", async () => {
    const f = await harness();
    f.enrollments.owners.setOwner("vault-elsewhere", f.sid);

    const scopes = await scopesOf(await f.get("sid-phone"));

    expect(scopes.map((row) => row.vaultId)).toStrictEqual(["vault-partner"]);
  });

  test("host custody sees every mounted vault as writable", async () => {
    const f = await harness();

    const scopes = await scopesOf(await f.get(undefined, undefined, true));

    expect(scopes.map((row) => [row.vaultId, row.canWrite])).toStrictEqual([
      ["vault-priya", true],
      ["vault-family", true],
      ["vault-partner", true],
    ]);
  });

  test("an unproved caller is refused before any vault is listed", async () => {
    const f = await harness();

    const response = await f.get();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "forbidden",
    });
  });

  test("a revoked device no longer resolves to its owner", async () => {
    const f = await harness();
    f.enrollments.revoke("sid-phone");

    const response = await f.get("sid-phone");

    expect(response.status).toBe(403);
  });

  test("the scopes listing is a GET-only surface", async () => {
    const f = await harness();

    const response = await fetch(f.url, {
      method: "POST",
      headers: { [AUTHED_DEVICE_HEADER]: "priya-laptop" },
    });

    expect(response.status).toBe(405);
  });

  // ---------------------------------------------------------------------------
  // `installed`, and the app-follows-the-person auto-mount
  // ---------------------------------------------------------------------------

  test("with no app named, no installed flag is reported at all", async () => {
    const f = await harness();

    const scopes = await scopesOf(await f.get("priya-laptop"));

    expect(scopes.every((row) => row.installed === undefined)).toBe(true);
    expect(f.ensured).toStrictEqual([]);
  });

  test("an app already in one vault follows the owner into the other", async () => {
    const f = await harness();

    const scopes = await scopesOf(await f.get("priya-laptop", "?app=notes"));

    expect(scopes).toStrictEqual([
      expect.objectContaining({ vaultId: "vault-priya", installed: true }),
      expect.objectContaining({
        vaultId: "vault-family",
        canWrite: true,
        installed: true,
      }),
    ]);
    // Installed into the vault that was MISSING it, and only that one.
    expect(f.ensured).toStrictEqual([["vault-family", "notes"]]);
    expect([...f.installed.get("vault-family")!]).toStrictEqual(["notes"]);
    // The vault the caller does not own was never touched.
    expect([...f.installed.get("vault-partner")!]).toStrictEqual([]);
  });

  test("an app in none of the caller vaults is not auto-mounted anywhere", async () => {
    const f = await harness();

    const scopes = await scopesOf(await f.get("priya-laptop", "?app=tally"));

    expect(scopes.map((row) => row.installed)).toStrictEqual([false, false]);
    expect(f.ensured).toStrictEqual([]);
  });

  test("a failed auto-mount degrades to installed:false instead of a 500", async () => {
    const f = await harness({ ensureFails: true });

    const response = await f.get("priya-laptop", "?app=notes");

    expect(response.status).toBe(200);
    await expect(scopesOf(response)).resolves.toStrictEqual([
      expect.objectContaining({ vaultId: "vault-priya", installed: true }),
      expect.objectContaining({ vaultId: "vault-family", installed: false }),
    ]);
    expect(f.ensured).toStrictEqual([["vault-family", "notes"]]);
  });

  test("a second listing is idempotent — nothing is installed twice", async () => {
    const f = await harness();
    await f.get("priya-laptop", "?app=notes");

    const scopes = await scopesOf(await f.get("priya-laptop", "?app=notes"));

    expect(scopes.map((row) => row.installed)).toStrictEqual([true, true]);
    expect(f.ensured).toStrictEqual([["vault-family", "notes"]]);
  });

  // ---------------------------------------------------------------------------
  // Borrowed scopes and the mount policy (#726 P4 item 6)
  // ---------------------------------------------------------------------------

  function edge(input: Partial<BorrowedEdgeSummary>): BorrowedEdgeSummary {
    return {
      edgeId: "edge-1",
      audienceVaultId: "vault-priya",
      originVaultId: "vault-ada",
      holderLabel: "Ada",
      itemType: "media.media_asset",
      state: "established",
      reason: null,
      verbs: "read",
      updatedAt: "2024-01-01T00:00:00.000Z",
      ...input,
    };
  }

  test("a borrowed scope appears read-only, never displacing an owned row", async () => {
    const f = await harness({
      borrowedScopes: () => [edge({})],
    });

    const scopes = await scopesOf(await f.get("priya-laptop"));

    expect(scopes).toStrictEqual([
      expect.objectContaining({ vaultId: "vault-priya", canWrite: true }),
      expect.objectContaining({ vaultId: "vault-family", canWrite: true }),
      expect.objectContaining({
        vaultId: "borrowed:edge-1",
        label: "Ada",
        personal: false,
        canWrite: false,
        borrowed: {
          edgeId: "edge-1",
          originVaultId: "vault-ada",
          holderLabel: "Ada",
          itemType: "media.media_asset",
          reachState: "established",
          reason: null,
          mounted: true,
        },
      }),
    ]);
  });

  test("a scope that lost the mount race is still listed — a state, never a silent absence", async () => {
    // Priya owns two vaults already, leaving MAX_MOUNTED_NATIVE_SCOPES - 2 =
    // 2 slots for borrowed scopes; three borrowed edges compete for them.
    const f = await harness({
      borrowedScopes: () => [
        edge({ edgeId: "edge-oldest", updatedAt: "2024-01-01T00:00:00.000Z" }),
        edge({ edgeId: "edge-middle", updatedAt: "2024-06-01T00:00:00.000Z" }),
        edge({ edgeId: "edge-newest", updatedAt: "2024-09-01T00:00:00.000Z" }),
      ],
    });

    const scopes = await scopesOf(await f.get("priya-laptop"));
    const borrowed = scopes.filter((row) => row.borrowed);

    expect(borrowed).toHaveLength(3);
    // Most recently active wins a slot first; the row is never dropped.
    expect(
      borrowed.map((row) => [row.borrowed!.edgeId, row.borrowed!.mounted])
    ).toStrictEqual([
      ["edge-oldest", false],
      ["edge-middle", true],
      ["edge-newest", true],
    ]);
  });

  test("an owned vault is never denied a mount slot, even past capacity", async () => {
    const f = await harness({
      borrowedScopes: () => [edge({})],
    });
    // Owned rows carry no `mounted` field at all — the policy never asks the
    // question for them.
    const scopes = await scopesOf(await f.get("priya-laptop"));
    const owned = scopes.filter((row) => !row.borrowed);

    expect(owned.every((row) => !("mounted" in row))).toBe(true);
  });

  test("a parked borrowed scope names WHY, distinguishing budget from unreachable", async () => {
    const f = await harness({
      borrowedScopes: () => [
        edge({
          edgeId: "edge-budget",
          state: "parked",
          reason: "byte budget reached",
        }),
      ],
    });

    const scopes = await scopesOf(await f.get("priya-laptop"));
    const borrowed = scopes.find(
      (row) => row.borrowed?.edgeId === "edge-budget"
    );

    expect(borrowed?.borrowed).toMatchObject({
      reachState: "parked",
      reason: "byte budget reached",
    });
  });

  test("a caller with no lend plane wired sees owned scopes only, unchanged", async () => {
    const f = await harness();

    const scopes = await scopesOf(await f.get("priya-laptop"));

    expect(scopes.every((row) => row.borrowed === undefined)).toBe(true);
  });

  test("host custody sees a borrowed edge reaching ANY mounted vault", async () => {
    const f = await harness({
      borrowedScopes: (audienceVaultIds) =>
        audienceVaultIds.includes("vault-partner")
          ? [
              edge({
                audienceVaultId: "vault-partner",
                holderLabel: "Remote friend",
              }),
            ]
          : [],
    });

    const scopes = await scopesOf(await f.get(undefined, undefined, true));

    expect(
      scopes.some((row) => row.borrowed?.holderLabel === "Remote friend")
    ).toBe(true);
  });
});

/*
 * Cross-package mount-cap pin (issue #726 Finding 7). This gateway route
 * cannot IMPORT the mobile and web copies (they depend on the gateway, not
 * the other way around), so — the same move `packages/tunnel/src/
 * alpn-parity.test.ts` makes for the Rust ↔ TypeScript ALPN constants — this
 * suite reads the other two files' SOURCE TEXT and pins their declared values
 * against `MAX_MOUNTED_NATIVE_SCOPES`. A hand-copied "these three agree"
 * comment with nothing enforcing it is worse than no comment (drifts
 * silently); this fails the build the moment one of the three moves alone.
 */
describe("mount cap constants stay pinned across gateway/mobile/web (#726 Finding 7)", () => {
  const MOBILE_OFFLINE_BUDGETS = path.resolve(
    import.meta.dirname,
    "../../../../apps/mobile/src/lib/replica/offline-budgets.ts"
  );
  const WEB_USE_APP_SCOPES = path.resolve(
    import.meta.dirname,
    "../../../../packages/client/src/react/shell/routes/useAppScopes.ts"
  );

  /** `export const NAME = <digits>;` → the number, or undefined if absent. */
  function exportedNumberConst(
    source: string,
    name: string
  ): number | undefined {
    const match = new RegExp(
      `export const ${name} = (?<value>\\d+);`,
      "u"
    ).exec(source);
    return match?.groups?.value === undefined
      ? undefined
      : Number(match.groups.value);
  }

  test("apps/mobile's MAX_MOUNTED_NATIVE_SCOPES agrees with this route's", async () => {
    const source = await fs.readFile(MOBILE_OFFLINE_BUDGETS, "utf8");
    expect(exportedNumberConst(source, "MAX_MOUNTED_NATIVE_SCOPES")).toBe(
      MAX_MOUNTED_NATIVE_SCOPES
    );
  });

  test("the web shell's MAX_MOUNTED_SCOPES agrees with this route's", async () => {
    const source = await fs.readFile(WEB_USE_APP_SCOPES, "utf8");
    expect(exportedNumberConst(source, "MAX_MOUNTED_SCOPES")).toBe(
      MAX_MOUNTED_NATIVE_SCOPES
    );
  });
});
