import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  cleanupEnv,
  clearFirstRunSample,
  closeApp,
  launchApp,
  makeEnv,
  openAppFromPalette,
  waitForHome,
} from "./fixtures";
import type { TestEnv } from "./fixtures";

// Photos north-star journey on the CUSTODIAN seat (docs/blueprint-seats.md,
// #864): a member imports a real photograph through the visible product
// control against the REAL embedded local gateway, the bytes land in this
// machine's own CAS, and both the tile and its exact bytes survive an Electron
// reload. Nothing on this path is mocked.
//
// WHAT MAKES THIS THE CUSTODIAN CELL AND NOT A SECOND ORIGIN ONE. Photos is
// byte-bearing (`apps/photos/app.json` `seats.byteBearing`), so its three seats
// differ in WHERE the bytes come to rest, not in what the screen says. The
// custodian holds them: the gateway is embedded in this process, so a write is
// settled by the time it answers — `executed`, never `queued` — and there is
// never a pending overlay on a freshly imported row. Both halves are asserted
// below, because "the tile appeared" alone is equally true of an origin seat
// whose write is still sitting in an outbox.
//
// The byte proof is made TWICE on purpose, and the two are not the same claim:
//
//   * through the app bridge's authed blob door, which proves the gateway will
//     serve exactly what was imported (the shape docs-drive.spec.ts makes);
//   * off this test's own workspace on disk, at the sha-keyed CAS path
//     `<vault>/blobs/sha256/<fan>/<sha>` that `FsBlobStore` writes (see
//     packages/vault/src/blob/local.ts `fileFor`, and the same layout named in
//     packages/server/src/backup/backup-sources.ts). The local tier is
//     PLAINTEXT — sealing is remote-tier only (packages/vault/src/blob/seal.ts)
//     — so the file's bytes are the photograph's bytes. A door that answers
//     correctly says nothing about which machine is holding the bytes; this
//     does, and holding them is what a custodian IS.
//
// `openFirstParty` and `foundDesktop` are duplicated in-file, as every desktop
// journey spec duplicates them (fixtures.ts stays the shared-mechanics module).

const PHOTO_NAME = "harbour-at-dusk.png";
// A real 4x3 PNG, small enough to inline and large enough for Chromium to
// decode — the import path grows a client thumb off that decode, so a fixture
// that is not a decodable image would exercise a different branch.
const PHOTO_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAHklEQVR42mM4YaOhUXHiwx0bOTk5BjgLKMoAZwFFASxyDuPOcNAmAAAAAElFTkSuQmCC";
const PHOTO_BYTES = Buffer.from(PHOTO_BASE64, "base64");
const PHOTO_SHA = createHash("sha256").update(PHOTO_BYTES).digest("hex");

/** One library row, as `apps/photos/queries/library.ts` joins it. */
interface LibraryAsset {
  asset_id: string;
  title?: string | null;
  content_uri?: string | null;
  byte_size?: number | null;
  favorite?: number | null;
}

async function openFirstParty(page: Page, name: string): Promise<void> {
  await openAppFromPalette(page, name);
  await expect(page.getByTestId("inline-app-view")).toBeVisible();
  await expect(page.getByText(`Loading ${name}…`, { exact: true })).toHaveCount(
    0
  );
  await expect
    .poll(() => page.evaluate(() => Boolean(window.centraid)))
    .toBe(true);
}

async function foundDesktop(page: Page): Promise<void> {
  await page
    .getByTestId("first-run-choice")
    .getByRole("button", { name: /start fresh on this mac/iu })
    .click();
  // Fresh/local setup connects and founds Personal directly. Profile identity
  // is optional and belongs in Settings, so this journey waits for the
  // streamlined onboarding hand-off rather than resurrecting the removed name
  // gate.
  const onboarding = page.getByTestId("onboarding-view");
  await onboarding.waitFor({ state: "visible" });
  await expect(page.getByRole("textbox", { name: "Your name" })).toHaveCount(0);
  await onboarding.waitFor({ state: "detached", timeout: 60_000 });
  await waitForHome(page);
  // Auto-seed is the first-run product path; the Photos replica stays busy
  // while sample photographs land. Clear through Home so the write rail is
  // actually idle before this journey's readiness probe.
  await clearFirstRunSample(page);
}

/**
 * The bytes this machine is holding under `sha`, or null while it holds none.
 * The vault directory's own name is the gateway's business, so the CAS file is
 * found by its sha-keyed suffix anywhere under the test's disposable
 * workspace rather than by a path this test reconstructs.
 */
async function localCasBytes(
  env: TestEnv,
  sha: string
): Promise<Buffer | null> {
  const suffix = path.join("blobs", "sha256", sha.slice(0, 2), sha);
  const entries = await readdir(env.workspace, { recursive: true }).catch(
    () => [] as string[]
  );
  const hit = entries.find((entry) => entry.endsWith(suffix));
  return hit ? readFile(path.join(env.workspace, hit)) : null;
}

test("Photos imports a real photograph and its bytes stay on this machine", async () => {
  test.setTimeout(300_000);
  const env = await makeEnv();
  const { app, page } = await launchApp(env);
  try {
    await foundDesktop(page);
    await openFirstParty(page, "Photos");

    // The inline replica session bootstraps asynchronously; prove the write
    // rail is up with a probe the vault deterministically REFUSES (there is no
    // such asset) before driving the one-shot UI import.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            try {
              const outcome = await window.centraid.write({
                action: "update-asset",
                input: {
                  asset_id: "asset-e2e-readiness-probe",
                  title: "readiness-probe",
                },
                intentId: "photos-e2e-readiness-probe",
              });
              return outcome.status;
            } catch {
              return "replica-not-ready";
            }
          }),
        { timeout: 60_000 }
      )
      .not.toBe("replica-not-ready");

    // Import through the product's own control: the hidden file input that the
    // app bar's Import button and the page-wide drop target both drive
    // (apps/photos/upload.ts `wireUpload`). Blob staging, the client preview
    // rungs and `media.add_asset` all run for real.
    await page
      .getByTestId("inline-app-view")
      .locator("#fileInput")
      .setInputFiles({
        name: PHOTO_NAME,
        mimeType: "image/png",
        buffer: PHOTO_BYTES,
      });

    // The tile, by the name the member gave the file — the timeline's own row,
    // not a toast about one.
    const tile = page
      .getByRole("button", { name: PHOTO_NAME, exact: true })
      .first();
    await expect(tile).toBeVisible({ timeout: 30_000 });

    // CUSTODIAN, HALF ONE: the write settled before it answered, so the row
    // carries no pending overlay. An origin seat's queued import would paint a
    // chip here (apps/_shared/PendingWriteActions.tsx).
    await expect(page.locator(".kit-pending-chip")).toHaveCount(0);

    // CUSTODIAN, HALF TWO: this machine is holding the bytes. The CAS file
    // appears as part of claiming the staged sha, so it is polled rather than
    // read once — the tile above is drawn from the command's own answer.
    await expect
      .poll(async () => (await localCasBytes(env, PHOTO_SHA))?.length ?? 0, {
        timeout: 30_000,
      })
      .toBe(PHOTO_BYTES.length);
    const onDisk = await localCasBytes(env, PHOTO_SHA);
    expect(onDisk?.toString("base64")).toBe(PHOTO_BASE64);

    // The photograph is a vault row on the local gateway, not renderer state:
    // it must come back after a full Electron reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Photos");
    await expect(
      page.getByRole("button", { name: PHOTO_NAME, exact: true }).first()
    ).toBeVisible({ timeout: 30_000 });

    const library = await page.evaluate(() =>
      window.centraid.read<{ assets: LibraryAsset[] }>({
        query: "library",
        input: {},
      })
    );
    const imported = library.assets.filter(
      (asset: LibraryAsset) => asset.title === PHOTO_NAME
    );
    // Exactly one photograph: identical bytes collapse onto one asset, so the
    // import path must not have minted two.
    expect(imported).toHaveLength(1);
    expect(imported[0]!.byte_size).toBe(PHOTO_BYTES.length);
    const contentUri = imported[0]!.content_uri;
    expect(contentUri).toEqual(expect.any(String));

    // Byte-bearing proof through the door a member's own screen uses: the
    // exact imported bytes come back on demand, after the reload.
    const roundTrip = await page.evaluate(async (uri) => {
      const toBase64 = (bytes: Uint8Array): string => {
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      };
      if (uri.startsWith("data:")) {
        const comma = uri.indexOf(",");
        const meta = uri.slice(0, comma);
        const payload = uri.slice(comma + 1);
        return meta.includes("base64")
          ? payload
          : toBase64(new TextEncoder().encode(decodeURIComponent(payload)));
      }
      // The same bearer transport the desktop gateway client uses.
      const { baseUrl, token } = await window.CentraidApi.getGatewayAuth();
      const response = await fetch(new URL(uri, baseUrl).toString(), {
        headers: { authorization: `Bearer ${token}` },
      });
      return toBase64(new Uint8Array(await response.arrayBuffer()));
    }, contentUri!);
    expect(roundTrip).toBe(PHOTO_BASE64);

    // CUSTODIAN, HALF ONE again — this time on a write the test fires itself,
    // so the status is read directly rather than inferred from the absence of
    // a chip. A held gateway settles in the call; it never answers `queued`.
    const favorited = await page.evaluate(
      async (assetId) =>
        window.centraid.write({
          action: "update-asset",
          // `favorite` is the schema's 0/1 integer, not a boolean — the action
          // declares `enum: [0, 1]` and refuses anything else.
          input: { asset_id: assetId, favorite: 1 },
          intentId: "photos-e2e-favorite",
        }),
      imported[0]!.asset_id
    );
    expect(favorited.status).toBe("executed");

    // THE STAR SURVIVED LOSING ITS COLUMN (#916, ONT-star). `media_asset`
    // carried a mirrored `favorite` column; the star is a flags-scheme tag on
    // the asset now, the same scheme Docs, Locker and People read. The write
    // above still speaks the action's 0/1 integer, so what has to be proved is
    // that the READ still answers with it — the grid derives the heart from a
    // `core.tag` row now, and a member who stars a photo must see it stay
    // starred across a reload rather than silently losing the flag with the
    // column. Reading through the real library projection is the whole point:
    // a unit test on the tag row would pass even if nothing reached the grid.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Photos");
    const afterStar = await page.evaluate(() =>
      window.centraid.read<{ assets: LibraryAsset[] }>({
        query: "library",
        input: {},
      })
    );
    const starred = afterStar.assets.find(
      (asset: LibraryAsset) => asset.asset_id === imported[0]!.asset_id
    );
    expect(starred?.favorite).toBe(1);

    const evidenceDir = path.join(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "issue-864-photos-custodian.png"),
      fullPage: true,
    });
    // The #916 UI-impact frame: the starred photograph in the grid, drawn from
    // the tag rather than the dropped column.
    await page.screenshot({
      path: path.join(evidenceDir, "issue-916-photos-star.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
    await cleanupEnv(env);
  }
});
