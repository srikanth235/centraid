import { fileURLToPath } from "node:url";

import { transformAsync } from "@babel/core";
import type { Plugin } from "vite";

import { nodeProject } from "@centraid/test-kit/vitest";

const REACT_NATIVE_SETUP = fileURLToPath(
  new URL("src/test/react-native-setup.ts", import.meta.url)
);
// Ordered after the RN setup on purpose: the seams below import React, which
// must not be pulled in before `react-native-setup.ts` has installed the Metro
// globals and the require transform.
const NATIVE_DEVICE_SEAMS = fileURLToPath(
  new URL("src/test/native-device-seams.ts", import.meta.url)
);
const MOBILE_ROOT = import.meta.dirname;

function transformReactNative(): Plugin {
  const nativeSource = /node_modules\/(?:react-native|@react-native\/[^/]+)\//u;
  return {
    name: "centraid:vitest-react-native",
    enforce: "pre",
    async transform(code, id) {
      if (!nativeSource.test(id) || !/\.jsx?$/u.test(id)) return null;
      const result = await transformAsync(code, {
        babelrc: false,
        configFile: false,
        filename: id,
        presets: ["babel-preset-expo"],
        sourceMaps: true,
      });
      return result?.code
        ? { code: result.code, map: result.map ?? null }
        : null;
    },
  };
}

// The RNTL tier: one consolidated file per app home screen, each paying the
// cold-renderer cost once (TESTING.md, "React Native component tests"). A file
// belongs here ONLY for claims the DOM stub cannot falsify — real RN
// role/name/state traits, the real responder tree, list windowing, and real
// `StyleSheet` flattening. Everything else stays in `@centraid/mobile`, which
// costs roughly an order of magnitude less per file (#890 W5 measured 8 RNTL
// files at ~36s against ~0.4s per stub-tier file).
//
// THESE TWO LISTS MUST STAY EACH OTHER'S EXACT COMPLEMENT, and vitest will not
// tell you when they stop being one. A file named in BOTH runs twice — once
// under the DOM stub and once under the real RN host tree — so the same
// assertions are paid for twice and a stub-tier `vi.mock("react-native")`
// silently shadows the very host tree the RNTL run exists to observe. A file
// named in NEITHER (dropped from `include` here without being dropped from the
// exclude below, or renamed on one side only) runs nowhere at all. Vitest
// reports both mistakes as a green suite, because "no test file matched" is not
// an error for a project that has other files. Hence one array, spread into
// both places, rather than two hand-kept lists.
const nativeComponentFiles = [
  "src/apps/agenda/AgendaHome.test.tsx",
  "src/apps/docs/DocsHome.test.tsx",
  "src/apps/locker/LockerHome.test.tsx",
  "src/apps/notes/NotesHome.test.tsx",
  "src/apps/people/PeopleHome.test.tsx",
  "src/apps/photos/PhotosHome.test.tsx",
  "src/apps/tally/TallyHome.test.tsx",
  "src/apps/tasks/TasksHome.test.tsx",
];

// Export the concrete projects so the repository-wide coverage configs can
// compose them directly. Vitest treats a referenced config file as one project
// and does not recursively expand that config's `test.projects` array.
export const mobileVitestProjects = [
  nodeProject({
    root: MOBILE_ROOT,
    test: {
      exclude: nativeComponentFiles,
      globals: true,
      name: "@centraid/mobile",
      include: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "scripts/**/*.test.mjs",
      ],
    },
  }),
  nodeProject({
    root: MOBILE_ROOT,
    plugins: [transformReactNative()],
    test: {
      globals: true,
      name: "@centraid/mobile-rn",
      include: nativeComponentFiles,
      pool: "threads",
      setupFiles: [REACT_NATIVE_SETUP, NATIVE_DEVICE_SEAMS],
    },
  }),
];
