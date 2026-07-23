#!/usr/bin/env node
/**
 * Fetch connector brand SVGs from Iconify and rewrite connectorBrandMarks.tsx.
 *
 * Browse: https://icon-sets.iconify.design/
 * Usage:  node scripts/fetch-connector-brand-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { assertSafeConnectorSvg } from './lib/sanitize-connector-svg.mjs';

const MAP = {
  gmail: 'logos:google-gmail',
  gcal: 'logos:google-calendar',
  gcontacts: 'selfhst:google-contacts',
  gdrive: 'logos:google-drive',
  github: 'logos:github-icon',
  outlook: 'vscode-icons:file-type-outlook',
  outlookcal: 'fluent-color:calendar-16',
  outlookcontacts: 'fluent-color:contact-card-16',
  onedrive: 'logos:microsoft-onedrive',
  gitlab: 'logos:gitlab-icon',
  linear: 'logos:linear-icon',
  notion: 'logos:notion-icon',
  todoist: 'logos:todoist-icon',
  slack: 'logos:slack-icon',
  dropbox: 'logos:dropbox',
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'packages/client/src/react/screens/connectorBrandMarks.tsx');

function fetchSvg(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`${url} -> ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      })
      .on('error', reject);
  });
}

function normalizeSvg(svg, tone) {
  assertSafeConnectorSvg(svg, tone);
  let s = svg.trim().replace(/\s+/g, ' ').replace(/> </g, '><');
  s = s.replace(/<svg\b([^>]*)>/, (_m, attrs) => {
    const vb = attrs.match(/viewBox="([^"]+)"/);
    const viewBox = vb ? vb[1] : '0 0 24 24';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="100%" height="100%" aria-hidden="true" focusable="false">`;
  });
  if (tone === 'github' || tone === 'linear') {
    s = s
      .replace(/fill="#161614"/gi, 'fill="currentColor"')
      .replace(/fill="#222326"/gi, 'fill="currentColor"')
      .replace(/fill="#000000?"/gi, 'fill="currentColor"')
      .replace(/fill="black"/gi, 'fill="currentColor"');
  }
  if (tone === 'notion') {
    s = s
      .replace(/fill="#000000?"/gi, 'fill="currentColor"')
      .replace(/fill="#191919"/gi, 'fill="currentColor"')
      .replace(/stroke="#000000?"/gi, 'stroke="currentColor"');
  }
  return s;
}

const out = {};
const sources = {};
for (const [tone, id] of Object.entries(MAP)) {
  const [prefix, name] = id.split(':');
  const raw = await fetchSvg(`https://api.iconify.design/${prefix}/${name}.svg`);
  if (!raw.startsWith('<svg') || raw.length < 40) throw new Error(`Bad svg for ${id}`);
  out[tone] = normalizeSvg(raw, tone);
  sources[tone] = id;
  console.log('OK', tone, '<-', id);
}
out.default =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" rx="5" fill="var(--accent, #6366f1)" opacity="0.15"/><path d="M8 12h8M12 8v8" stroke="var(--accent, #6366f1)" stroke-width="2" stroke-linecap="round"/></svg>';
sources.default = 'local:default';

const file = `/* Brand SVGs from Iconify (https://icon-sets.iconify.design/), offline-embedded.
 * Prefer regenerating with: node scripts/fetch-connector-brand-icons.mjs
 *
 * Sources:
${Object.entries(sources)
  .map(([k, v]) => ` *   ${k}: ${v}`)
  .join('\n')}
 */

import { useId, type JSX } from 'react';

export type ConnectorTone =
  | 'gmail'
  | 'gcal'
  | 'gcontacts'
  | 'gdrive'
  | 'github'
  | 'outlook'
  | 'outlookcal'
  | 'outlookcontacts'
  | 'onedrive'
  | 'gitlab'
  | 'linear'
  | 'notion'
  | 'todoist'
  | 'slack'
  | 'dropbox'
  | 'default';

/** Raw SVG markup keyed by Featured tone (Iconify, offline-embedded). */
export const CONNECTOR_BRAND_SVG: Record<string, string> = ${JSON.stringify(out, null, 2)};

/** Iconify collection:icon ids used for each tone (for docs / regen). */
export const CONNECTOR_BRAND_SOURCES: Record<string, string> = ${JSON.stringify(sources, null, 2)};

/**
 * Brand mark glyph for the Featured connectors gallery.
 * SVGs are embedded at build time — no runtime network calls.
 */
export function ConnectorBrandGlyph({
  tone,
  size = 22,
}: {
  tone: string;
  size?: number;
}): JSX.Element {
  const reactId = useId().replace(/:/g, '');
  const svg = CONNECTOR_BRAND_SVG[tone] ?? CONNECTOR_BRAND_SVG.default;
  // Prefix gradient/filter IDs so multiple marks on one page don't collide.
  const uid = \`cb-\${tone.replace(/[^a-z0-9]+/gi, '')}-\${reactId}\`;
  const unique = svg
    .replace(/id="([^"]+)"/g, (_m, id) => \`id="\${uid}-\${id}"\`)
    .replace(/url\\(#([^)]+)\\)/g, (_m, id) => \`url(#\${uid}-\${id})\`)
    .replace(/href="#([^"]+)"/g, (_m, id) => \`href="#\${uid}-\${id}"\`);

  return (
    <span
      style={{
        display: 'inline-grid',
        placeItems: 'center',
        width: size,
        height: size,
        lineHeight: 0,
        color: 'currentColor',
      }}
      // Embedded Iconify SVG — static markup, no user content.
      dangerouslySetInnerHTML={{ __html: unique }}
    />
  );
}
`;

fs.writeFileSync(DEST, file);
console.log('Wrote', DEST);
