import { defineConfig } from "vitest/config";

/*
 * The desktop seat's own vitest project (#1020 wave 3 lane F).
 *
 * One project over the desktop's two halves — `electron/` (main + preload) and
 * `renderer/` — plus `extension/`, because the pure cores are shared across
 * those boundaries and a test that imports one from the other must resolve it
 * the same way the build does. The Companion is here rather than in its own
 * project for the same reason: it is one more consumer of the same seat, and a
 * second runner over three files would be a second thing to keep green.
 *
 * `desktop/electron/package.json` passes this file to vitest as an ABSOLUTE
 * path (`--config "$PWD/../vitest.config.ts"`), and that is not decoration: a
 * relative `../vitest.config.ts` is resolved by vitest against the project root
 * it infers rather than against the shell's cwd, so it lands on the
 * repository's own `vitest.config.ts` — whose `projects` list then resolves
 * against the wrong directory and fails with "Projects definition references a
 * non-existing file". An absolute path has one meaning.
 *
 * Deliberately NOT a member of the repository-wide `vitest.config.ts` project
 * list: that list drives the v0 coverage run scored against
 * `tests/floors.json`, and adding a new tree to it would move coverage numbers
 * for reasons that have nothing to do with the v0 oracle it measures. The v1
 * gate entrypoint is `cargo xtask gate`, which runs this config by name — see
 * `contracts/handoff/F/desktop-e2e.md`.
 */
export default defineConfig({
  test: {
    name: "desktop-seat",
    root: import.meta.dirname,
    include: [
      "electron/src/**/*.test.ts",
      "renderer/src/**/*.test.ts",
      "../extension/src/**/*.test.ts",
    ],
    environment: "node",
    // One worker: the sidecar tests spawn a real child process against a real
    // socket path, and two of those at once would race the path.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20_000,
  },
});
