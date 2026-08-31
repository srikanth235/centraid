import { nodeProject } from "@centraid/test-kit/vitest";

// The Node integration tier for the mobile app × state grid (#890 W3).
//
// `root` is pinned to this directory because Vitest resolves `include` against
// the project root, and the root defaults to the CWD rather than to the config
// file's own folder: run from the repo root, a bare `**/*.integration.test.ts`
// collected every integration file in the monorepo and reported them under this
// project's name.
export default nodeProject({
  root: import.meta.dirname,
  test: {
    name: "@centraid/mobile-integration",
    include: ["**/*.integration.test.ts"],
    // Every file in this tier boots its own gateway process and its own vault
    // on disk. Running them in parallel contends for exactly the fsync budget
    // the shared 30 s node timeout is sized against.
    fileParallelism: false,
  },
});
