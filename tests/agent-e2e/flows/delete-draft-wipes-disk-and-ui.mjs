// Flow: Deleting a draft wipes it from disk and home, and the state persists.
//
// Spec: ./delete-draft-wipes-disk-and-ui.md
//
// Key invariant: the originating template never leaves TEMPLATES regardless
// of clone or delete — only *publish* removes a template from the available
// list (see app.ts:682). The flow asserts this so future renderer changes
// that conflate drafts and userApps fail loudly here.
//
// Run:  node tests/agent-e2e/flows/delete-draft-wipes-disk-and-ui.mjs

import fs from 'node:fs/promises';
import { runFlow } from '../lib/harness.mjs';

await runFlow('delete-draft-wipes-disk-and-ui', async (ctx) => {
  // ---- step 1 — clone Hydrate to create a draft ----
  const templatesGrid = () =>
    ctx.page.locator('.home-section-title:has-text("Templates") + .home-grid');
  await templatesGrid().locator('.app-tile', { hasText: 'Hydrate' }).first().click();
  await ctx.page.waitForSelector('.builder', { timeout: 10000 });
  await ctx.page.locator('.builder-topbar [aria-label="Back"]').first().click();
  await ctx.page.waitForSelector('.home', { timeout: 5000 });
  await ctx.shot('after-clone');

  const appsGrid = () =>
    ctx.page.locator('.home-section-title:has-text("Apps") + .home-grid');
  const draft = appsGrid()
    .locator('.app-tile[data-draft="true"]', { hasText: 'Hydrate' })
    .first();
  if ((await draft.count()) === 0) {
    throw new Error('Hydrate draft tile not present after clone');
  }
  const beforeDelete = await fs.readdir(ctx.state.projectsDir);
  if (beforeDelete.length !== 1) {
    throw new Error(
      `expected 1 project dir before delete, got ${beforeDelete.length}: ${beforeDelete.join(', ')}`,
    );
  }
  ctx.note('cloned: 1 draft, 1 project dir on disk');

  // ---- step 2 — open the tile context menu via the More button ----
  await draft.locator('.tile-more-btn').click();
  await ctx.page.waitForSelector('.ctx-menu');
  await ctx.shot('context-menu-open');

  // ---- step 3 — click "Delete draft" → confirm modal opens ----
  await ctx.page
    .locator('.ctx-item[data-danger="true"]', { hasText: 'Delete draft' })
    .click();
  await ctx.page.waitForSelector('.modal-card[role="dialog"]:has-text("Delete draft?")');
  await ctx.shot('confirm-modal');

  // ---- step 4 — confirm ----
  await ctx.page.locator('.modal-card .btn-danger', { hasText: 'Delete' }).click();
  await ctx.page.waitForSelector('.modal-card', { state: 'detached', timeout: 5000 });
  await ctx.page.waitForFunction(
    () => !document.querySelector('.app-tile[data-draft="true"]'),
  );
  await ctx.shot('after-delete');

  // ---- step 5 — disk + UI both clean; template never went anywhere ----
  const afterDelete = await fs.readdir(ctx.state.projectsDir);
  if (afterDelete.length !== 0) {
    throw new Error(
      `project dir not removed on delete: still has ${afterDelete.join(', ')}`,
    );
  }
  if ((await ctx.page.locator('.app-tile[data-draft="true"]').count()) !== 0) {
    throw new Error('a draft tile is still rendered after delete');
  }
  if (
    (await templatesGrid().locator('.app-tile', { hasText: 'Hydrate' }).count()) === 0
  ) {
    throw new Error('Hydrate template tile is missing from TEMPLATES — should always be present unless published');
  }
  ctx.note('post-delete: 0 drafts, 0 project dirs, Hydrate still under TEMPLATES');

  // ---- step 6 — restart, state must still be clean ----
  await ctx.restart();
  await ctx.shot('after-restart');

  if ((await ctx.page.locator('.app-tile[data-draft="true"]').count()) !== 0) {
    throw new Error('a draft tile reappeared after restart — delete was not persisted');
  }
  if (
    (await templatesGrid().locator('.app-tile', { hasText: 'Hydrate' }).count()) === 0
  ) {
    throw new Error('Hydrate template tile missing under TEMPLATES after restart');
  }
  ctx.note('post-restart: clean state preserved');

  return {
    pass: true,
    notes: 'clone → delete via tile menu → disk wiped, UI clean, persists across restart',
  };
});
