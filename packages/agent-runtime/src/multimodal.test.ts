import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEXT_ATTACHMENT_MAX_BYTES,
  acpAttachmentBlocks,
  acpBlockFor,
  type PromptCapabilities,
} from './multimodal.js';

/** What both first-party ACP adapters actually advertise. */
const FULL: PromptCapabilities = { image: true, audio: true, embeddedContext: true };
/** A baseline agent: text and resource links only. */
const TEXT_ONLY: PromptCapabilities = {};

describe('acpBlockFor', () => {
  it('maps an image MIME to an ACP image block (flat data/mimeType)', () => {
    expect(acpBlockFor({ mime: 'image/png', dataBase64: 'AAAA' }, FULL)).toEqual({
      type: 'image',
      data: 'AAAA',
      mimeType: 'image/png',
    });
  });

  it('skips an image when the agent did not advertise the image capability', () => {
    expect(acpBlockFor({ mime: 'image/png', dataBase64: 'AAAA' }, TEXT_ONLY)).toBe(undefined);
  });

  it('carries a PDF as an embedded resource when embeddedContext is advertised', () => {
    const block = acpBlockFor(
      {
        mime: 'application/pdf',
        dataBase64: 'JVBE',
        filename: 'spec.pdf',
        path: '/blobs/spec.pdf',
      },
      FULL,
    );
    expect(block).toEqual({
      type: 'resource',
      resource: { uri: 'file:///blobs/spec.pdf', mimeType: 'application/pdf', blob: 'JVBE' },
    });
  });

  it('skips a PDF when the agent cannot take embedded context', () => {
    expect(
      acpBlockFor({ mime: 'application/pdf', dataBase64: 'JVBE', filename: 'spec.pdf' }, TEXT_ONLY),
    ).toBe(undefined);
  });

  it('renders a text/plain attachment as a delimited text block, capability-free', () => {
    const dataBase64 = Buffer.from('hello from a text file').toString('base64');
    expect(
      acpBlockFor({ mime: 'text/plain', dataBase64, filename: 'notes.txt' }, TEXT_ONLY),
    ).toEqual({
      type: 'text',
      text: 'Attachment "notes.txt" (text/plain):\n```\nhello from a text file\n```',
    });
  });

  it('renders application/json as text', () => {
    const dataBase64 = Buffer.from('{"a":1}').toString('base64');
    expect(
      acpBlockFor({ mime: 'application/json', dataBase64, filename: 'data.json' }, FULL),
    ).toEqual({
      type: 'text',
      text: 'Attachment "data.json" (application/json):\n```\n{"a":1}\n```',
    });
  });

  it('falls back to filename extension when the MIME is generic', () => {
    const dataBase64 = Buffer.from('console.log(1)').toString('base64');
    expect(
      acpBlockFor({ mime: 'application/octet-stream', dataBase64, filename: 'script.js' }, FULL),
    ).toEqual({
      type: 'text',
      text: 'Attachment "script.js" (application/octet-stream):\n```\nconsole.log(1)\n```',
    });
  });

  it('truncates textual attachments over the size cap with an explicit marker', () => {
    const big = 'x'.repeat(TEXT_ATTACHMENT_MAX_BYTES + 500);
    const dataBase64 = Buffer.from(big).toString('base64');
    const block = acpBlockFor({ mime: 'text/plain', dataBase64, filename: 'huge.txt' }, FULL);
    expect(block?.type).toBe('text');
    const text = (block as { text: string }).text;
    expect(text).toContain(
      `[truncated — showing first ${TEXT_ATTACHMENT_MAX_BYTES} of ${TEXT_ATTACHMENT_MAX_BYTES + 500} bytes]`,
    );
    expect(text.length).toBeLessThan(big.length + 200);
  });

  it('skips a text-labeled attachment whose bytes are actually binary', () => {
    const binary = Buffer.from([0, 1, 2, 3, 0, 255, 0, 254, 0, 1]);
    expect(
      acpBlockFor(
        { mime: 'text/plain', dataBase64: binary.toString('base64'), filename: 'not-text.txt' },
        FULL,
      ),
    ).toBe(undefined);
  });

  it('maps audio only when the agent advertised the audio capability', () => {
    const att = { mime: 'audio/wav', dataBase64: 'UklG' };
    expect(acpBlockFor(att, FULL)).toEqual({ type: 'audio', data: 'UklG', mimeType: 'audio/wav' });
    expect(acpBlockFor(att, { image: true })).toBe(undefined);
  });
});

describe('acpAttachmentBlocks', () => {
  it('reads + encodes attachments the agent can take', () => {
    const dir = tempDirSync('centraid-mm-');
    const png = join(dir, 'p.png');
    writeFileSync(png, Buffer.from('PNGDATA'));
    const { blocks, skipped } = acpAttachmentBlocks([{ path: png, mime: 'image/png' }], FULL);
    expect(skipped).toEqual([]);
    expect(blocks).toEqual([
      { type: 'image', data: Buffer.from('PNGDATA').toString('base64'), mimeType: 'image/png' },
    ]);
  });

  it('names what it skipped rather than dropping it silently', () => {
    const dir = tempDirSync('centraid-mm-');
    const png = join(dir, 'shot.png');
    writeFileSync(png, Buffer.from('PNGDATA'));
    const { blocks, skipped } = acpAttachmentBlocks(
      [{ path: png, mime: 'image/png', filename: 'shot.png' }],
      TEXT_ONLY,
    );
    expect(blocks).toEqual([]);
    expect(skipped).toEqual(['shot.png']);
  });

  it('reports a missing blob as skipped rather than throwing', () => {
    const { blocks, skipped } = acpAttachmentBlocks(
      [{ path: '/no/such/blob', mime: 'image/png', filename: 'gone.png' }],
      FULL,
    );
    expect(blocks).toEqual([]);
    expect(skipped).toEqual(['gone.png']);
  });

  it('includes a .txt attachment as a text block so the model can read it', () => {
    const dir = tempDirSync('centraid-mm-');
    const txt = join(dir, 'notes.txt');
    writeFileSync(txt, 'remember to buy milk');
    const { blocks } = acpAttachmentBlocks(
      [{ path: txt, mime: 'text/plain', filename: 'notes.txt' }],
      TEXT_ONLY,
    );
    expect(blocks).toEqual([
      {
        type: 'text',
        text: 'Attachment "notes.txt" (text/plain):\n```\nremember to buy milk\n```',
      },
    ]);
  });
});
