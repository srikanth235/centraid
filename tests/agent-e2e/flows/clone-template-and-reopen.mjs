// Flow: Clone template, save, reopen.
//
// Spec: ./clone-template-and-reopen.md
//
// Goal: cloning a built-in template creates a draft on disk that survives a
// full Electron restart (drafts hydrate from appsDir at startup).
//
// Run:  node tests/agent-e2e/flows/clone-template-and-reopen.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { runFlow } from '../lib/harness.mjs';

await runFlow('clone-template-and-reopen', async (ctx) => {
  // ---- step 1 — confirm a Hydrate template tile exists under TEMPLATES ----
  await ctx.shot('home-before');
  const templatesGrid = ctx.page.locator('.home-section-title:has-text("Templates") + .home-grid');
  const hydrateTemplate = templatesGrid.locator('.app-tile', { hasText: 'Hydrate' }).first();
  if ((await hydrateTemplate.count()) === 0) {
    throw new Error('Hydrate template tile not found under TEMPLATES section');
  }
  ctx.note('Hydrate template tile is visible under TEMPLATES');

  // ---- step 2 — click it; cloneTemplate runs, then the builder opens ----
  await hydrateTemplate.click();
  await ctx.page.waitForSelector('.builder', { timeout: 10000 });
  await ctx.shot('builder-open');
  ctx.note('builder opened after template click');

  // ---- step 3 — verify app dir was written on disk ----
  const appDirs = await fs.readdir(ctx.state.appsDir);
  if (appDirs.length !== 1) {
    throw new Error(`expected exactly 1 app dir, found ${appDirs.length}: ${appDirs.join(', ')}`);
  }
  const appPath = path.join(ctx.state.appsDir, appDirs[0]);
  const appJson = JSON.parse(await fs.readFile(path.join(appPath, 'app.json'), 'utf8'));
  if (appJson.name !== 'Hydrate') {
    throw new Error(`app.json name is "${appJson.name}", expected "Hydrate"`);
  }
  ctx.note(`on-disk app: ${appDirs[0]} (app.json.name = "${appJson.name}")`);

  // ---- step 4 — exit the builder back to home ----
  // The builder topbar's first Back button (aria-label="Back") calls onExit → renderHome.
  // A second "Back to chat" button exists deeper in the builder; pick the first one.
  await ctx.page.locator('.builder-topbar [aria-label="Back"]').first().click();
  await ctx.page.waitForSelector('.home', { timeout: 5000 });
  await ctx.shot('home-with-draft');

  // ---- step 5 — verify a Hydrate DRAFT tile appears under APPS ----
  const appsGrid = ctx.page.locator('.home-section-title:has-text("Apps") + .home-grid');
  const draftHydrate = appsGrid
    .locator('.app-tile[data-draft="true"]', { hasText: 'Hydrate' })
    .first();
  if ((await draftHydrate.count()) === 0) {
    throw new Error('Hydrate DRAFT tile not found under APPS after exiting builder');
  }
  ctx.note('Hydrate draft tile present on home after builder exit');

  // ---- step 6 — restart Electron (same userData/appsDir) ----
  await ctx.restart();
  await ctx.shot('after-restart');

  // ---- step 7 — verify draft still on home after fresh main process ----
  const draftAfter = ctx.page
    .locator('.home-section-title:has-text("Apps") + .home-grid')
    .locator('.app-tile[data-draft="true"]', { hasText: 'Hydrate' })
    .first();
  if ((await draftAfter.count()) === 0) {
    throw new Error('Hydrate DRAFT tile missing after Electron restart');
  }
  ctx.note('Hydrate draft survived Electron restart');

  return { pass: true, notes: 'clone → exit builder → restart → draft still present' };
});
