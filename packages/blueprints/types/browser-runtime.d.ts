// Ambient types for build-tool resource imports. Every shared module the apps
// reach for is real TypeScript that owns its own contract — a sibling under
// `apps/_shared/`, or a package subpath — so a `declare module` here is only
// ever for a specifier the BUNDLER synthesizes, never for one of ours.

declare module "*?url" {
  const url: string;
  export default url;
}
