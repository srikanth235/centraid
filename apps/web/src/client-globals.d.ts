import '../../../packages/client/src/centraid-api.js';
import '../../../packages/client/src/types.js';
import '../../../packages/client/src/react/css-modules.js';

declare global {
  /** Injected by vite.config.ts from package.json (issue #468 K9). */
  const __APP_VERSION__: string;

  interface ImportMetaEnv {
    readonly PROD: boolean;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

// eslint-disable-next-line unicorn/require-module-specifiers -- (#468) ambient module marker for __APP_VERSION__
export {};
