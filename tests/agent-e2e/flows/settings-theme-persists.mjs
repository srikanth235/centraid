// Flow: Settings theme persists across restart.
//
// Spec: ./settings-theme-persists.md
//
// Goal: switching theme to dark in Settings stores the pref in localStorage
// (userData/Local Storage/leveldb/), and a full Electron restart should keep
// the app in dark mode. This is a different persistence path than the
// on-disk drafts flow — renderer prefs, not appsDir.
//
// Run:  node tests/agent-e2e/flows/settings-theme-persists.mjs

import { runFlow } from '../lib/harness.mjs';

await runFlow('settings-theme-persists', async (ctx) => {
  // ---- baseline — confirm fresh launch is in light mode ----
  await ctx.shot('home-light-default');
  const initialTheme = await ctx.page.evaluate(() => document.documentElement.dataset.theme);
  if (initialTheme !== 'light') {
    throw new Error(`expected fresh launch to default to theme="light", got "${initialTheme}"`);
  }
  ctx.note('fresh launch defaults to light theme');

  // ---- open Settings drawer ----
  await ctx.page.getByRole('button', { name: 'Settings', exact: true }).click();
  await ctx.page.waitForSelector('.drawer-panel[aria-label="Settings"]');
  await ctx.shot('settings-open');

  // ---- click the Dark button in the appearance segmented control ----
  // The drawer has multiple segmented controls (theme / density / tile);
  // the theme group's buttons are the only ones labeled exactly "light" or "dark".
  await ctx.page
    .locator('.drawer-panel button', { hasText: /^dark$/i })
    .first()
    .click();
  await ctx.page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await ctx.shot('settings-after-dark');

  // ---- close drawer ----
  await ctx.page.locator('.drawer-backdrop').click();
  await ctx.page.waitForSelector('.drawer-panel', { state: 'detached' });
  await ctx.shot('home-dark');
  ctx.note('home rendered in dark mode after closing settings');

  // ---- restart Electron, same userData ----
  await ctx.restart();
  await ctx.shot('home-after-restart');
  const themeAfterRestart = await ctx.page.evaluate(() => document.documentElement.dataset.theme);
  if (themeAfterRestart !== 'dark') {
    throw new Error(
      `dark theme did not persist across restart: html[data-theme="${themeAfterRestart}"]`,
    );
  }
  ctx.note('dark theme persisted across Electron restart (localStorage in userData)');

  return { pass: true, notes: 'theme pref written to userData → survives main-process restart' };
});
