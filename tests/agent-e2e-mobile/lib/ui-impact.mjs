// Publishing a Maestro frame as UI-impact evidence.
//
// `scripts/validate-ui-receipt.mjs` accepts a screenshot named in a receipt
// only when a CHANGED e2e harness emits it under `artifacts/e2e/ui-impact/`, so
// a mobile surface change owes a frame from the flow that draws it. Maestro's
// `takeScreenshot: <name>` lands at `runs/<run>/screenshots/<name>.png` —
// unprefixed, because harness.mjs runs every chunk with `cwd` set there — and
// this copies one of those out to the published path.
//
// PUBLISHING IS NOT ASSERTING. A failed copy is the caller's note, never a
// second reason for a journey to go red: the flow's verdict is about the claims
// it made, and a file copy is not one of them. Every caller wraps it.

import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

/** Where every seat's UI-impact frames are published. */
export const UI_IMPACT_DIR = "artifacts/e2e/ui-impact";

/**
 * Copy `<captured>.png` out of this run's screenshot directory to
 * `artifacts/e2e/ui-impact/<published>`. Throws when the frame is absent —
 * a missing frame means the chunk that was supposed to draw it did not run,
 * which the caller notes rather than swallows silently.
 */
export async function screenshot(ctx, captured, published) {
  const frames = await readdir(ctx.state.screenshotsDir);
  const frame = frames.find((candidate) => candidate === `${captured}.png`);
  if (frame === undefined)
    throw new Error(`${captured} frame was not captured`);
  await mkdir(UI_IMPACT_DIR, { recursive: true });
  await copyFile(
    path.join(ctx.state.screenshotsDir, frame),
    path.join(UI_IMPACT_DIR, published)
  );
}
