// Flow: Three independent template clones coexist on home + disk and survive a restart.
//
// Spec: ./multiple-drafts-coexist-and-persist.md
//
// Key invariant: cloning a template does NOT remove it from TEMPLATES — only
// publishing does. `loadAvailableTemplates` at app.ts:682 filters by
// `userApps` (published), not by drafts. The flow asserts this explicitly so
// future renderer changes that break the assumption fail loudly here.
//
// Run:  node tests/agent-e2e/flows/multiple-drafts-coexist-and-persist.mjs

import fs from 'node:fs/promises';
import { runFlow } from '../lib/harness.mjs';

const TEMPLATES = ['Hydrate', 'Todos', 'Journal'];

await runFlow('multiple-drafts-coexist-and-persist', async (ctx) => {
  // ---- baseline — TEMPLATES section has all three tiles ----
  await ctx.shot('home-initial');
  const templatesGrid = () =>
    ctx.page.locator('.home-section-title:has-text("Templates") + .home-grid');
  for (const name of TEMPLATES) {
    if ((await templatesGrid().locator('.app-tile', { hasText: name }).count()) === 0) {
      throw new Error(`expected "${name}" template tile under TEMPLATES on fresh launch`);
    }
  }
  ctx.note(`baseline: TEMPLATES contains ${TEMPLATES.join(', ')}`);

  // ---- clone each template in sequence ----
  for (const [i, name] of TEMPLATES.entries()) {
    await templatesGrid().locator('.app-tile', { hasText: name }).first().click();
    await ctx.page.waitForSelector('.builder', { timeout: 10000 });
    await ctx.page.locator('.builder-topbar [aria-label="Back"]').first().click();
    await ctx.page.waitForSelector('.home', { timeout: 5000 });
    await ctx.shot(`after-clone-${i + 1}-${name.toLowerCase()}`);
    ctx.note(`cloned ${name} (#${i + 1}/${TEMPLATES.length})`);
  }

  // ---- TEMPLATES section is STILL present — clones don't consume templates,
  //      only publishes do (see loadAvailableTemplates at app.ts:682) ----
  for (const name of TEMPLATES) {
    if ((await templatesGrid().locator('.app-tile', { hasText: name }).count()) === 0) {
      throw new Error(
        `"${name}" template tile disappeared after clone — expected templates to remain available until publish`,
      );
    }
  }
  ctx.note('TEMPLATES section still shows all three tiles after cloning');

  // ---- APPS section now holds all three drafts ----
  const appsGrid = () => ctx.page.locator('.home-section-title:has-text("Apps") + .home-grid');
  for (const name of TEMPLATES) {
    if (
      (await appsGrid().locator('.app-tile[data-draft="true"]', { hasText: name }).count()) === 0
    ) {
      throw new Error(`"${name}" draft tile missing under APPS after clone`);
    }
  }
  ctx.note('all three drafts present under APPS');

  // ---- and on disk: three project directories ----
  const projectsBefore = await fs.readdir(ctx.state.projectsDir);
  if (projectsBefore.length !== 3) {
    throw new Error(
      `expected 3 project dirs on disk, found ${projectsBefore.length}: ${projectsBefore.join(', ')}`,
    );
  }
  ctx.note(`on disk: ${projectsBefore.sort().join(', ')}`);

  // ---- restart — drafts must rehydrate from projectsDir ----
  await ctx.restart();
  await ctx.shot('after-restart');

  for (const name of TEMPLATES) {
    if (
      (await appsGrid().locator('.app-tile[data-draft="true"]', { hasText: name }).count()) === 0
    ) {
      throw new Error(`"${name}" draft tile missing under APPS after restart`);
    }
    if ((await templatesGrid().locator('.app-tile', { hasText: name }).count()) === 0) {
      throw new Error(`"${name}" template tile missing after restart`);
    }
  }
  ctx.note('all three drafts AND all three templates present after restart');

  return {
    pass: true,
    notes: 'three drafts coexist on disk + UI; templates stay available; survives restart',
  };
});
