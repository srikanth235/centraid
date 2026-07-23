// Type-resolution bridge for the app engine's shared-root fallback. At runtime
// an app-relative `./kit.ts` request is served from `kit/kit.ts`; `rootDirs` in
// tsconfig.apps.json mirrors that layout for TypeScript with this real module,
// so the implementation remains the only API declaration source.
export * from '../../kit/kit.ts';
