import path from "node:path";

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
  resolve: {
    alias: {
      // The shipped change feed imports the phone's streaming fetch at module
      // load; `expo/fetch` resolves a React Native runtime module a Node
      // process cannot require. `lib/expo-fetch.ts` says what this stands in
      // for (#1014, T11).
      "expo/fetch": path.join(import.meta.dirname, "lib/expo-fetch.ts"),
    },
  },
  test: {
    name: "@centraid/mobile-integration",
    include: ["**/*.integration.test.ts"],
    // Every file in this tier boots its own gateway process and its own vault
    // on disk. Running them in parallel contends for exactly the fsync budget
    // the shared 30 s node timeout is sized against.
    fileParallelism: false,
  },
});
