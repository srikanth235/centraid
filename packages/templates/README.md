# @centraid/templates

Bundled, pre-built Centraid apps that the desktop gallery offers as **clone and deploy** starting points. Each template under `templates/<id>/` is a fully-formed app — identical in shape to an app a user authors themselves (`index.html`, `app.css`, `app.js`, `queries/`, `actions/`, `migrations/`, `app.json`).

## Layout

```
packages/templates/
  src/
    index.ts        — listTemplates(), templatesDir, types
    types.ts        — TemplateMeta, TemplateManifest
  templates/
    index.json      — manifest (TemplateManifest)
    <id>/           — one folder per template, shaped like a centraid app
```

## Adding a template

1. Drop the app folder under `templates/<id>/` with the standard layout (`index.html`, `app.css`, `app.js`, `queries/`, `actions/`, `migrations/`, `package.json`, `tsconfig.json`, `app.json`).
2. **Pre-build the handlers**: commit the compiled `.js` files alongside `.ts` so cloning is "click and deploy" — no `bun install` needed on first use.
3. Add an entry to `templates/index.json` with `id`, `name`, `desc`, `colorKey`, `iconKey`, `version`.

The `version` field follows semver. Bump it when the template's source changes.

## Cloning at runtime

The desktop main process imports `listTemplates()` to render the gallery, then calls `cloneTemplate()` from `@centraid/agent-harness` to copy a template into the user's projects dir under a new id. The existing publish pipeline takes over from there.
