import { fileURLToPath } from "node:url";

import { transformAsync } from "@babel/core";
import type { Plugin } from "vite";

import { nodeProject } from "@centraid/test-kit/vitest";

const REACT_NATIVE_SETUP = fileURLToPath(
  new URL("src/test/react-native-setup.ts", import.meta.url)
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

const nativeComponentFile = "src/apps/photos/PhotosHome.test.tsx";

// Export the concrete projects so the repository-wide coverage configs can
// compose them directly. Vitest treats a referenced config file as one project
// and does not recursively expand that config's `test.projects` array.
export const mobileVitestProjects = [
  nodeProject({
    root: MOBILE_ROOT,
    test: {
      exclude: [nativeComponentFile],
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
      include: [nativeComponentFile],
      pool: "threads",
      setupFiles: [REACT_NATIVE_SETUP],
    },
  }),
];
