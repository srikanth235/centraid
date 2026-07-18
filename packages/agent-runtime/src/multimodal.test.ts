import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEXT_ATTACHMENT_MAX_BYTES,
  blockFor,
  buildUserContent,
  codexImageItems,
  codexUnsupportedPdfs,
} from './multimodal.js';

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

  it('renders a text/plain attachment as a delimited text block', () => {
    const dataBase64 = Buffer.from('hello from a text file').toString('base64');
    const block = blockFor({ mime: 'text/plain', dataBase64, filename: 'notes.txt' });
    expect(block).toEqual({
      type: 'text',
      text: 'Attachment "notes.txt" (text/plain):\n```\nhello from a text file\n```',
    });
  });

  it('renders application/json as text', () => {
    const dataBase64 = Buffer.from('{"a":1}').toString('base64');
    const block = blockFor({ mime: 'application/json', dataBase64, filename: 'data.json' });
    expect(block).toEqual({
      type: 'text',
      text: 'Attachment "data.json" (application/json):\n```\n{"a":1}\n```',
    });
  });

  it('falls back to filename extension when the MIME is generic', () => {
    const dataBase64 = Buffer.from('console.log(1)').toString('base64');
    const block = blockFor({
      mime: 'application/octet-stream',
      dataBase64,
      filename: 'script.js',
    });
    expect(block).toEqual({
      type: 'text',
      text: 'Attachment "script.js" (application/octet-stream):\n```\nconsole.log(1)\n```',
    });
  });

  it('truncates textual attachments over the size cap with an explicit marker', () => {
    const big = 'x'.repeat(TEXT_ATTACHMENT_MAX_BYTES + 500);
    const dataBase64 = Buffer.from(big).toString('base64');
    const block = blockFor({ mime: 'text/plain', dataBase64, filename: 'huge.txt' });
    expect(block?.type).toBe('text');
    const text = (block as { text: string }).text;
    expect(text).toContain(
      `[truncated — showing first ${TEXT_ATTACHMENT_MAX_BYTES} of ${TEXT_ATTACHMENT_MAX_BYTES + 500} bytes]`,
    );
    expect(text.length).toBeLessThan(big.length + 200);
  });

  it('skips a text-labeled attachment whose bytes are actually binary', () => {
    const binary = Buffer.from([0, 1, 2, 3, 0, 255, 0, 254, 0, 1]);
    const block = blockFor({
      mime: 'text/plain',
      dataBase64: binary.toString('base64'),
      filename: 'not-really-text.txt',
    });
    expect(block).toBe(undefined);
  });

  it('emits an unsupported-format note instead of silently dropping other MIME types', () => {
    const dataBase64 = Buffer.from('x').toString('base64');
    const block = blockFor({ mime: 'application/zip', dataBase64, filename: 'archive.zip' });
    expect(block).toEqual({
      type: 'text',
      text: 'Attachment "archive.zip" (application/zip, 1 bytes) was provided but its format is not supported.',
    });
  });
});

describe('buildUserContent', () => {
  it('leads with the text block, then reads + encodes attachments', () => {
    const dir = tempDirSync('centraid-mm-');
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

  it('includes a .txt attachment as a text block so the model can read it', () => {
    const dir = tempDirSync('centraid-mm-');
    const txt = join(dir, 'notes.txt');
    writeFileSync(txt, 'remember to buy milk');
    const content = buildUserContent('see attached', [
      { path: txt, mime: 'text/plain', filename: 'notes.txt' },
    ]);
    expect(content).toEqual([
      { type: 'text', text: 'see attached' },
      {
        type: 'text',
        text: 'Attachment "notes.txt" (text/plain):\n```\nremember to buy milk\n```',
      },
    ]);
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

describe('codexUnsupportedPdfs (#420)', () => {
  it('flags PDF attachments codex would silently drop, carrying their filenames', () => {
    const dropped = codexUnsupportedPdfs([
      { path: '/a.png', mime: 'image/png' },
      { path: '/spec.pdf', mime: 'application/pdf', filename: 'spec.pdf' },
      { path: '/x.pdf', mime: 'APPLICATION/PDF' },
    ]);
    expect(dropped).toEqual([{ filename: 'spec.pdf' }, {}]);
  });

  it('is empty when there are no PDF attachments', () => {
    expect(codexUnsupportedPdfs([{ path: '/a.png', mime: 'image/png' }])).toEqual([]);
  });
});
