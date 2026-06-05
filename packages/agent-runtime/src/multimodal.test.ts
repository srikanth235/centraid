import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockFor, buildUserContent, codexImageItems } from './multimodal.js';

describe('multimodal blockFor', () => {
  it('maps an image MIME to an Anthropic image block', () => {
    const block = blockFor({ mime: 'image/png', dataBase64: 'AAAA' });
    expect(block).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });

  it('maps a PDF to a document block with the filename as title', () => {
    const block = blockFor({ mime: 'application/pdf', dataBase64: 'JVBE', filename: 'spec.pdf' });
    expect(block).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' },
      title: 'spec.pdf',
    });
  });

  it('drops an unsupported MIME (text-only fallback)', () => {
    expect(blockFor({ mime: 'application/zip', dataBase64: 'x' })).toBe(undefined);
  });
});

describe('buildUserContent', () => {
  it('leads with the text block, then reads + encodes attachments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'centraid-mm-'));
    const png = join(dir, 'p.png');
    writeFileSync(png, Buffer.from('PNGDATA'));
    const content = buildUserContent('look at this', [{ path: png, mime: 'image/png' }]);
    expect(content.length).toBe(2);
    expect(content[0]).toEqual({ type: 'text', text: 'look at this' });
    expect(content[1]?.type).toBe('image');
    expect((content[1] as { source: { data: string } }).source.data).toBe(
      Buffer.from('PNGDATA').toString('base64'),
    );
  });

  it('skips a missing blob rather than throwing (text-only)', () => {
    const content = buildUserContent('hi', [{ path: '/no/such/blob', mime: 'image/png' }]);
    expect(content).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

describe('codexImageItems', () => {
  it('emits localImage items for image attachments only', () => {
    const items = codexImageItems([
      { path: '/a.png', mime: 'image/png' },
      { path: '/b.pdf', mime: 'application/pdf' },
    ]);
    expect(items).toEqual([{ type: 'localImage', path: '/a.png' }]);
  });
});
