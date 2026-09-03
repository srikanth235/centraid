import { jsdomProject } from "@centraid/test-kit/vitest";

export default jsdomProject({
  test: {
    name: "@centraid/desktop",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
