// Attachments on an ACP turn: mapped to real content blocks, gated on the
// `promptCapabilities` the agent advertised, with a notice naming anything it
// genuinely can't take. Core turn behaviour is in backend.test.ts; shared
// fixtures in test-fixtures.ts.

import { tempDir } from '@centraid/test-kit/temp-dir';
import { expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TurnStreamEvent } from '@centraid/app-engine';
import { notices, runFake, type RunOptions } from './test-fixtures.js';

interface PromptBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

async function promptBlocksFor(
  opts: RunOptions & { promptMarker: string },
): Promise<{ blocks: PromptBlock[]; events: TurnStreamEvent[] }> {
  const { events } = await runFake(opts);
  const raw = await fs.readFile(opts.promptMarker, 'utf8');
  return { blocks: JSON.parse(raw) as PromptBlock[], events };
}

test('an image reaches an image-capable agent as an ACP image content block', async () => {
  const dir = await tempDir('acp-att-');
  const png = path.join(dir, 'shot.png');
  await fs.writeFile(png, Buffer.from('PNGBYTES'));
  const promptMarker = path.join(dir, 'prompt');

  const { blocks, events } = await promptBlocksFor({
    extraArgs: ['--mode=normal', '--prompt-caps=image', `--prompt-marker=${promptMarker}`],
    attachments: [{ path: png, mime: 'image/png', filename: 'shot.png' }],
    promptMarker,
  });

  const image = blocks.find((b) => b.type === 'image');
  expect(image).toEqual({
    type: 'image',
    data: Buffer.from('PNGBYTES').toString('base64'),
    mimeType: 'image/png',
  });
  // The message text still leads; nothing was skipped, so no notice.
  expect(blocks[0]?.type).toBe('text');
  expect(notices(events)).not.toContain('attachment_unsupported');
});

test('an agent without the image capability gets a notice naming what was skipped', async () => {
  const dir = await tempDir('acp-att-');
  const png = path.join(dir, 'shot.png');
  await fs.writeFile(png, Buffer.from('PNGBYTES'));
  const promptMarker = path.join(dir, 'prompt');

  const { blocks, events } = await promptBlocksFor({
    extraArgs: ['--mode=normal', `--prompt-marker=${promptMarker}`],
    attachments: [{ path: png, mime: 'image/png', filename: 'shot.png' }],
    promptMarker,
  });

  expect(blocks.some((b) => b.type === 'image')).toBe(false);
  const notice = events.find((e) => e.type === 'notice' && e.code === 'attachment_unsupported');
  expect(notice && notice.type === 'notice' && notice.message).toContain('shot.png');
});

test('a PDF rides an embedded resource when the agent takes embedded context', async () => {
  const dir = await tempDir('acp-att-');
  const pdf = path.join(dir, 'spec.pdf');
  await fs.writeFile(pdf, Buffer.from('%PDF-1.7'));
  const promptMarker = path.join(dir, 'prompt');

  const { blocks, events } = await promptBlocksFor({
    extraArgs: [
      '--mode=normal',
      '--prompt-caps=image,embeddedContext',
      `--prompt-marker=${promptMarker}`,
    ],
    attachments: [{ path: pdf, mime: 'application/pdf', filename: 'spec.pdf' }],
    promptMarker,
  });

  expect(blocks.find((b) => b.type === 'resource')).toMatchObject({
    type: 'resource',
    resource: { uri: `file://${pdf}`, mimeType: 'application/pdf' },
  });
  expect(notices(events)).not.toContain('attachment_unsupported');
});
