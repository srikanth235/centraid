import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, expect, test } from "@playwright/test";
import type { BrowserContext, Worker } from "@playwright/test";

/*
 * THE COMPANION, IN A REAL BROWSER, OVER A REAL NATIVE PORT (#1020 wave 4 lane
 * extension — the lane's exit criterion).
 *
 * Chromium loads the **unpacked build** (`extension/scripts/build.mjs`), a
 * native-messaging host manifest is written into the profile's own
 * `NativeMessagingHosts/` directory with the id Chromium derived, and the host it
 * names is `fake-native-host.mjs` — a node script speaking the browser's own
 * framing.
 *
 * ## Why a fake host here and the real one elsewhere
 *
 * What this run is about is the BROWSER half: that the manifest loads with
 * `nativeMessaging` and no host permissions, that `connectNative` reaches a host
 * launched by Chromium itself, that a fill's material reaches the page and does
 * not survive in the worker, that a 3 MB capture leaves as frames that fit. None
 * of that needs a vault, and giving it one would make the run depend on founding,
 * keys and a seat to prove something about a browser.
 *
 * The host's own half — the eighteen methods against a real seat, the closed
 * enum, the fill reaching the seat's reveal path, the staging assembler — is
 * `crates/centraid/tests/native_host.rs`, which drives the SAME framing against
 * `centraid native-host`. Between them there is no gap: one proves the browser
 * speaks it, the other proves the host answers it.
 *
 * Real Chrome / Firefox registration on a member's machine is an owner hand-off
 * with the command, in `extension/README.md`.
 */

const REPO = path.resolve(import.meta.dirname, "../..");

/** A login form, served by route interception so the origin is real. */
const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Bank</title></head>
<body><form>
  <label>Username <input name="username" type="text" autocomplete="username"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Sign in</button>
</form></body></html>`;

/**
 * The Chromium to drive.
 *
 * Playwright's own `executablePath()` names the revision its version rolls to;
 * a machine provisioned with a slightly older one (this container has
 * `chromium-1194` under `PLAYWRIGHT_BROWSERS_PATH` and Playwright 1.62 wants
 * 1234) would otherwise fail with "Executable doesn't exist" and a suggestion to
 * download one. The fallback picks the newest full Chromium actually present —
 * **never the headless shell**, which cannot load an extension at all — so this
 * run works on a provisioned box and on a fresh `playwright install` alike.
 */
function chromiumPath(): string | undefined {
  const rolled = chromium.executablePath();
  if (existsSync(rolled)) return undefined;
  const root = process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? "";
  if (!root || !existsSync(root)) return undefined;
  return readdirSync(root)
    .filter((entry) => /^chromium-\d+$/u.test(entry))
    .sort()
    .toReversed()
    .flatMap((entry) =>
      ["chrome-linux64/chrome", "chrome-linux/chrome"].map((leaf) =>
        path.join(root, entry, leaf)
      )
    )
    .find((candidate) => existsSync(candidate));
}

interface Harness {
  readonly context: BrowserContext;
  readonly worker: Worker;
  readonly extensionId: string;
  readonly log: string;
}

async function launch(): Promise<Harness> {
  const work = mkdtempSync(path.join(os.tmpdir(), "centraid-companion-"));
  const unpacked = path.join(work, "unpacked");
  const profile = path.join(work, "profile");
  const log = path.join(work, "frames.jsonl");
  writeFileSync(log, "");

  execFileSync(
    "node",
    [
      path.join(REPO, "extension/scripts/build.mjs"),
      "--browser",
      "chrome",
      "--out",
      unpacked,
    ],
    { stdio: "inherit" }
  );

  const context = await chromium.launchPersistentContext(profile, {
    // EXTENSIONS NEED A REAL BROWSER, not the headless shell: the shell cannot
    // load an extension at all and fails with an empty worker list rather than
    // an error. Playwright's bundled Chromium is the full build, so `headless:
    // false` under Xvfb is the combination that works here — which is why the
    // gate step runs this under `xvfb-run` and says so.
    headless: false,
    ...(chromiumPath() ? { executablePath: chromiumPath()! } : {}),
    args: [
      `--disable-extensions-except=${unpacked}`,
      `--load-extension=${unpacked}`,
    ],
  });

  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;

  // THE HOST MANIFEST, WITH THE ID CHROMIUM DERIVED. Written into the profile's
  // own `NativeMessagingHosts/` directory, which is where a Chromium started
  // with `--user-data-dir` looks — the same shape
  // `centraid native-host install --browser chrome --extension-id <id>` writes,
  // and the same allowlist rule: this manifest admits exactly one extension.
  const hosts = path.join(profile, "NativeMessagingHosts");
  mkdirSync(hosts, { recursive: true });
  const shim = path.join(work, "host.sh");
  writeFileSync(
    shim,
    `#!/bin/sh\nexec env CENTRAID_FAKE_HOST_LOG=${log} node ${path.join(REPO, "extension/e2e/fake-native-host.mjs")}\n`,
    { mode: 0o755 }
  );
  writeFileSync(
    path.join(hosts, "dev.centraid.host.json"),
    `${JSON.stringify(
      {
        name: "dev.centraid.host",
        description:
          "Centraid — the vault's native-messaging host (fake, for the e2e)",
        path: shim,
        type: "stdio",
        allowed_origins: [`chrome-extension://${extensionId}/`],
      },
      null,
      2
    )}\n`
  );
  return { context, worker, extensionId, log };
}

/** Frames the fake host recorded, newest last. */
function frames(log: string): Record<string, unknown>[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test.describe("the Companion over native messaging", () => {
  test("answers four methods, fills a page and stages a large capture", async () => {
    const harness = await launch();
    const { context, extensionId, log } = harness;
    try {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);

      // 1. `status` — the extension's first screen, answered by the host it
      //    reached rather than by a network it has no permission for.
      const status = await page.evaluate(async () =>
        (
          globalThis as unknown as {
            chrome: {
              runtime: { sendMessage: (m: unknown) => Promise<unknown> };
            };
          }
        ).chrome.runtime.sendMessage({ type: "status" })
      );
      expect(status).toMatchObject({ ok: true, value: { paired: true } });

      // 2 and 3. `locker:candidates` and `locker:fill`, THROUGH THE CONTENT
      //    SCRIPT ON A REAL PAGE — because a popup cannot ask a Locker question
      //    and must not be able to: every `locker:*` message is judged against
      //    the active tab's own origin (v0's `assertTopFramePage`), and a popup
      //    has no tab. The page is served by route interception, so it is a real
      //    `https://www.bank.example` origin to Chromium and the content script
      //    matches it.
      //
      //    Every click here is a PLAYWRIGHT click, which produces a trusted
      //    event — the only kind `isTrustedCredentialGesture` admits. A test
      //    that dispatched its own `click` would be testing the path a page can
      //    take, and that path is refused.
      await context.route("https://www.bank.example/**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: LOGIN_PAGE,
        });
      });
      await context.route(
        "https://bank.example.attacker.test/**",
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: LOGIN_PAGE,
          });
        }
      );

      const site = await context.newPage();
      await site.goto("https://www.bank.example/sign-in");
      await site.click("input[type=password]");
      // `PICKER_ID`, as a literal: the e2e is compiled by Playwright and the
      // extension's sources are compiled by `tsconfig.build.json`, so importing
      // across the two would pull the shipped tree into this project's graph.
      const picker = site.locator("#centraid-companion-picker");
      await expect(picker).toHaveAttribute("data-count", "1");
      // The button is in an OPEN shadow root, which Playwright pierces.
      await picker.locator("button[data-item-id='item-1']").click();
      // THE PASSWORD IS IN THE FIELD, which is the journey's own assertion.
      await expect(site.locator("input[type=password]")).toHaveValue(
        "hunter2-and-more"
      );
      await expect(site.locator("input[name=username]")).toHaveValue(
        "someone@example.test"
      );

      // A WRONG SITE OFFERS NOTHING. The host filters over the promoted spec and
      // the seat would refuse anyway; the member sees no picker rather than a
      // picker that then fails.
      const wrong = await context.newPage();
      await wrong.goto("https://bank.example.attacker.test/sign-in");
      await wrong.click("input[type=password]");
      await wrong.waitForTimeout(1000);
      await expect(wrong.locator("#centraid-companion-picker")).toHaveCount(0);
      await wrong.close();
      await site.close();

      // 4. `capture:document` with a 3 MB screenshot — STAGED, in frames that
      //    each fit under the browser's 1 MiB ceiling.
      const captured = (await page.evaluate(async () => {
        const bytes = new Uint8Array(3 * 1024 * 1024);
        for (let at = 0; at < bytes.length; at += 1) bytes[at] = at % 251;
        let binary = "";
        for (let at = 0; at < bytes.length; at += 32 * 1024) {
          binary += String.fromCharCode(...bytes.subarray(at, at + 32 * 1024));
        }
        return await (
          globalThis as unknown as {
            chrome: {
              runtime: { sendMessage: (m: unknown) => Promise<unknown> };
            };
          }
        ).chrome.runtime.sendMessage({
          type: "capture:document",
          capture: { title: "A Page", url: "https://example.test/a" },
          screenshot: `data:image/png;base64,${btoa(binary)}`,
        });
      })) as { ok: boolean };
      expect(captured.ok).toBe(true);

      const sent = frames(log);
      const kinds = sent.map((frame) => frame["t"]);
      // THE TRANSCRIPT, which is the lane's exit evidence.
      expect(kinds).toContain("status");
      expect(kinds).toContain("locker:candidates");
      expect(kinds).toContain("locker:fill");
      expect(kinds).toContain("stage:begin");
      expect(kinds.filter((kind) => kind === "stage:chunk")).toHaveLength(6);
      expect(kinds).toContain("stage:end");
      // AND THE BYTES DID NOT RIDE THE METHOD FRAME: the `capture:document`
      // that followed carries a sha, not a screenshot.
      const document = sent.findLast(
        (frame) => frame["t"] === "capture:document"
      );
      expect(document).toBeDefined();
      expect(document).not.toHaveProperty("screenshot_bytes");
      // THE HANDLE IS THE BYTES, and the extension computed it: the digest the
      // method frame carries is the sha256 of the payload the test built, so a
      // chunker that dropped or reordered a window would not agree with it.
      expect(document?.["staged_sha"]).toBe(
        createHash("sha256")
          .update(
            Uint8Array.from({ length: 3 * 1024 * 1024 }, (_, at) => at % 251)
          )
          .digest("hex")
      );
      // EVERY CHUNK FITS. The chunk log records the base64 length, and the
      // browser's ceiling is on the whole message.
      for (const frame of sent.filter((one) => one["t"] === "stage:chunk")) {
        expect(frame["chunk_bytes"]).toBeLessThan(1024 * 1024);
      }
    } finally {
      await harness.context.close();
    }
  });

  test("asks for no host permissions and a method it does not know is refused", async () => {
    const harness = await launch();
    const { context, extensionId } = harness;
    try {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      // THE MANIFEST THE BROWSER ACTUALLY LOADED, not the file on disk.
      const manifest = (await page.evaluate(() =>
        (
          globalThis as unknown as {
            chrome: { runtime: { getManifest: () => unknown } };
          }
        ).chrome.runtime.getManifest()
      )) as { permissions?: string[]; host_permissions?: string[] };
      expect(manifest.permissions).toContain("nativeMessaging");
      expect(manifest.host_permissions).toBeUndefined();

      const unknown = (await page.evaluate(async () =>
        (
          globalThis as unknown as {
            chrome: {
              runtime: { sendMessage: (m: unknown) => Promise<unknown> };
            };
          }
        ).chrome.runtime.sendMessage({ type: "vault:sql" })
      )) as { ok: boolean; error?: string };
      expect(unknown.ok).toBe(false);
      expect(unknown.error).toMatch(/different versions/u);
    } finally {
      await harness.context.close();
    }
  });
});
