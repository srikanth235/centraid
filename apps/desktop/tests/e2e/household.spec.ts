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
  pendingEdgeRecord,
  scopeRowRecord,
  seedRemoteGateway,
  startMockGateway,
  waitForHome,
} from "./fixtures";
import type { MockGateway, TestEnv } from "./fixtures";

/**
 * §2.12–2.13 — Household (the "Devices" route), restored from the journey
 * deleted in #762 (#750 → #781 "sharing plane ownership").
 *
 * The original 2.12 could only assert the page's heading, because the e2e
 * mock gateway did not serve the roster/owner-scope reads the route renders
 * from — the deletion commit records exactly that. The mock now mirrors the
 * real handlers (`owners-routes.ts`, `devices-routes.ts`, `scopes-routes.ts`,
 * `vault-links-routes.ts`, `edge-answer-routes.ts`,
 * `commons-recovery-routes.ts`), so these journeys prove the sharing surface
 * itself: the roster renders people-first, the owner's scope registry is the
 * vault list, and another person's seat changes PRESENTATION (grouping,
 * attribution, state word) but never AUTHORIZATION (the verb set is
 * identical — visibility on the gateway's read is the authorization
 * boundary, and the client never withholds a verb by role).
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
  // The sharing surface: one approved link to Priya, one parked ask from her
  // (D9 "ask" receive setting), and one commons whose steward is absent.
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
  gateway.state.pendingEdges = [
    pendingEdgeRecord({
      edgeId: "edge-ask-1",
      peerVaultId: "v-priya",
      localVaultId: "v-personal",
      itemType: "photos",
      itemCount: 3,
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
    await gotoNav(page, "Household");

    // The frame's app bar names the route (what the deleted 2.12 asserted) —
    // and, now that the reads are served, counts what the roster resolved:
    // 3 devices (the MacBook's two enrollments fold into one), 2 people,
    // 1 pending decision.
    // The route's current frame title is Copies; Devices is the body
    // vocabulary retained in the roster sections below.
    await expect(
      page.getByRole("heading", { name: "Copies", exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("3 devices · 2 people · 1 pending")
    ).toBeVisible();

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

    // The sharing card: the linked person's roster, the parked ask with both
    // answers offered, and the absent steward's recovery row (#750's UI).
    await expect(
      page.getByRole("heading", { name: "People & circles" })
    ).toBeVisible();
    const ask = page
      .locator("section")
      .filter({ hasText: "Waiting for your decision" });
    await expect(ask.getByText("Priya's vault shared 3 photos")).toBeVisible();
    await expect(ask.getByRole("button", { name: "Accept" })).toBeEnabled();
    await expect(ask.getByRole("button", { name: "Refuse" })).toBeEnabled();
    await expect(
      page.getByRole("heading", { name: "Shared-space recovery" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Recover from my copy" })
    ).toBeVisible();

    // Refusing the parked ask consumes it — the mock mirrors the gateway's
    // answer door (delete the pointer row, write nothing back), and the card
    // reloads to a roster without the ask.
    await ask.getByRole("button", { name: "Refuse" }).click();
    await expect(page.getByText("Priya's vault shared 3 photos")).toBeHidden();
    expect(
      gateway.countCalls("POST", (path) =>
        path.endsWith("/edges/edge-ask-1/answer")
      )
    ).toBe(1);
  } finally {
    await closeApp(app);
  }
});

test("2.13 — another person's seat changes presentation, never authorization", async () => {
  await seedRemoteGateway(env, gateway);
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, "Household");
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
