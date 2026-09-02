// THE iOS SHELL CACHE DECISION, as pure arithmetic (#915 Wave 2).
//
// The lane has three paths and one of them is new. Which one it takes is a
// four-input decision — was the native shell restored, is a shell on disk, what
// JS did that shell last carry, and what JS is this SHA — and until now the
// equivalent Android decision lived only inside a bash `if` on a runner with a
// simulator attached, which is to say nowhere a test could reach it.
//
// The paths:
//
//   BUILD     No banked shell for this native fingerprint. `expo run:ios
//             --configuration Release` compiles it (~32 minutes of the iOS
//             job's wall clock) and the lane banks it.
//   INJECT    A banked shell whose NATIVE fingerprint matches but whose JS is
//             another commit's. Re-export this SHA's bundle into the banked
//             `.app` and install that. This is the "pay packaging, not
//             compilation" path `android-emulator-install.sh` has had since
//             #905, and the reason the cache key can drop its `js` component.
//   INSTALL   A banked shell already carrying this SHA's JS. Install as-is.
//
// WHY THIS IS A SEPARATE MODULE. `ios-simulator-install.sh` needs a simulator,
// an Xcode toolchain and ~32 minutes to exercise its cold path even once, so
// the branch that decides which path to take is the half of it a unit suite can
// reach — and the half whose failure is silent. A wrong BUILD is a slow lane; a
// wrong INSTALL is a green lane that tested another commit's JavaScript.

/** The three paths, as the shell script's `$decision`. */
export const PATHS = ["build", "inject", "install"];

/**
 * Which path this run takes.
 *
 * @param {object} input the four facts the runner can observe
 * @param {boolean} input.cacheHit      the restore step reported a hit
 * @param {boolean} input.appPresent    `Centraid.app` is actually on disk
 * @param {string|undefined} input.bankedJs the `js-bundle.hash` stamped beside it
 * @param {string} input.currentJs      `js-bundle-fingerprint.mjs` for this SHA
 * @param {boolean} input.hermescPresent the banked `hermesc` is on disk
 * @returns {{path: string, why: string}} the path to take and the sentence the
 *   lane log should carry, so a rebuild always says which of the three reasons
 *   bought its thirty minutes
 */
export function decideShellPath({
  cacheHit,
  appPresent,
  bankedJs,
  currentJs,
  hermescPresent,
}) {
  if (!currentJs)
    throw new Error(
      "empty JS bundle fingerprint; refusing to install an unverifiable app"
    );
  if (!cacheHit || !appPresent)
    return {
      path: "build",
      why: cacheHit
        ? "the cache reported a hit but no Centraid.app is on disk"
        : "no shell is banked for this native fingerprint",
    };
  if (bankedJs === currentJs)
    return {
      path: "install",
      why: `the banked shell already carries this commit's JS (${currentJs})`,
    };
  if (!hermescPresent)
    // A shell banked before the injection path existed has no hermesc beside
    // it, and a plain-JS bundle in a Hermes app is NOT the artifact members
    // install — it is a different engine path with different performance, which
    // is exactly what #890 W1 moved this lane off the dev client to stop
    // measuring. Rebuild rather than inject something we cannot compile.
    return {
      path: "build",
      why:
        `the banked shell carries JS ${bankedJs ?? "<unstamped>"} and this commit is ` +
        `${currentJs}, but no banked hermesc is beside it to compile the replacement ` +
        `to bytecode. Rebuilding rather than shipping a source bundle to a Hermes app.`,
    };
  return {
    path: "inject",
    why:
      `the banked shell's native fingerprint matches and its JS is ` +
      `${bankedJs ?? "<unstamped>"}; re-exporting ${currentJs} into it`,
  };
}
