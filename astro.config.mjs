import { defineConfig } from 'astro/config';

const base = process.env.DOCS_SITE_BASE_PATH || '/';
const site = process.env.DOCS_SITE_CANONICAL_ORIGIN || 'https://centraid.dev/docs/';

export default defineConfig({
  base,
  build: {
    assets: '_astro',
    format: 'directory',
  },
  outDir: './dist/docs-site',
  publicDir: './scripts/docs-site/public',
  site: site.endsWith('/') ? site : `${site}/`,
  srcDir: './scripts/docs-site/src',
  trailingSlash: 'always',
});
