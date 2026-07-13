import '../../../packages/client/src/centraid-api.js';
import '../../../packages/client/src/types.js';
import '../../../packages/client/src/react/css-modules.js';

declare global {
  interface ImportMetaEnv {
    readonly PROD: boolean;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
