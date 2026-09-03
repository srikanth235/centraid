import { nodeProject } from "@centraid/test-kit/vitest";

export default nodeProject({
  test: {
    name: "@centraid/backup",
    include: ["src/**/*.test.ts"],
  },
});
