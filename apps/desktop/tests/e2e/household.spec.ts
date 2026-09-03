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

let env: TestEnv;
let gateway: MockGateway;

test.beforeEach(async () => {
  env = await makeEnv();
  gateway = await startMockGateway();

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
  gateway.state.scopes = [
    scopeRowRecord({
      vaultId: "v-personal",
      label: "Personal",
      personal: true,
    }),
    scopeRowRecord({ vaultId: "v-shared", label: "Shared" }),
  ];
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

    await expect(
      page.getByRole("heading", { name: "Yours", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Other people", exact: true })
    ).toBeVisible();
    await expect(row(page, "Ada's MacBook")).toBeVisible();
    await expect(row(page, "Ada's phone")).toBeVisible();
    await expect(row(page, "Sam's laptop")).toBeVisible();

    await expect(
      page.getByRole("heading", { name: "Vaults you own", exact: true })
    ).toBeVisible();
    await expect(row(page, "Personal")).toBeVisible();
    await expect(row(page, "Shared")).toBeVisible();
    await expect(
      row(page, "Personal").getByText("You own this vault.")
    ).toBeVisible();

    const sharingHead = page.getByRole("heading", { name: "People & circles" });
    await expect(sharingHead).toBeVisible();
    const sharingPanel = sharingHead.locator("xpath=ancestor::section[1]");
    await expect(
      sharingPanel.getByRole("heading", { name: "Link with someone" })
    ).toBeVisible();
    await expect(
      sharingPanel.getByRole("heading", { name: "People", exact: true })
    ).toBeVisible();

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

    const mac = row(page, "Ada's MacBook");
    const sam = row(page, "Sam's laptop");
    await expect(mac.getByText("This device").first()).toBeVisible();
    await expect(sam.getByText("Other person")).toBeVisible();
    await expect(sam.getByText(/Sam · /u)).toBeVisible();

    await mac.getByRole("button", { name: "Manage" }).click();
    await expect(
      mac.getByRole("button", { name: "Revoke device" })
    ).toBeVisible();
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
