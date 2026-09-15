/*
 * THE EXIT CRITERION (#1020 wave 3 lane F): **video plays and seeks from a
 * blob still arriving**.
 *
 * A real Electron app, a real `centraid seat` sidecar over a real 0600 socket,
 * a real `<video>` element whose `src` is `centraid://blob/<digest>`, and a
 * real blob whose bytes are landing on disk while the test watches. What is
 * asserted is the thing that is hard: `currentTime` advances after a seek past
 * the prefix that had arrived when the seek was made.
 *
 * Everything the sidecar does underneath is proven at its own layer
 * (`crates/centraid/tests/seat_socket.rs`) and everything the shell computes is
 * proven in its own unit suite; this file exists because neither of those can
 * tell you whether Chromium's media stack accepts the answers.
 */

import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

import {
  centraidBinary,
  foundVault,
  makeDataDir,
  REPO,
  startArrivingBlob,
  videoFixture,
} from "./fixture.mjs";

let app: ElectronApplication;
let page: Page;
let arriving: ReturnType<typeof startArrivingBlob>;
let dataDir: string;
const fixture = videoFixture();

test.beforeAll(async () => {
  dataDir = makeDataDir("media");
  await foundVault(dataDir);
  // The prefix is a fifth of the file when the window opens and the rest lands
  // at about 32 KiB a second, so a seek to 70% of the duration is a seek into
  // bytes that do not exist yet — by construction rather than by luck.
  arriving = startArrivingBlob(dataDir, fixture);

  app = await electron.launch({
    args: [path.join(REPO, "desktop/e2e/electron-entry.mjs"), "--no-sandbox"],
    env: {
      ...process.env,
      CENTRAID_BINARY: centraidBinary(),
      CENTRAID_DATA_DIR: dataDir,
      CENTRAID_SEAT_SOCKET: path.join(dataDir, "seat.sock"),
      CENTRAID_E2E_BLOB: fixture.sha256,
    },
  });
  page = await app.firstWindow();
  page.on("console", (message) => {
    process.stdout.write(`[renderer] ${message.text()}\n`);
  });
});

test.afterAll(async () => {
  arriving?.stop();
  await app?.close();
});

test("the seat attaches and reports its four states", async () => {
  await expect(page.getByTestId("state-mode")).toHaveText("replicated");
  await expect(page.getByTestId("state-availability")).toHaveText("local");
  // No gateway has been chosen, which is `unconfigured` and NOT `offline`: the
  // member has nothing to go looking for.
  await expect(page.getByTestId("state-connectivity")).toHaveText(
    "unconfigured"
  );
  await expect(page.getByTestId("state-durability-sentence")).toBeVisible();
});

test("a blob still arriving plays, and seeking past the prefix still plays", async () => {
  const received = arriving.received();
  expect(received).toBeLessThan(fixture.byte_size);

  // A `<video>` built in the page, so this test does not depend on the library
  // screen having a row for this blob — the door is what is under test.
  await page.evaluate((digest) => {
    const video = document.createElement("video");
    video.id = "under-test";
    video.src = `centraid://blob/${digest}`;
    video.preload = "auto";
    video.muted = true;
    document.body.append(video);
  }, fixture.sha256);

  const locator = page.locator("#under-test");

  // 1. METADATA. Only the header has arrived, and it is enough: the seat parsed
  //    the `Range` against the DECLARED total, so the element learns the real
  //    duration of a file that is a fifth present.
  await expect
    .poll(
      async () => locator.evaluate((node: HTMLVideoElement) => node.readyState),
      {
        timeout: 30_000,
      }
    )
    .toBeGreaterThanOrEqual(1);
  const duration = await locator.evaluate(
    (node: HTMLVideoElement) => node.duration
  );
  expect(duration).toBeGreaterThan(5);
  expect(Math.abs(duration - fixture.duration_seconds)).toBeLessThan(2);

  // 2. PLAY from the start, out of the prefix.
  await locator.evaluate(async (node: HTMLVideoElement) => {
    await node.play();
  });
  await expect
    .poll(
      async () =>
        locator.evaluate((node: HTMLVideoElement) => node.currentTime),
      { timeout: 20_000 }
    )
    .toBeGreaterThan(0.2);

  // 3. THE SEEK. 70% of the duration, which is past the byte prefix that had
  //    arrived when this test began — the seat waits on the writer and answers
  //    with what has landed rather than a 416.
  const target = duration * 0.7;
  const arrivedBeforeSeek = arriving.received();
  expect(arrivedBeforeSeek).toBeLessThan(fixture.byte_size);
  await locator.evaluate((node: HTMLVideoElement, at) => {
    node.currentTime = at;
  }, target);
  await expect
    .poll(
      async () =>
        locator.evaluate((node: HTMLVideoElement) => ({
          seeking: node.seeking,
          currentTime: node.currentTime,
        })),
      { timeout: 60_000 }
    )
    .toMatchObject({ seeking: false });

  const afterSeek = await locator.evaluate(
    (node: HTMLVideoElement) => node.currentTime
  );
  expect(afterSeek).toBeGreaterThan(duration * 0.5);

  // 4. **THE ASSERTION THE EXIT CRITERION NAMES**: `currentTime` advances from
  //    the seek target. Playback resumed from bytes that were not on disk when
  //    the seek was issued.
  await locator.evaluate(async (node: HTMLVideoElement) => {
    await node.play();
  });
  await expect
    .poll(
      async () =>
        locator.evaluate((node: HTMLVideoElement) => node.currentTime),
      { timeout: 60_000 }
    )
    .toBeGreaterThan(afterSeek + 0.05);

  // And nothing errored on the element: a `MediaError` would mean the door
  // answered something the media stack could not use.
  expect(
    await locator.evaluate((node: HTMLVideoElement) => node.error?.code ?? null)
  ).toBeNull();
});

test("the door refuses what it must, and serves what it must", async () => {
  const probe = async (url: string, init?: RequestInit) =>
    page.evaluate(
      async ([target, options]) => {
        const response = await fetch(target as string, options as RequestInit);
        return {
          status: response.status,
          contentRange: response.headers.get("content-range"),
          disposition: response.headers.get("content-disposition"),
          nosniff: response.headers.get("x-content-type-options"),
          csp: response.headers.get("content-security-policy"),
          acceptRanges: response.headers.get("accept-ranges"),
          type: response.headers.get("content-type"),
        };
      },
      [url, init ?? {}] as const
    );

  // A malformed digest never reaches the seat.
  expect((await probe("centraid://blob/not-a-digest")).status).toBe(400);
  // A blob nobody has is a 404, never an empty 200.
  expect((await probe(`centraid://blob/${"9".repeat(64)}`)).status).toBe(404);

  // A range inside the prefix: 206, with the DECLARED total in Content-Range.
  const ranged = await probe(`centraid://blob/${fixture.sha256}`, {
    headers: { Range: "bytes=0-99" },
  });
  expect(ranged.status).toBe(206);
  expect(ranged.contentRange).toBe(`bytes 0-99/${fixture.byte_size}`);
  expect(ranged.acceptRanges).toBe("bytes");
  expect(ranged.nosniff).toBe("nosniff");
  expect(ranged.csp).toBe("sandbox");
  expect(ranged.type).toBe("video/webm");
  expect(ranged.disposition).toMatch(/^inline;/u);

  // A range past the DECLARED total is the one 416.
  const past = await probe(`centraid://blob/${fixture.sha256}`, {
    headers: {
      Range: `bytes=${fixture.byte_size + 10}-${fixture.byte_size + 20}`,
    },
  });
  expect(past.status).toBe(416);
  expect(past.contentRange).toBe(`bytes */${fixture.byte_size}`);

  // `?download=1` forces an attachment even for a type that may go inline.
  expect(
    (await probe(`centraid://blob/${fixture.sha256}?download=1`)).disposition
  ).toMatch(/^attachment;/u);
});

test("the whole blob lands and is then served as complete", async () => {
  await arriving.finished;
  const answer = await page.evaluate(async (digest) => {
    const response = await fetch(`centraid://blob/${digest}`, {
      headers: { Range: "bytes=0-0" },
    });
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      etag: response.headers.get("etag"),
    };
  }, fixture.sha256);
  expect(answer.status).toBe(206);
  // ONLY ONCE COMPLETE: a prefix answered `immutable` is a truncated video
  // cached forever.
  expect(answer.cache).toBe("private, max-age=31536000, immutable");
  expect(answer.etag).toBe(`"${fixture.sha256}"`);
});
