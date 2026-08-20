import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  cleanupEnv,
  closeApp,
  commonsRecoveryGrantRecord,
  gatewayDeviceRecord,
  gatewayLinkRecord,
  gatewayOwnerRecord,
  gotoNav,
  launchApp,
  makeEnv,
  scopeRowRecord,
  seedRemoteGateway,
  startMockGateway,
  waitForHome,
} from "./fixtures";
import type { MockGateway, TestEnv } from "./fixtures";

/**
 * §2.12–2.13 — Household as the "Where it lives" half of Vault (v11).
 *
 * Atlas and Household both label "Vault" and land on one custody surface;
 * Household is retired as a launcher destination. The mock still mirrors the
 * real roster/owner-scope/sharing handlers (`owners-routes.ts`,
 * `devices-routes.ts`, `scopes-routes.ts`, `vault-links-routes.ts`,
 * `edges-routes.ts`, `commons-recovery-routes.ts`), so these journeys
 * prove the merged surface: the roster renders people-first, the owner's
 * scope registry is the vault list, and another person's seat changes
 * PRESENTATION (grouping, attribution, state word) but never AUTHORIZATION
 * (the verb set is identical — visibility on the gateway's read is the
 * authorization boundary, and the client never withholds a verb by role).
 */

let env: TestEnv;
let gateway: MockGateway;

test.beforeEach(async () => {
  env = await makeEnv();
  gateway = await startMockGateway();

  // One household: Ada (the caller's person, two vaults, two devices) and
  // Sam (a second person this gateway hosts, one vault, one device). The
  // desktop bearer is the host-custody plane, so it sees both — a
  // device-token caller would see only its own person (topology hiding).
  gateway.state.owners = [
    gatewayOwnerRecord({
      ownerId: "owner-ada",
      label: "Ada",
      vaults: [
        { vaultId: "v-personal", vaultName: "Personal" },
        { vaultId: "v-shared", vaultName: "Shared" },
      ],
      deviceCount: 2,
    }),
    gatewayOwnerRecord({
      ownerId: "owner-sam",
      label: "Sam",
      vaults: [{ vaultId: "v-sam", vaultName: "Sam's vault" }],
      deviceCount: 1,
    }),
  ];
  gateway.state.devices = [
    gatewayDeviceRecord({
      deviceId: "enr-1",
      endpointId: "ep-mac",
      ownerId: "owner-ada",
      ownerLabel: "Ada",
      label: "Ada's MacBook",
      vaultId: "v-personal",
      vaultName: "Personal",
      current: true,
    }),
    // The same hardware enrolled into a second vault — the roster must fold
    // this into ONE device row that reaches two vaults, not a fourth device.
    gatewayDeviceRecord({
      deviceId: "enr-2",
      endpointId: "ep-mac",
      ownerId: "owner-ada",
      ownerLabel: "Ada",
      label: "Ada's MacBook",
      vaultId: "v-shared",
      vaultName: "Shared",
      current: true,
    }),
    gatewayDeviceRecord({
      deviceId: "enr-3",
      endpointId: "ep-phone",
      ownerId: "owner-ada",
      ownerLabel: "Ada",
      label: "Ada's phone",
      vaultId: "v-personal",
      vaultName: "Personal",
      platform: "ios",
    }),
    gatewayDeviceRecord({
      deviceId: "enr-4",
      endpointId: "ep-sam",
      ownerId: "owner-sam",
      ownerLabel: "Sam",
      label: "Sam's laptop",
      vaultId: "v-sam",
      vaultName: "Sam's vault",
    }),
  ];
  // The owner-scope registry: what `GET /_vault/scopes` answers is also what
  // the "Vaults you own" block and every "which vault?" picker resolve from.
  gateway.state.scopes = [
    scopeRowRecord({
      vaultId: "v-personal",
      label: "Personal",
      personal: true,
    }),
    scopeRowRecord({ vaultId: "v-shared", label: "Shared" }),
  ];
  // The sharing surface: one approved link to Priya, and one commons whose
  // steward is absent. There is no parked incoming ask to seed — copy-as-share
  // retired (#825, ruling G-copy), so nothing arrives for an owner to answer.
  gateway.state.links = [
    gatewayLinkRecord({
      linkId: "link-priya",
      vaultA: "v-personal",
      vaultB: "v-priya",
      labelA: "Personal",
      labelB: "Priya's vault",
      approvedByA: true,
      approvedByB: true,
      remoteVaultId: "v-priya",
    }),
  ];
  gateway.state.commonsRecovery = {
    "v-personal": [
      commonsRecoveryGrantRecord({
        grantId: "grant-album",
        containerType: "media.album",
        presence: "absent",
        stewardVaultId: "v-priya",
        silentForMs: 9 * 24 * 60 * 60 * 1000,
      }),
    ],
  };
});

test.afterEach(async () => {
  await gateway.close().catch(() => undefined);
  await cleanupEnv(env);
});

/** One RowsBlock row, by its title. Located by the row shell rather than a
 *  bare text match so the returned locator holds the row's OWN action button
 *  and detail, not an ancestor that contains every row on the page. */
function row(page: Page, title: string) {
  return page.locator('[class*="rowShell"]').filter({
    has: page.getByText(title, { exact: true }),
  });
}

test("2.12 — Household renders the roster, the owner's scopes, and the sharing surface the gateway serves", async () => {
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, "Vault");

    // The frame's app bar names the merged custody surface. Household is
    // the third disclosure; on pointer it starts open. The old Copies
    // count ("3 devices · 2 people · 1 pending") is not published when
    // Household is embedded. The custody sentence prefixes the census
    // record count when atlas answered, so pin the clauses — not a guessed
    // full line — on the section meta next to the h2.
    await expect(
      page.getByRole("heading", { name: "Vault", exact: true })
    ).toBeVisible();
    const livesHead = page.getByRole("heading", {
      name: "Where it lives",
      exact: true,
    });
    await expect(livesHead).toBeVisible();
    const livesMeta = livesHead.locator("xpath=..").locator('[class*="meta"]');
    await expect(livesMeta).toContainText(/\d+ devices enrolled/u);
    await expect(livesMeta).toContainText(/full copy/u);

    // People-first roster: your hardware, then everyone else's.
    await expect(
      page.getByRole("heading", { name: "Yours", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Other people", exact: true })
    ).toBeVisible();
    await expect(row(page, "Ada's MacBook")).toBeVisible();
    await expect(row(page, "Ada's phone")).toBeVisible();
    await expect(row(page, "Sam's laptop")).toBeVisible();

    // Owner scopes: the registry read is the vault list, ownership said out
    // loud on every row.
    await expect(
      page.getByRole("heading", { name: "Vaults you own", exact: true })
    ).toBeVisible();
    await expect(row(page, "Personal")).toBeVisible();
    await expect(row(page, "Shared")).toBeVisible();
    await expect(
      row(page, "Personal").getByText("You own this vault.")
    ).toBeVisible();

    // The sharing card: the linked person's roster and the absent steward's
    // recovery row (#750's UI).
    await expect(
      page.getByRole("heading", { name: "People & circles" })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Shared-space recovery" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Recover from my copy" })
    ).toBeVisible();

    // THE RETIRED ASK SURFACE IS NOT DRAWN, and nothing on this page reaches
    // for the routes that served it (#825). A card that still asked would
    // 404 against a real gateway, so its absence is the assertion.
    await expect(page.getByText("Waiting for your decision")).toBeHidden();
    expect(
      gateway.countCalls("GET", (path) => path.endsWith("/edges/pending"))
    ).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test("2.13 — another person's seat changes presentation, never authorization", async () => {
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, "Vault");
    await expect(
      page.getByRole("heading", { name: "Where it lives", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Other people", exact: true })
    ).toBeVisible();

    // Presentation differs by whose seat it is: your own device says so in
    // its state word, and the other person's row is attributed to them.
    const mac = row(page, "Ada's MacBook");
    const sam = row(page, "Sam's laptop");
    await expect(mac.getByText("This device").first()).toBeVisible();
    await expect(sam.getByText("Other person")).toBeVisible();
    await expect(sam.getByText(/Sam · /u)).toBeVisible();

    // Authorization does not: both rows offer the SAME verb set. The client
    // never withholds "Revoke device" by role — what the caller may touch is
    // decided by which rows the gateway's roster read returned at all.
    await mac.getByRole("button", { name: "Manage" }).click();
    await expect(
      mac.getByRole("button", { name: "Revoke device" })
    ).toBeVisible();
    // The merged MacBook detail names BOTH vaults its enrollments reach.
    await expect(mac.getByText("Personal")).toBeVisible();
    await expect(mac.getByText("Shared")).toBeVisible();
    await mac.getByRole("button", { name: "Close" }).click();

    await sam.getByRole("button", { name: "Manage" }).click();
    await expect(
      sam.getByRole("button", { name: "Revoke device" })
    ).toBeVisible();
  } finally {
    await closeApp(app);
  }
});
