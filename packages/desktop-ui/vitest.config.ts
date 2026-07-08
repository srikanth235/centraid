import { defineProject } from 'vitest/config';

// Project config for @centraid/desktop-ui. Coverage + the unified run live in
// the root vitest.config.ts; see TESTING.md. Components are asserted via
// react-dom/server → static markup (class names, structure), so a jsdom
// environment isn't needed — node is enough and keeps the suite fast.
export default defineProject({
  test: {
    name: '@centraid/desktop-ui',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
