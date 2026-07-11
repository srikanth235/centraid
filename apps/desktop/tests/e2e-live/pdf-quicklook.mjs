#!/usr/bin/env node
// Focused live E2E: does a real PDF upload into the real vault render inside
// the docs blueprint app's quick-look, in the REAL desktop shell (real
// embedded gateway, real dev vault, no mocks)? Also checks the honest
// fallback for a non-previewable type (.zip) and its download control.
//
// Run: node apps/desktop/tests/e2e-live/pdf-quicklook.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'pdf');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-pdf-quicklook');
const FIXTURES_DIR = path.join(__dirname, 'out', 'pdf', 'fixtures');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ---- a REAL, valid single-page PDF with visible "Hello" text, offsets
// computed exactly so xref is correct (lenient viewers don't need this, but
// Chromium's PDFium is stricter than most quick hand-rolled PDFs). ----
function buildPdf() {
  const header = '%PDF-1.4\n';
  const objs = [];
  objs.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objs.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  objs.push(
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
  );
  objs.push('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  const stream = 'BT /F1 24 Tf 20 100 Td (Hello) Tj ET';
  objs.push(`5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);

  let body = header;
  const offsets = [0]; // object 0 is the free-list head, offset unused (0)
  for (const obj of objs) {
    offsets.push(body.length);
    body += obj;
  }
  const xrefStart = body.length;
  let xref = `xref\n0 ${offsets.length}\n`;
  xref += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return body + xref + trailer;
}

async function writeFixtures() {
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
  const pdfPath = path.join(FIXTURES_DIR, 'hello.pdf');
  await fs.writeFile(pdfPath, buildPdf());
  const zipPath = path.join(FIXTURES_DIR, 'archive.zip');
  // Minimal valid empty ZIP (end-of-central-directory record only).
  await fs.writeFile(
    zipPath,
    Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  );
  return { pdfPath, zipPath };
}

const results = [];
let page;
const consoleMessages = [];
const cspViolations = [];
const blobResponses = [];

function wireConsole(p) {
  p.on('console', (msg) => {
    const entry = { text: msg.text(), type: msg.type(), url: msg.location()?.url ?? '' };
    consoleMessages.push(entry);
    if (/Content Security Policy|Refused to (frame|load)/i.test(entry.text)) {
      cspViolations.push(entry);
    }
  });
  p.on('response', (res) => {
    const url = res.url();
    if (url.includes('/_vault/blobs/')) {
      blobResponses.push({
        url,
        status: res.status(),
        headers: res.headers(),
      });
    }
  });
}

async function step(id, label, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, label, verdict: 'pass', ms: Date.now() - t0 });
    console.log(`[PASS] ${id} ${label} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({
      id,
      label,
      verdict: 'fail',
      ms: Date.now() - t0,
      error: err && err.stack ? err.stack : String(err),
    });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const fixtures = await writeFixtures();

  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  await page.setViewportSize({ width: 1400, height: 900 });

  let docsFrameLoc;

  await step('1', 'Fresh boot -> Home renders', async () => {
    await page
      .getByRole('heading', { name: 'What should we build?' })
      .waitFor({ state: 'visible' });
  });

  await step(
    '2',
    'Discover -> install Docs template (fresh snapshot of current source)',
    async () => {
      await navTo(page, 'Discover');
      const docsCard = page.locator('button[data-kind="app"]', { hasText: 'Docs' }).first();
      await docsCard.waitFor({ state: 'visible', timeout: 15_000 });
      await docsCard.click();
      const dialog = page.getByRole('dialog', { name: /^Preview Docs/ });
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Use this template' }).click();
      const toast = page.locator('[data-global-toast]');
      await toast.waitFor({ state: 'visible', timeout: 10_000 });
      await page
        .getByRole('heading', { name: 'What should we build?' })
        .waitFor({ state: 'visible', timeout: 10_000 });
    },
  );

  await step('3', 'Open Docs app', async () => {
    const tile = page.locator('[data-app-id="docs"]');
    await tile.waitFor({ state: 'visible', timeout: 10_000 });
    await tile.getByTestId('app-tile').click();
    const frameEl = await page.waitForSelector('iframe[data-centraid-app="1"]', {
      timeout: 15_000,
    });
    docsFrameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
    // Wait for the app's own DOM to paint (upload input present).
    await docsFrameLoc.locator('#uploadInput').waitFor({ state: 'attached', timeout: 15_000 });
    await shot('01-docs-open');
    void frameEl;
  });

  await step('4', 'Upload real PDF + zip via real file input', async () => {
    const fileInput = docsFrameLoc.locator('#uploadInput');
    await fileInput.setInputFiles([fixtures.pdfPath, fixtures.zipPath]);
    await docsFrameLoc.locator('.d-card').nth(1).waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(300);
    const cardCount = await docsFrameLoc.locator('.d-card').count();
    assert(cardCount >= 2, `expected >= 2 cards after upload, got ${cardCount}`);
    await shot('02-upload-grid');
  });

  let pdfCard;
  let zipCard;
  await step('5', 'Identify PDF card (type tint) vs zip card', async () => {
    const cards = docsFrameLoc.locator('.d-card');
    const n = await cards.count();
    for (let i = 0; i < n; i++) {
      const title = (await cards.nth(i).locator('.d-card-title').textContent()) ?? '';
      if (/hello\.pdf/i.test(title)) pdfCard = cards.nth(i);
      if (/archive\.zip/i.test(title)) zipCard = cards.nth(i);
    }
    assert(pdfCard, 'could not find hello.pdf card in grid');
    assert(zipCard, 'could not find archive.zip card in grid');
  });

  await step('6', 'PDF type filter chip shows the PDF (type tint sanity)', async () => {
    const pdfChip = docsFrameLoc.getByRole('button', { name: 'PDFs' });
    await pdfChip.click();
    await page.waitForTimeout(300);
    const count = await docsFrameLoc.locator('.d-card').count();
    assert(count >= 1, 'PDF type-chip filter shows no cards');
    await shot('03-pdf-type-chip');
    const allChip = docsFrameLoc.getByRole('button', { name: 'All', exact: true }).first();
    await allChip.click();
    await page.waitForTimeout(300);
  });

  await step('7', 'Open quick-look on the PDF card -> real PDF must render', async () => {
    await pdfCard.locator('.d-thumb').click();
    const quick = docsFrameLoc.locator('[aria-label="Quick look"]');
    await quick.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(1200); // let the embedded PDF viewer paint
    await shot('04-pdf-quicklook-open');

    try {
      // The iframe stage itself: docs' own <iframe class="d-quick-frame">
      // nested INSIDE the app's iframe. Grab its frame and confirm it
      // actually loaded a PDF document (not a CSP error page / blank).
      const innerFrameHandle = await docsFrameLoc.locator('iframe.d-quick-frame').elementHandle();
      assert(
        innerFrameHandle,
        'no iframe.d-quick-frame present for a PDF doc — stage fell through to the generic mock-page branch',
      );
      const innerFrame = await innerFrameHandle.contentFrame();
      assert(
        innerFrame,
        'iframe.d-quick-frame has no accessible contentFrame (cross-origin or navigation blocked)',
      );
      const innerUrl = innerFrame.url();
      console.log(`[7] inner PDF iframe src resolved to: ${innerUrl}`);
      assert(
        /_vault\/blobs\//.test(innerUrl),
        `inner iframe src not a vault blob URL: ${innerUrl}`,
      );
    } finally {
      // Always close, even on assertion failure, so later steps aren't
      // blocked by a stuck modal intercepting pointer events.
      await page.keyboard.press('Escape').catch(() => {});
      await quick.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    }
  });

  await step(
    '8',
    'Non-previewable type (.zip) shows honest fallback, not a broken embed',
    async () => {
      await zipCard.locator('.d-thumb').click();
      const quick = docsFrameLoc.locator('[aria-label="Quick look"]');
      await quick.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('05-zip-quicklook-fallback');
      const hasFrame = (await docsFrameLoc.locator('iframe.d-quick-frame').count()) > 0;
      assert(!hasFrame, 'zip should NOT render as an iframe PDF stage');
      const hasImg = (await docsFrameLoc.locator('img.d-quick-image').count()) > 0;
      assert(!hasImg, 'zip should NOT render as an image stage');
      const hasMock = (await docsFrameLoc.locator('.d-quick-page').count()) > 0;
      assert(hasMock, 'zip should show the generic document-mock fallback (.d-quick-page)');
      assert(
        await quick.getByText('Download').isVisible(),
        'zip quick-look missing Download control',
      );
      await quick.getByRole('button', { name: 'Close' }).click();
      await quick.waitFor({ state: 'hidden', timeout: 5_000 });
    },
  );

  await step(
    '9',
    'Download link for the PDF resolves same-origin (no navigation error)',
    async () => {
      await pdfCard.locator('.d-thumb').click();
      const quick = docsFrameLoc.locator('[aria-label="Quick look"]');
      await quick.waitFor({ state: 'visible', timeout: 10_000 });
      const downloadLink = quick.locator('a.d-quick-btn');
      const href = await downloadLink.getAttribute('href');
      console.log(`[9] download href: ${href}`);
      assert(href && /_vault\/blobs\//.test(href), `download href not a vault blob URL: ${href}`);
      await quick.getByRole('button', { name: 'Close' }).click();
    },
  );

  console.log('\n--- CSP / console violations captured ---');
  console.log(cspViolations.length === 0 ? '(none)' : JSON.stringify(cspViolations, null, 2));
  console.log('\n--- blob route responses observed ---');
  for (const b of blobResponses) {
    console.log(
      `${b.status} ${b.url} content-type=${b.headers['content-type']} disposition=${b.headers['content-disposition']}`,
    );
  }

  await session.close();

  console.log('\n--- SUMMARY ---');
  let failed = false;
  for (const r of results) {
    console.log(
      `[${r.verdict.toUpperCase()}] ${r.id} ${r.label} (${r.ms}ms)${r.error ? `\n  ${r.error}` : ''}`,
    );
    if (r.verdict === 'fail') failed = true;
  }
  if (cspViolations.length > 0) failed = true;
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
