// Active-version preview protocol.
//
// Serves files from the gateway's *active version* of an app into the
// builder's preview iframe. URL shape:
//
//   centraid-preview://<id>/<path>     → <appsDir>/<id>/versions/<active>/<path>
//   centraid-preview://<id>/           → <appsDir>/<id>/versions/<active>/index.html
//
// Pre-#108 this served from the workspace directly (flat `<appsDir>/<id>/`),
// which made the iframe show unpublished edits the gateway dispatcher could
// not actually run. The split fixes that: the preview iframe and the
// dispatcher both see the same bytes (the active version on disk), and the
// publish-on-save loop is what makes a workspace edit visible here.
//
// Path-traversal hardening: the project id must match the same shape the
// scaffolder enforces, and the resolved file must stay inside the active
// version directory. Anything else is rejected before touching disk.

import { protocol, net } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readActiveCodeDir } from '@centraid/runtime-core';
import { loadSettings } from './settings.js';

export const PREVIEW_SCHEME = 'centraid-preview';

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function registerPreviewProtocol(): void {
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    const url = new URL(request.url);
    const id = url.hostname;
    if (!PROJECT_ID_RE.test(id)) {
      return new Response('Bad project id', { status: 400 });
    }

    // Default to index.html when the path is empty or "/".
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html';

    const settings = await loadSettings();
    // `readActiveCodeDir` reads `<appsDir>/<id>/current.json` and returns
    // `<appsDir>/<id>/versions/<activeVersion>/`. Before the first publish
    // this falls back to the flat dir, which doesn't exist post-#108 — so
    // the file stat below will 404 cleanly.
    const projectRoot = path.resolve(await readActiveCodeDir(path.join(settings.appsDir, id)));
    const target = path.resolve(projectRoot, rel);

    // Path traversal guard — `target` must be inside `projectRoot`.
    if (target !== projectRoot && !target.startsWith(projectRoot + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        // Serve <dir>/index.html for directory requests (matches what a
        // typical static host would do).
        const indexPath = path.join(target, 'index.html');
        if (await fileExists(indexPath)) {
          return net.fetch(pathToFileURL(indexPath).toString());
        }
        return new Response('Not found', { status: 404 });
      }
    } catch {
      return new Response('Not found', { status: 404 });
    }

    // Hand off to Electron's net module to stream the file with the right
    // MIME inferred from the extension. Faster + simpler than reading into
    // a Buffer ourselves, and lets large assets (images, etc.) stream.
    return net.fetch(pathToFileURL(target).toString());
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}
