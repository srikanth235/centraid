#!/usr/bin/env node
// Throwaway visual probe for the automations UI revamp — drives the real app
// through: Automations overview (empty) → Templates → adopt trip-albums →
// thread screen → Run now → editor. Screenshots to out/revamp-*.png.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = (n) => path.join(__dirname, 'out', `revamp-${n}.png`);

const { app, page } = await launchApp({});
try {
  await page.setViewportSize({ width: 1400, height: 900 });

  // 1. Overview, empty state.
  await navTo(page, 'Automations');
  await page.getByRole('heading', { name: 'Automations' }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: out('01-overview-empty') });

  // 2. Templates gallery.
  await page.getByRole('button', { name: 'Browse templates' }).first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: out('02-templates') });

  // 3. Adopt trip-albums (zero-setup cron template) via its preview drawer.
  await page.getByText('Trip albums', { exact: false }).first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: out('03-template-preview') });
  await page.getByRole('button', { name: 'Use template', exact: true }).click();
  // Adoption clones + publishes, then navigates to the thread.
  await page.waitForTimeout(2500);
  await page.screenshot({ path: out('04-thread-after-adopt') });

  // 4. Run now → wait for the run to appear in the thread.
  const runNow = page.getByRole('button', { name: 'Run now' });
  await runNow.waitFor({ timeout: 10_000 });
  await runNow.click();
  // The fire is async (202) — the awaitingRun poll loop must surface the run.
  await page.locator('[data-run-status]').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: out('05-thread-after-run') });

  // 5. Editor via Edit.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: out('06-editor-edit-mode') });

  // 6. Editor tabs.
  await page.getByRole('tab', { name: 'Behavior' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: out('07-editor-behavior') });
  await page.getByRole('tab', { name: 'Connectors' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: out('08-editor-connectors') });

  // 7. Create mode via overview's New automation.
  await navTo(page, 'Automations');
  await page.getByRole('button', { name: 'New automation' }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: out('09-editor-create-mode') });

  console.log('[probe] PASS — screenshots in out/revamp-*.png');
} catch (err) {
  await page.screenshot({ path: out('FAILURE') }).catch(() => {});
  console.error('[probe] FAIL:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
