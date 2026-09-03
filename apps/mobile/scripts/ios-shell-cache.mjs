export const PATHS = ["build", "inject", "install"];

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
