import "../../../packages/client/src/centraid-api.js";
import "../../../packages/client/src/types.js";
import "../../../packages/client/src/react/css-modules.js";

declare global {
  /** Injected by vite.config.ts from package.json (#468). */
  const __APP_VERSION__: string;

  /**
   * `@centraid/design/fonts`' `toFontFaceCss('/fonts')` output, inlined at
   * build time by vite.config.ts's `centraid-fonts` plugin (#707).
   * The design package is Node-only, so this string — not the module — is
   * what crosses into the browser bundle.
   */
  const __CENTRAID_FONT_FACE_CSS__: string;

  interface ImportMetaEnv {
    readonly PROD: boolean;
    /**
     * The seat store's build-time lever (#996, wave 2). `"1"` makes a build
     * default to the new store; anything else leaves it off, which is what a
     * shipped build is. The e2e lane sets it so a whole run exercises the
     * flag ON.
     */
    readonly VITE_CENTRAID_SEAT_STORE?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

// oxlint-disable-next-line unicorn/require-module-specifiers -- (#468) ambient module marker for __APP_VERSION__
export {};
