import { defineConfig } from "vitest/config";

import { mobileVitestProjects } from "./vitest.projects";

export default defineConfig({
  test: {
    projects: mobileVitestProjects,
  },
});
