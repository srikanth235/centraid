#!/usr/bin/env bun
// Whether `design:gallery` has a browser to photograph with (#931 item 3).
//
// TWO CLAIMS, TWO VERDICTS — the ruling #668 already made for
// `lint:node-version`, applied to the same shape. "The committed baselines match
// the product" is a fact about the TREE: deterministic, identical on every
// machine, and a genuine gate. "A pinned Chromium is installed here" is a fact
// about the MACHINE. Fusing them made the second one fatal, so `check:push` was
// red in every container that had not run `playwright install` — and a gate that
// only ever fails for a reason unrelated to your diff is the one that teaches
// people `--no-verify`. Under `CI` a missing browser means the workflow is
// genuinely misconfigured, so there it stays fatal.
//
// It lives beside `design-gallery.mjs` rather than inside it because that file
// is already at the repo's file-size ceiling, and because a decision this small
// and this consequential is easier to read on its own.
import { existsSync } from "node:fs";

/**
 * An operator-supplied Chromium, honoured before the pinned download is looked
 * for.
 *
 * Playwright's own `PLAYWRIGHT_BROWSERS_PATH` already redirects the whole
 * browsers directory and needs no code here; this is the narrower case a
 * container hits, where a Chromium IS installed but at a build number the
 * pinned Playwright did not ask for.
 */
export const CHROMIUM_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "";

export const IS_CI = process.env.CI === "true" || process.env.CI === "1";

/**
 * Is the browser this gate needs actually on the machine?
 *
 * @param {{executablePath: () => string}} chromium Playwright's chromium handle.
 * @param {(p: string) => boolean} [exists] Existence probe (injected by the tests).
 * @returns {string|null} The reason it cannot run, or null when it can.
 */
export function browserUnavailable(chromium, exists = existsSync) {
  if (CHROMIUM_PATH) {
    return exists(CHROMIUM_PATH)
      ? null
      : `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH points at ${CHROMIUM_PATH}, which does not exist`;
  }
  const pinned = chromium.executablePath();
  return exists(pinned)
    ? null
    : `the pinned Playwright Chromium is not installed (${pinned})`;
}

/**
 * What to say and what to exit with when the browser is missing.
 *
 * @param {{executablePath: () => string}} chromium Playwright's chromium handle.
 * @param {{exists?: (p: string) => boolean, isCi?: boolean}} [options] Injected by the tests.
 * @returns {{fatal: boolean, message: string}|null} Null when the gate can run.
 */
export function unrunnableVerdict(chromium, options = {}) {
  const reason = browserUnavailable(chromium, options.exists ?? existsSync);
  if (!reason) return null;
  const fatal = options.isCi ?? IS_CI;
  return {
    fatal,
    message: fatal
      ? `::error title=design:gallery unrunnable::${reason}. Under CI a missing browser means the workflow is misconfigured, not that the gate is optional.`
      : `design:gallery: SKIPPED — ${reason}. Install it with \`bunx playwright install chromium\`, or point PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH at a Chromium you already have. CI runs this lane for real, where the baselines are enforced.`,
  };
}

/** The launch options, carrying an operator-supplied executable when there is one. */
export function launchOptions() {
  return {
    headless: true,
    ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
  };
}
