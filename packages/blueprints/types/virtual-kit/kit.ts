// Type-resolution bridge for the app engine's shared-root fallback. At runtime
// an app-relative `./kit.ts` request is served from the design package's kit
// layer (`@centraid/design/kit`); `rootDirs` in tsconfig.apps.json mirrors that
// layout for TypeScript with this real module, so the implementation remains
// the only API declaration source.
export * from "../../../design/kit/kit.ts";
