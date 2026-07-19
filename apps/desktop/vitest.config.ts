import { jsdomProject } from '@centraid/test-kit/vitest';

// Environment is `jsdom` now that extracted renderer logic (format/cron/diff,
// and future render-data/state) lives in testable modules — it gives those
// units the DOM globals they may reach for, while node builtins (fs, sqlite)
// stay available so the main-process logic tests keep working (TESTING.md §2).
export default jsdomProject({
  test: {
    name: '@centraid/desktop',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
